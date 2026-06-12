import Parser from 'tree-sitter';
import TS from 'tree-sitter-typescript';
import PY from 'tree-sitter-python';
import GO from 'tree-sitter-go';
import { buildFunctionCfg, isStructurallyValid } from './src/core/analyzer/cfg.js';

function find(n: any, t: string[]): any {
  if (t.includes(n.type)) return n;
  for (const c of n.namedChildren) { const r = find(c, t); if (r) return r; }
}

const tp = new Parser(); tp.setLanguage((TS as any).typescript);
const pp = new Parser(); pp.setLanguage((PY as any));
const gp = new Parser(); gp.setLanguage((GO as any));

const TS_FN = ['function_declaration', 'arrow_function', 'function_expression', 'method_definition', 'generator_function_declaration'];
const PY_FN = ['function_definition'];
const GO_FN = ['function_declaration', 'method_declaration'];

interface Result { name: string; lang: string; status: string; ms: number; edges: number; threw?: string; invalid?: boolean; }
const results: Result[] = [];

function run(name: string, src: string, parser: any, lang: string, fnTypes: string[]) {
  let fn: any;
  try {
    fn = find(parser.parse(src).rootNode, fnTypes);
  } catch (e: any) {
    results.push({ name, lang, status: 'PARSE-THREW', ms: 0, edges: 0, threw: String(e?.message ?? e) });
    return;
  }
  if (!fn) { results.push({ name, lang, status: 'no-fn', ms: 0, edges: 0 }); return; }
  const t0 = Date.now();
  let cfg: any;
  try {
    cfg = buildFunctionCfg(fn, lang);
  } catch (e: any) {
    const ms = Date.now() - t0;
    results.push({ name, lang, status: 'THREW', ms, edges: 0, threw: (e?.stack ?? String(e)).split('\n').slice(0, 4).join(' | ') });
    return;
  }
  const ms = Date.now() - t0;
  if (cfg) {
    let valid = false;
    try { valid = isStructurallyValid(cfg); } catch (e: any) {
      results.push({ name, lang, status: 'VALIDATE-THREW', ms, edges: cfg.defUse.length, threw: String(e?.message ?? e) });
      return;
    }
    if (!valid) { results.push({ name, lang, status: 'INVALID', ms, edges: cfg.defUse.length, invalid: true }); return; }
    results.push({ name, lang, status: 'ok', ms, edges: cfg.defUse.length });
  } else {
    results.push({ name, lang, status: 'undefined', ms, edges: 0 });
  }
}

// ---- 1. Syntax errors / truncated ----
run('truncated-let', 'function f(){ let x = ', tp, 'TypeScript', TS_FN);
run('unbalanced-braces', 'function f(){ if (a) { while(b) { ', tp, 'TypeScript', TS_FN);
run('abrupt-end', 'function f(x){ return x +', tp, 'TypeScript', TS_FN);
run('garbage-tokens', 'function f(){ @#$%^&*( ) [ } { ;;; }', tp, 'TypeScript', TS_FN);
run('py-truncated', 'def f():\n  x = ', pp, 'Python', PY_FN);
run('py-bad-indent', 'def f():\nx=1\n   y=2\n  z=3', pp, 'Python', PY_FN);
run('go-truncated', 'func f() {\n  x := ', gp, 'Go', GO_FN);
run('go-broken', 'func f( { return }', gp, 'Go', GO_FN);

// ---- 2. Empty / degenerate ----
run('empty-fn', 'function f(){}', tp, 'TypeScript', TS_FN);
run('only-comments', 'function f(){ /* a */ // b\n }', tp, 'TypeScript', TS_FN);
run('arrow-expr-body', 'const f = x => x*2;', tp, 'TypeScript', TS_FN);
run('arrow-no-body', 'const f = () => ;', tp, 'TypeScript', TS_FN);
run('async-fn', 'async function f(a){ await g(a); return a; }', tp, 'TypeScript', TS_FN);
run('generator-fn', 'function* f(a){ yield a; yield* b; }', tp, 'TypeScript', TS_FN);
run('all-decls', 'function f(){ let a=1; const b=2; var c=3; let d=4; }', tp, 'TypeScript', TS_FN);
run('py-empty', 'def f():\n  pass', pp, 'Python', PY_FN);
run('py-docstring-only', 'def f():\n  """doc"""', pp, 'Python', PY_FN);
run('go-empty', 'func f(){}', gp, 'Go', GO_FN);

