import Parser from 'tree-sitter';
import TS from 'tree-sitter-typescript';
import { buildFunctionCfg, isStructurallyValid } from './src/core/analyzer/cfg.js';

function find(n: any, t: string[]): any {
  if (t.includes(n.type)) return n;
  for (const c of n.namedChildren) { const r = find(c, t); if (r) return r; }
}
const tp = new Parser(); tp.setLanguage((TS as any).typescript);
const TS_FN = ['function_declaration'];

function nestedLoops(n: number): string {
  let s = 'function f(){ let acc=0;\n';
  for (let i = 0; i < n; i++) s += `for (let i${i}=0;i${i}<10;i${i}++){\n`;
  s += 'acc += 1;\n';
  for (let i = n - 1; i >= 0; i--) s += '}\n';
  s += ' return acc; }';
  return s;
}

function time(n: number): { ms: number; status: string; blocks: number; edges: number } {
  const fn = find(tp.parse(nestedLoops(n)).rootNode, TS_FN);
  const t0 = Date.now();
  let cfg: any, status = 'ok', threw = '';
  try { cfg = buildFunctionCfg(fn, 'TypeScript'); }
  catch (e: any) { status = 'THREW'; threw = (e?.stack ?? String(e)).split('\n').slice(0, 3).join(' | '); }
  const ms = Date.now() - t0;
  if (status === 'THREW') { console.log(`  n=${n}: THREW after ${ms}ms :: ${threw}`); return { ms, status, blocks: 0, edges: 0 }; }
  if (cfg && !isStructurallyValid(cfg)) status = 'INVALID';
  return { ms, status: cfg ? status : 'undefined', blocks: cfg ? cfg.blocks.length : 0, edges: cfg ? cfg.defUse.length : 0 };
}

console.log('=== Nested-loop scaling (quadratic fixpoint suspect) ===');
console.log('  n   blocks   ms    status');
for (const n of [100, 150, 200, 250, 300, 350, 400, 500, 700, 1000]) {
  const r = time(n);
  console.log(`${String(n).padStart(5)} ${String(r.blocks).padStart(7)} ${String(r.ms).padStart(7)}  ${r.status}`);
  if (r.ms > 30000 || r.status === 'THREW') { console.log('  (stopping: exceeded 30s or threw)'); break; }
}

// Stack-overflow probe: deeply nested if generates deep RECURSION in processSeq/processStmt.
console.log('\n=== Stack-depth probe (deep nested if -> recursion) ===');
function deepIf(n: number): string {
  let s = 'function f(x){\n';
  for (let i = 0; i < n; i++) s += `if(x>${i}){`;
  s += 'let y=x;';
  s += '}'.repeat(n);
  s += 'return x;}';
  return s;
}
for (const n of [1000, 2000, 4000, 8000]) {
  const fn = find(tp.parse(deepIf(n)).rootNode, TS_FN);
  if (!fn) { console.log(`  n=${n}: no-fn (parser gave up)`); continue; }
  const t0 = Date.now();
  let status = 'ok', threw = '';
  try { const cfg = buildFunctionCfg(fn, 'TypeScript'); status = cfg ? (isStructurallyValid(cfg) ? 'ok' : 'INVALID') : 'undefined'; }
  catch (e: any) { status = 'THREW'; threw = String(e?.message ?? e); }
  console.log(`  deep-if n=${n}: ${status} ${Date.now() - t0}ms ${threw ? ':: ' + threw : ''}`);
}
