import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import { buildFunctionCfg, cfgSupportsLanguage, isStructurallyValid, type CfgNode, type FunctionCfg } from './cfg.js';

// ─── parsing helpers ─────────────────────────────────────────────────────────

function parse(content: string, lang: object): Parser.Tree {
  const p = new Parser();
  p.setLanguage(lang as unknown as Parser.Language);
  return p.parse(content);
}

function firstOfType(node: Parser.SyntaxNode, types: string[]): Parser.SyntaxNode | undefined {
  if (types.includes(node.type)) return node;
  for (const c of node.namedChildren) {
    const found = firstOfType(c, types);
    if (found) return found;
  }
  return undefined;
}

async function tsLang(): Promise<object> {
  const m = await import('tree-sitter-typescript');
  return (m.default as { typescript: object }).typescript;
}
async function pyLang(): Promise<object> {
  const m = await import('tree-sitter-python');
  return m.default as object;
}
async function goLang(): Promise<object> {
  const m = await import('tree-sitter-go');
  return m.default as object;
}

function cfgFor(content: string, lang: object, language: string, fnTypes: string[]): FunctionCfg {
  const tree = parse(content, lang);
  const fn = firstOfType(tree.rootNode, fnTypes);
  expect(fn, 'function node not found').toBeTruthy();
  const cfg = buildFunctionCfg(fn as unknown as CfgNode, language);
  expect(cfg, 'cfg should be produced').toBeTruthy();
  return cfg!;
}

const TS_FN = ['function_declaration', 'method_definition', 'arrow_function'];
const PY_FN = ['function_definition'];
const GO_FN = ['function_declaration', 'method_declaration'];

function hasDefUse(cfg: FunctionCfg, variable: string, predicate?: (e: { defLine: number; useLine: number; precision: string }) => boolean): boolean {
  return cfg.defUse.some(e => e.variable === variable && (!predicate || predicate(e)));
}

// ─── CFG control-flow scenarios ──────────────────────────────────────────────

describe('CFG control flow', () => {
  it('Branch produces divergent and join blocks', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(
      `function f(a: number) { let x = 0; if (a > 0) { x = 1; } else { x = 2; } return x; }`,
      lang, 'TypeScript', TS_FN,
    );
    // A branch block with both a true and false outgoing edge.
    const branch = cfg.blocks.find(b => b.kind === 'branch');
    expect(branch).toBeTruthy();
    const out = cfg.edges.filter(e => e.from === branch!.id);
    expect(out.some(e => e.kind === 'true')).toBe(true);
    expect(out.some(e => e.kind === 'false')).toBe(true);
    // A merge block both arms reach (in-degree ≥ 2).
    const indeg = new Map<number, number>();
    for (const e of cfg.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const merge = cfg.blocks.find(b => b.kind === 'merge' && (indeg.get(b.id) ?? 0) >= 2);
    expect(merge).toBeTruthy();
  });

  it('Loop produces a back edge', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(
      `function f(n: number) { let i = 0; while (i < n) { i = i + 1; } return i; }`,
      lang, 'TypeScript', TS_FN,
    );
    const back = cfg.edges.find(e => e.kind === 'back');
    expect(back).toBeTruthy();
    // The back edge targets a loop block.
    const target = cfg.blocks.find(b => b.id === back!.to);
    expect(target?.kind).toBe('loop');
  });

  it('Early return terminates a path', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(
      `function f(a: number) { if (a < 0) { return -1; } const y = a * 2; return y; }`,
      lang, 'TypeScript', TS_FN,
    );
    // Some block has an 'exit' edge (the early return); that block must not also
    // flow into the post-conditional merge.
    const exitEdges = cfg.edges.filter(e => e.kind === 'exit');
    expect(exitEdges.length).toBeGreaterThanOrEqual(1);
    for (const ee of exitEdges) {
      const others = cfg.edges.filter(e => e.from === ee.from && e.kind !== 'exit');
      expect(others.length).toBe(0);
    }
  });

  it('CFG is deterministic across runs', async () => {
    const lang = await tsLang();
    const src = `function f(a: number) { let x = 0; if (a) { x = 1; } else { x = 2; } for (let i = 0; i < a; i++) { x += i; } return x; }`;
    const a = cfgFor(src, lang, 'TypeScript', TS_FN);
    const b = cfgFor(src, lang, 'TypeScript', TS_FN);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('Unsupported language fails soft', async () => {
    const lang = await tsLang();
    const tree = parse(`function f() {}`, lang);
    const fn = firstOfType(tree.rootNode, TS_FN)!;
    expect(cfgSupportsLanguage('Rust')).toBe(false);
    expect(buildFunctionCfg(fn as unknown as CfgNode, 'Rust')).toBeUndefined();
  });
});

// ─── reaching-definitions scenarios ──────────────────────────────────────────