// ---- 3. Deeply nested (performance) ----
function nestedIf(n: number): string {
  let s = 'function f(x){\n';
  for (let i = 0; i < n; i++) s += '  '.repeat(i + 1) + `if (x > ${i}) {\n`;
  s += '  '.repeat(n + 1) + 'let y = x;\n';
  for (let i = n - 1; i >= 0; i--) s += '  '.repeat(i + 1) + '}\n';
  s += '  return x;\n}';
  return s;
}
run('nested-if-100', nestedIf(100), tp, 'TypeScript', TS_FN);
run('nested-if-300', nestedIf(300), tp, 'TypeScript', TS_FN);
run('nested-if-500', nestedIf(500), tp, 'TypeScript', TS_FN);
run('nested-if-800', nestedIf(800), tp, 'TypeScript', TS_FN);

function nestedBlocks(n: number): string {
  return 'function f(){\n' + '{'.repeat(n) + ' let x = 1; ' + '}'.repeat(n) + '\n}';
}
run('nested-blocks-1000', nestedBlocks(1000), tp, 'TypeScript', TS_FN);
run('nested-blocks-3000', nestedBlocks(3000), tp, 'TypeScript', TS_FN);

function nestedTernary(n: number): string {
  let s = 'function f(a){ return ';
  for (let i = 0; i < n; i++) s += `a==${i} ? ${i} : `;
  s += '0' + ';'.repeat(0) + '; }';
  return s;
}
run('nested-ternary-200', nestedTernary(200), tp, 'TypeScript', TS_FN);
run('nested-ternary-500', nestedTernary(500), tp, 'TypeScript', TS_FN);

// ---- 4. Large sequential ----
function seqStmts(n: number): string {
  let s = 'function f(){\n let x=0;\n';
  for (let i = 0; i < n; i++) s += ` x = x + ${i};\n`;
  s += ' return x;\n}';
  return s;
}
run('seq-2000', seqStmts(2000), tp, 'TypeScript', TS_FN);
run('seq-5000', seqStmts(5000), tp, 'TypeScript', TS_FN);

// ---- 5. Giant switch / wide CFG ----
function bigSwitch(n: number): string {
  let s = 'function f(x){ switch(x){\n';
  for (let i = 0; i < n; i++) s += ` case ${i}: { let y${i}=${i}; break; }\n`;
  s += ' default: return 0;\n} }';
  return s;
}
run('switch-200', bigSwitch(200), tp, 'TypeScript', TS_FN);
run('switch-1000', bigSwitch(1000), tp, 'TypeScript', TS_FN);

// switch with fall-through (no breaks) -> stresses fall-through edges + reaching defs
function bigSwitchFall(n: number): string {
  let s = 'function f(x){ switch(x){\n';
  for (let i = 0; i < n; i++) s += ` case ${i}: y=${i};\n`;
  s += ' default: y=0;\n} return y; }';
  return s;
}
run('switch-fallthrough-500', bigSwitchFall(500), tp, 'TypeScript', TS_FN);
run('switch-fallthrough-1000', bigSwitchFall(1000), tp, 'TypeScript', TS_FN);

// ---- 6. Pathological data flow ----
function manyReassign(n: number): string {
  let s = 'function f(){ let x=0;\n';
  for (let i = 0; i < n; i++) s += ` x = x + 1;\n`;
  s += ' return x; }';
  return s;
}
run('reassign-1000', manyReassign(1000), tp, 'TypeScript', TS_FN);
run('reassign-3000', manyReassign(3000), tp, 'TypeScript', TS_FN);

