/**
 * Ambiguity-aware reachability (change: harden-call-resolution-ambiguity).
 * Verifies that find_dead_code never reports a function as HIGH-confidence dead when
 * a potential caller was left unbound as an unresolved-ambiguous call site — the
 * caller may well be live via that call. Drives the real handler over an
 * llm-context fixture that carries `ambiguousSites`. Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../../constants.js';
import { handleFindDeadCode } from './reachability.js';
import type { FunctionNode, CallEdge, AmbiguousCallSite } from '../../analyzer/call-graph.js';

let root: string;

function node(id: string, name: string, extra: Partial<FunctionNode> = {}): FunctionNode {
  return {
    id, name, filePath: id.split('::')[0], isAsync: false, language: 'TypeScript',
    startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0, ...extra,
  };
}

async function writeContext(
  nodes: FunctionNode[],
  edges: CallEdge[],
  ambiguousSites?: AmbiguousCallSite[],
): Promise<void> {
  for (const n of nodes) { n.fanIn = 0; n.fanOut = 0; }
  for (const e of edges) {
    const c = nodes.find(n => n.id === e.callerId); if (c) c.fanOut++;
    const t = nodes.find(n => n.id === e.calleeId); if (t) t.fanIn++;
  }
  const callGraph = {
    nodes, edges, classes: [], inheritanceEdges: [],
    hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
    ...(ambiguousSites ? { ambiguousSites } : {}),
  };
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph }), 'utf-8');
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ol-reach-ambig-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('ambiguity-aware reachability', () => {
  it('a candidate named by an unresolved-ambiguous site is not high-confidence dead', async () => {
    // test → caller; caller has an ambiguous call whose candidates are handlerA/handlerB.
    // Neither handler has a resolved caller, so both are candidate-dead — but each is a
    // potential target of the unbound ambiguous call, so neither is HIGH-confidence dead.
    const nodes = [
      node('x.test.ts::test_x', 'test_x', { isTest: true }),
      node('a.ts::caller', 'caller'),
      node('a.ts::handlerA', 'handlerA'),
      node('b.ts::handlerB', 'handlerB'),
    ];
    const edges: CallEdge[] = [
      { callerId: 'x.test.ts::test_x', calleeId: 'a.ts::caller', calleeName: 'caller', confidence: 'import', kind: 'calls' },
    ];
    const ambiguousSites: AmbiguousCallSite[] = [
      { callerId: 'a.ts::caller', calleeName: 'handler', line: 2, strategy: 'name_only', candidateIds: ['a.ts::handlerA', 'b.ts::handlerB'], candidateCount: 2 },
    ];
    await writeContext(nodes, edges, ambiguousSites);
    const r = (await handleFindDeadCode({ directory: root })) as {
      candidateDead: Array<{ name: string; confidence: string; reason: string }>;
    };
    for (const name of ['handlerA', 'handlerB']) {
      const c = r.candidateDead.find(x => x.name === name);
      expect(c, `${name} is still a candidate`).toBeDefined();
      expect(c!.confidence, `${name} downgraded`).not.toBe('high');
      expect(c!.reason).toMatch(/unresolved-ambiguous call site/);
    }
  });

  it('without any ambiguous site, an uncalled non-exported symbol is still high-confidence dead', async () => {
    // Control: same shape, no ambiguousSites → the classic high-confidence dead verdict stands.
    const nodes = [
      node('x.test.ts::test_x', 'test_x', { isTest: true }),
      node('a.ts::caller', 'caller'),
      node('a.ts::orphan', 'orphan'),
    ];
    const edges: CallEdge[] = [
      { callerId: 'x.test.ts::test_x', calleeId: 'a.ts::caller', calleeName: 'caller', confidence: 'import', kind: 'calls' },
    ];
    await writeContext(nodes, edges);
    const r = (await handleFindDeadCode({ directory: root })) as {
      candidateDead: Array<{ name: string; confidence: string; reason: string }>;
    };
    const orphan = r.candidateDead.find(x => x.name === 'orphan');
    expect(orphan).toBeDefined();
    // No ambiguity → the ambiguous-site downgrade/reason is never applied.
    expect(orphan!.reason).not.toMatch(/unresolved-ambiguous call site/);
  });
});
