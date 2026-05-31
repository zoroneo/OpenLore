#!/usr/bin/env node
/**
 * E2E reproduction harness for Spec 13.1 (watch-mode performance).
 *
 * Reproduces the FIELD config exactly: spawn the built `openlore mcp` server
 * with NO flags (so --watch-auto defaults on and arms on the first tool call),
 * against a real analyzed repo with a multi-MB llm-context.json. Then:
 *   1. initialize handshake + first tool call (arms the watcher on `directory`)
 *   2. measure baseline tool-call round-trip latency (server idle)
 *   3. fire a burst of N source-file saves (active-editing / VCS-flood storm)
 *   4. immediately issue more tool calls and measure their latency DURING the
 *      post-burst re-index window — this is the "batched result-delivery
 *      latency" the field reported
 *   5. count watcher stderr lines emitted across the whole run
 *   6. confirm freshness: a just-saved symbol is visible to search_code
 *
 * Pass/fail (the regression signature): if the watcher re-index is O(repo) per
 * save and storms on bursts, the post-burst tool calls block for seconds and
 * stderr floods. With Spec 13.1, post-burst latency stays close to baseline and
 * stderr is ~1 line per batch.
 *
 * Usage: node scripts/e2e-watch-latency.mjs <repoDir> <distCliPath>
 *   repoDir     — a temp copy of a repo containing src/ + .openlore/analysis/
 *   distCliPath — path to the built dist/cli/index.js to run as the MCP server
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const repoDir = process.argv[2];
const distCli = process.argv[3];
if (!repoDir || !distCli) {
  process.stderr.write('usage: e2e-watch-latency.mjs <repoDir> <distCliPath>\n');
  process.exit(2);
}

const BURST = 30;          // files touched in the storm
const BASELINE_CALLS = 5;
const POSTBURST_CALLS = 8;

// ── Spawn the built server, FIELD CONFIG: no flags ──────────────────────────
const child = spawn('node', [distCli, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });

let stderrLines = 0;
const stderrSample = [];
createInterface({ input: child.stderr }).on('line', (l) => {
  if (!l.trim()) return;
  stderrLines++;
  if (stderrSample.length < 40) stderrSample.push(l);
});

const rl = createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});
function rpc(method, params) {
  const id = nextId++;
  const t0 = performance.now();
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve) => {
    pending.set(id, { resolve: (m) => resolve({ ms: performance.now() - t0, msg: m }) });
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const max = (xs) => xs.reduce((a, b) => Math.max(a, b), 0);

async function callTool(name, args) {
  const { ms, msg } = await rpc('tools/call', { name, arguments: args });
  return { ms, ok: !msg.error, err: msg.error?.message };
}

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-harness', version: '1.0.0' } });
  notify('notifications/initialized', {});

  // First tool call carries `directory` → arms --watch-auto on repoDir.
  const armed = await callTool('orient', { directory: repoDir, task: 'understand the watcher' });
  if (!armed.ok) throw new Error('orient failed: ' + armed.err);

  // Give the watcher a moment to finish chokidar 'ready' (it walks the tree).
  await new Promise((r) => setTimeout(r, 1500));

  // Pick real source files to perturb.
  const srcDir = join(repoDir, 'src', 'core', 'analyzer');
  const candidates = (await readdir(srcDir)).filter((f) => f.endsWith('.ts') && !f.includes('.test.')).slice(0, BURST);

  // ── Baseline: tool-call latency with the server idle ──────────────────────
  const baseline = [];
  for (let i = 0; i < BASELINE_CALLS; i++) {
    const r = await callTool('search_code', { directory: repoDir, query: 'vector index build' });
    if (!r.ok) throw new Error('search_code failed: ' + r.err);
    baseline.push(r.ms);
  }

  // ── Storm: fire a burst of saves (touch each file's bytes) ─────────────────
  const burstStart = performance.now();
  for (const f of candidates) {
    const p = join(srcDir, f);
    const content = await readFile(p, 'utf-8');
    // Append a harmless comment line to change content (and re-extract sigs).
    await writeFile(p, content + `\n// e2e-touch ${Date.now()}\n`, 'utf-8');
  }
  const burstWrite = performance.now() - burstStart;

  // ── Post-burst: issue tool calls DURING the re-index window ────────────────
  // These are what blocked for seconds in the field. Measure each.
  const postburst = [];
  for (let i = 0; i < POSTBURST_CALLS; i++) {
    const r = await callTool('search_code', { directory: repoDir, query: 'incremental update' });
    postburst.push(r.ms);
  }

  // ── Freshness: add a uniquely-named symbol, confirm search sees it ─────────
  const freshFile = join(srcDir, candidates[0]);
  const marker = `uniqueE2eSymbol_${Date.now()}`;
  const fc = await readFile(freshFile, 'utf-8');
  await writeFile(freshFile, fc + `\nexport function ${marker}() { return 1; }\n`, 'utf-8');
  // Wait past the debounce (400ms) + flush.
  await new Promise((r) => setTimeout(r, 1200));
  const fresh = await callTool('search_code', { directory: repoDir, query: marker });

  const report = {
    burstFiles: candidates.length,
    burstWriteMs: Math.round(burstWrite),
    baseline_medianMs: Math.round(median(baseline)),
    baseline_maxMs: Math.round(max(baseline)),
    postburst_medianMs: Math.round(median(postburst)),
    postburst_maxMs: Math.round(max(postburst)),
    latencyInflation: +(median(postburst) / Math.max(median(baseline), 1)).toFixed(2),
    stderrLines,
    freshnessOk: fresh.ok,
    stderrSample,
  };
  process.stdout.write('E2E_RESULT ' + JSON.stringify(report) + '\n');
} catch (err) {
  process.stdout.write('E2E_ERROR ' + JSON.stringify({ message: String(err?.message ?? err) }) + '\n');
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 1000);
}