function mutualAssign(n: number): string {
  let s = 'function f(){ let a=1; let b=2;\n';
  for (let i = 0; i < n; i++) s += ` a=b; b=a;\n`;
  s += ' return a+b; }';
  return s;
}
run('mutual-1000', mutualAssign(1000), tp, 'TypeScript', TS_FN);

// loop with many vars, all read at the end -> stresses reaching-defs fixpoint
function loopManyVars(n: number): string {
  let s = 'function f(){ let acc=0;\n';
  for (let i = 0; i < n; i++) s += ` let v${i}=${i};\n`;
  s += ' for (let i=0;i<10;i++){\n';
  for (let i = 0; i < n; i++) s += `  acc += v${i};\n`;
  s += ' }\n return acc; }';
  return s;
}
run('loop-manyvars-200', loopManyVars(200), tp, 'TypeScript', TS_FN);
run('loop-manyvars-500', loopManyVars(500), tp, 'TypeScript', TS_FN);

// deeply nested loops -> back-edges multiply blocks; n*n fixpoint bound stress
function nestedLoops(n: number): string {
  let s = 'function f(){ let acc=0;\n';
  for (let i = 0; i < n; i++) s += '  '.repeat(i + 1) + `for (let i${i}=0;i${i}<10;i${i}++){\n`;
  s += '  '.repeat(n + 1) + 'acc += 1;\n';
  for (let i = n - 1; i >= 0; i--) s += '  '.repeat(i + 1) + '}\n';
  s += ' return acc; }';
  return s;
}
run('nested-loops-50', nestedLoops(50), tp, 'TypeScript', TS_FN);
run('nested-loops-150', nestedLoops(150), tp, 'TypeScript', TS_FN);
run('nested-loops-300', nestedLoops(300), tp, 'TypeScript', TS_FN);

// ---- 7. Weird identifiers ----
run('unicode-ident', 'function f(){ let éèê = 1; let 中文 = éèê; return 中文; }', tp, 'TypeScript', TS_FN);
run('emoji-ident-py', 'def f():\n  x = 1\n  return x', pp, 'Python', PY_FN);
run('dollar-names', 'function f($,$$,$_){ $ = $$ + $_; return $; }', tp, 'TypeScript', TS_FN);
run('very-long-name', `function f(){ let ${'a'.repeat(50000)} = 1; return ${'a'.repeat(50000)}; }`, tp, 'TypeScript', TS_FN);
run('keyword-ish', 'function f(){ let yield_ = 1; let async_ = yield_; return async_; }', tp, 'TypeScript', TS_FN);

// ---- 8. Minified / single-line ----
function minified(n: number): string {
  let s = 'function f(a){';
  for (let i = 0; i < n; i++) s += `var x${i}=a+${i};a=x${i};`;
  s += 'return a;}';
  return s;
}
run('minified-2000', minified(2000), tp, 'TypeScript', TS_FN);

// ---- 9. Mismatched grammar ----
const pyFn = find(pp.parse('def f(x):\n  y = x + 1\n  return y').rootNode, PY_FN);
if (pyFn) {
  const t0 = Date.now();
  try {
    const cfg = buildFunctionCfg(pyFn, 'TypeScript');
    const ms = Date.now() - t0;
    if (cfg && !isStructurallyValid(cfg)) results.push({ name: 'py-node-as-TS', lang: 'mismatch', status: 'INVALID', ms, edges: cfg.defUse.length, invalid: true });
    else results.push({ name: 'py-node-as-TS', lang: 'mismatch', status: cfg ? 'ok' : 'undefined', ms, edges: cfg ? cfg.defUse.length : 0 });
  } catch (e: any) {
    results.push({ name: 'py-node-as-TS', lang: 'mismatch', status: 'THREW', ms: Date.now() - t0, edges: 0, threw: String(e?.message ?? e) });
  }
}
const goFn = find(gp.parse('func f(x int) int {\n y := x + 1\n return y\n}').rootNode, GO_FN);
if (goFn) {
  try {
    const cfg = buildFunctionCfg(goFn, 'Python');
    results.push({ name: 'go-node-as-Py', lang: 'mismatch', status: cfg ? (isStructurallyValid(cfg) ? 'ok' : 'INVALID') : 'undefined', ms: 0, edges: cfg ? cfg.defUse.length : 0, invalid: cfg ? !isStructurallyValid(cfg) : false });
  } catch (e: any) {
    results.push({ name: 'go-node-as-Py', lang: 'mismatch', status: 'THREW', ms: 0, edges: 0, threw: String(e?.message ?? e) });
  }
}
run('unknown-language', 'function f(){}', tp, 'Rust', TS_FN);