describe('reaching definitions (def-use)', () => {
  it('Local scalar def reaches its use', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(
      `function f() { const x = compute(); return x + 1; }`,
      lang, 'TypeScript', TS_FN,
    );
    expect(hasDefUse(cfg, 'x', e => e.precision === 'exact')).toBe(true);
  });

  it('Reassignment kills the earlier definition', async () => {
    const lang = await tsLang();
    const src = `function f() {\n  let x = a();\n  x = b();\n  return x;\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    // return x is on line 4; x = b() on line 3; x = a() on line 2.
    const toReturn = cfg.defUse.filter(e => e.variable === 'x' && e.useLine === 4);
    expect(toReturn.length).toBeGreaterThanOrEqual(1);
    expect(toReturn.every(e => e.defLine === 3)).toBe(true);
    expect(toReturn.some(e => e.defLine === 2)).toBe(false);
  });

  it('Both branches of a definition reach a later use', async () => {
    const lang = await tsLang();
    const src = `function f(c: boolean) {\n  let x;\n  if (c) {\n    x = 1;\n  } else {\n    x = 2;\n  }\n  return x;\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    const toReturn = cfg.defUse.filter(e => e.variable === 'x' && e.useLine === 8);
    const defLines = new Set(toReturn.map(e => e.defLine));
    expect(defLines.has(4)).toBe(true); // then arm
    expect(defLines.has(6)).toBe(true); // else arm
  });

  it('Field write is conservatively over-approximated (may)', async () => {
    const lang = await tsLang();
    const src = `function f(obj: any) {\n  obj.field = compute();\n  return obj.field;\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    const fieldEdge = cfg.defUse.find(e => e.variable === 'obj.field');
    expect(fieldEdge).toBeTruthy();
    expect(fieldEdge!.precision).toBe('may');
  });

  it('Exact and may dependences are distinguishable in one function', async () => {
    const lang = await tsLang();
    const src = `function f(obj: any) {\n  const y = 1;\n  obj.f = 2;\n  return y + obj.f;\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    expect(hasDefUse(cfg, 'y', e => e.precision === 'exact')).toBe(true);
    expect(hasDefUse(cfg, 'obj.f', e => e.precision === 'may')).toBe(true);
  });
});

// ─── exception / multi-way control flow (alternative paths must not kill) ─────

describe('try/catch and switch (alternative-path soundness)', () => {
  it('try and catch defs both reach a later use (no spurious kill)', async () => {
    const lang = await tsLang();
    const src = `function f(a:number){\n  let x = 0;\n  try {\n    x = risky(a);\n  } catch (e) {\n    x = -1;\n  }\n  return x;\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    expect(cfg.blocks.some(b => b.kind === 'branch')).toBe(true);
    const defLines = new Set(cfg.defUse.filter(e => e.variable === 'x' && e.useLine === 8).map(e => e.defLine));
    expect(defLines.has(4)).toBe(true); // try body value reaches the return
    expect(defLines.has(6)).toBe(true); // catch body value reaches the return
  });

  it('switch case and default defs both reach a later use', async () => {
    const lang = await tsLang();
    const src = `function f(a:number){\n  let x = 0;\n  switch (a) {\n    case 1: x = 10; break;\n    default: x = 20;\n  }\n  return x;\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    expect(cfg.blocks.some(b => b.kind === 'branch')).toBe(true);
    const defLines = new Set(cfg.defUse.filter(e => e.variable === 'x' && e.useLine === 7).map(e => e.defLine));
    expect(defLines.has(4)).toBe(true); // case 1
    expect(defLines.has(5)).toBe(true); // default
  });
});

// ─── closures: captured outer variables are `may`, nested scope does not leak ──

describe('closure captures are conservative (may)', () => {
  it('a variable captured by a nested arrow is a may dependence', async () => {
    const lang = await tsLang();
    const src = `function f(a:number){\n  const base = a + 1;\n  const fn = (y:number) => base + y;\n  return fn(2);\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    const cap = cfg.defUse.find(e => e.variable === 'base' && e.useLine === 3);
    expect(cap?.precision).toBe('may');
  });

  it('a callback captures the outer var as may and does not leak its own param', async () => {
    const lang = await tsLang();
    const src = `function f(items:number[]){\n  const k = 3;\n  return items.map(x => x * k);\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    expect(cfg.defUse.find(e => e.variable === 'k')?.precision).toBe('may');
    // The arrow's own parameter `x` is bound in the nested scope — no outer edge.
    expect(cfg.defUse.some(e => e.variable === 'x')).toBe(false);
  });
});

// ─── elif chains and destructuring (no dropped branches / defs) ───────────────

describe('elif chains and destructuring', () => {
  it('Python if/elif/else: all three branch defs reach a later use', async () => {
    const lang = await pyLang();
    const src = `def f(a):\n    x = 0\n    if a == 1:\n        x = 10\n    elif a == 2:\n        x = 20\n    else:\n        x = 30\n    return x`;
    const cfg = cfgFor(src, lang, 'Python', PY_FN);
    const defLines = new Set(cfg.defUse.filter(e => e.variable === 'x' && e.useLine === 9).map(e => e.defLine));
    expect(defLines.has(4)).toBe(true); // if
    expect(defLines.has(6)).toBe(true); // elif
    expect(defLines.has(8)).toBe(true); // else
  });

  it('object destructuring binds each name as a definition', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(obj:any){\n  const { a, b } = obj;\n  return a + b;\n}`, lang, 'TypeScript', TS_FN);
    expect(hasDefUse(cfg, 'a')).toBe(true);
    expect(hasDefUse(cfg, 'b')).toBe(true);
  });

  it('array destructuring binds each element as a definition', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(arr:number[]){\n  const [x, y] = arr;\n  return x + y;\n}`, lang, 'TypeScript', TS_FN);
    expect(hasDefUse(cfg, 'x')).toBe(true);
    expect(hasDefUse(cfg, 'y')).toBe(true);
  });
});

// ─── structural-validity safety net ───────────────────────────────────────────

describe('structural validity guard', () => {
  it('rejects a malformed overlay (dangling edge / missing entry)', () => {
    expect(isStructurallyValid({
      blocks: [{ id: 0, kind: 'entry' }, { id: 1, kind: 'exit' }],
      edges: [{ from: 0, to: 99, kind: 'normal' }], // dangling endpoint
      defUse: [], params: [], paramLine: 1,
    })).toBe(false);
    expect(isStructurallyValid({
      blocks: [{ id: 0, kind: 'normal' }, { id: 1, kind: 'exit' }], // no entry
      edges: [], defUse: [], params: [], paramLine: 1,
    })).toBe(false);
    expect(isStructurallyValid({
      blocks: [{ id: 0, kind: 'entry' }, { id: 1, kind: 'exit' }],
      edges: [], defUse: [{ variable: 'x', defLine: 0, useLine: 2, precision: 'exact' }], // bad line
      params: [], paramLine: 1,
    })).toBe(false);
  });

  it('every overlay built from a real parse satisfies the invariants', async () => {
    const samples: Array<[object, string, string[]]> = [
      [await tsLang(), 'TypeScript', TS_FN],
      [await pyLang(), 'Python', PY_FN],
      [await goLang(), 'Go', GO_FN],
    ];
    const srcs: Record<string, string> = {
      TypeScript: `function f(a:number){ let x=0; try{ x=g(a); }catch(e){ x=-1; } switch(x){case 1: return 1; default: return x;} }`,
      Python: `def f(a):\n    x = 0\n    if a == 1:\n        x = 10\n    elif a == 2:\n        x = 20\n    for i in range(a):\n        x += i\n    return x`,
      Go: `func f(a int) int {\n\tx := 0\n\tfor i := 0; i < a; i++ { x = x + i }\n\tswitch a { case 1: return 1; default: return x }\n}`,
    };
    for (const [lang, name, fnTypes] of samples) {
      const cfg = cfgFor(srcs[name], lang, name, fnTypes);
      expect(isStructurallyValid(cfg), `${name} overlay invariants`).toBe(true);
    }
  });
});

// ─── escape analysis: no unsound `exact` for mutated-via-alias variables ──────

describe('escaped variables are downgraded to may (sound exact)', () => {
  it('a local mutated inside a closure is may, not exact', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(){\n  let x = 1;\n  const g = () => { x = 2; };\n  g();\n  return x;\n}`, lang, 'TypeScript', TS_FN);
    const e = cfg.defUse.find(d => d.variable === 'x' && d.useLine === 5);
    expect(e?.precision).toBe('may'); // the closure may have reassigned x
  });

  it('a Go local whose address is taken is may, not exact', async () => {
    const lang = await goLang();
    const cfg = cfgFor(`func f() int {\n\tx := 1\n\tp := &x\n\t*p = 2\n\treturn x\n}`, lang, 'Go', GO_FN);
    const e = cfg.defUse.find(d => d.variable === 'x' && d.useLine === 5);
    expect(e?.precision).toBe('may'); // a pointer can mutate x out of band
  });

  it('a read-only closure capture does not over-downgrade the outer var', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(){\n  let z = 1;\n  const g = () => z + 1;\n  return z;\n}`, lang, 'TypeScript', TS_FN);
    const e = cfg.defUse.find(d => d.variable === 'z' && d.useLine === 4);
    expect(e?.precision).toBe('exact'); // g only reads z; z is not mutated
  });
});

// ─── per-language coverage ───────────────────────────────────────────────────

describe('multi-language CFG', () => {
  it('Python branch + def-use', async () => {
    const lang = await pyLang();
    const src = `def f(a):\n    x = compute()\n    if a:\n        x = other()\n    return x`;
    const cfg = cfgFor(src, lang, 'Python', PY_FN);
    expect(cfg.blocks.some(b => b.kind === 'branch')).toBe(true);
    expect(hasDefUse(cfg, 'x')).toBe(true);
    expect(cfg.params).toContain('a');
  });

  it('Go branch + loop + def-use', async () => {
    const lang = await goLang();
    const src = `func f(n int) int {\n\tx := 0\n\tfor i := 0; i < n; i++ {\n\t\tx = x + i\n\t}\n\treturn x\n}`;
    const cfg = cfgFor(src, lang, 'Go', GO_FN);
    expect(cfg.edges.some(e => e.kind === 'back')).toBe(true);
    expect(hasDefUse(cfg, 'x')).toBe(true);
    expect(cfg.params).toContain('n');
  });
});