// ---- 10. Misc edge cases ----
run('try-catch-finally', 'function f(){ try { a(); } catch(e) { b(e); } finally { c(); } }', tp, 'TypeScript', TS_FN);
run('labeled-loop', 'function f(){ outer: for(;;){ for(;;){ break outer; } } }', tp, 'TypeScript', TS_FN);
run('destructure', 'function f(){ const {a,b:{c}} = obj; const [x,,y] = arr; return a+c+x+y; }', tp, 'TypeScript', TS_FN);
run('walrus-py', 'def f():\n  while (n := next()) > 0:\n    print(n)', pp, 'Python', PY_FN);
run('deep-member', 'function f(){ return a.b.c.d.e.f.g.h.i.j.k; }', tp, 'TypeScript', TS_FN);
run('empty-switch', 'function f(x){ switch(x){} }', tp, 'TypeScript', TS_FN);
run('only-default', 'function f(x){ switch(x){ default: return 1; } }', tp, 'TypeScript', TS_FN);
run('closure-capture', 'function f(){ let x=1; const g=()=>x; return g(); }', tp, 'TypeScript', TS_FN);
run('deeply-nested-closures', `function f(){ let x=1; ${'(() => {'.repeat(100)} x; ${'})()'.repeat(100)}; return x; }`, tp, 'TypeScript', TS_FN);
run('huge-destructure', `function f(){ const {${Array.from({length:2000},(_,i)=>'k'+i).join(',')}} = o; return k0; }`, tp, 'TypeScript', TS_FN);
run('py-deep-elif', 'def f(x):\n' + Array.from({length:300},(_,i)=>`  ${i===0?'if':'elif'} x==${i}:\n    y=${i}`).join('\n') + '\n  else:\n    y=0\n  return y', pp, 'Python', PY_FN);

// ---- Report ----
console.log('\n=== RESULTS ===\n');
const problems = results.filter(r => ['THREW', 'PARSE-THREW', 'VALIDATE-THREW', 'INVALID'].includes(r.status) || r.ms > 1000);
for (const r of results) {
  const flag = ['THREW', 'PARSE-THREW', 'VALIDATE-THREW', 'INVALID'].includes(r.status) ? ' <<< PROBLEM' : (r.ms > 1000 ? ' <<< SLOW' : '');
  console.log(`${r.status.padEnd(10)} ${String(r.ms).padStart(6)}ms  ${String(r.edges).padStart(6)}e  [${r.lang}] ${r.name}${flag}`);
  if (r.threw) console.log(`            THREW: ${r.threw}`);
}
console.log('\n=== TIMING TABLE (nested/large inputs) ===\n');
const perf = results.filter(r => /nested|seq|switch|reassign|mutual|loop|minified|huge|deep/.test(r.name)).sort((a, b) => b.ms - a.ms);
for (const r of perf) console.log(`${String(r.ms).padStart(6)}ms  ${String(r.edges).padStart(7)}e  ${r.status.padEnd(10)} ${r.name}`);

console.log(`\n=== SUMMARY: ${results.length} cases, ${problems.length} problems (threw/invalid/slow) ===`);
if (problems.length === 0) console.log('ALL CASES FAILED-SOFT CORRECTLY (no throw, no hang >1s, no invalid overlay).');
else for (const p of problems) console.log(`  PROBLEM: ${p.name} -> ${p.status} (${p.ms}ms)${p.threw ? ' :: ' + p.threw : ''}`);
