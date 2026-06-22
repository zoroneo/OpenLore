/**
 * Static `--estimate` arm for `openlore prove` (add-prove-shareable-scorecard,
 * decision 66feae62).
 *
 * Gives an API-key-less user a real, honest signal of the orientation tax their
 * repo carries — with NO agent and NO network. It is a deterministic, graph-
 * derived PROXY, never a measured agent run, and every renderer labels it as
 * such (ProveMode 'estimate').
 *
 * The model, stated plainly: the auto-derived orientation tasks (tasks.ts) ask
 * "where is X / who calls X / what does X call". A from-scratch agent answers
 * each by a search round-trip, then reads the distinct files the answers live in;
 * OpenLore returns the whole neighborhood in ONE `orient` call, after which the
 * agent opens at most a couple of files to confirm. So the tax is "N searches +
 * the distinct answer-bearing files" versus "one orient call + a small bounded
 * confirm". The conversions to tokens/cost use a few NAMED assumption constants —
 * documented proxies, not hidden tuning — so the estimate is reproducible and
 * inspectable.
 *
 * Scope (and what it deliberately does NOT model): this projects the
 * orientation-task tax from YOUR call graph. It cannot know whether the LLM has
 * already memorized your code (the reason a famous/small repo shows no win in the
 * measured arm) — only a real `openlore prove` pass measures that. The estimate
 * is therefore an honest lower-friction proxy for orientation effort, not a
 * substitute for measurement, and every renderer labels it 'estimate'.
 *
 * Pure + deterministic: same facts → same estimate. Unit-tested without a repo.
 */

import type { Cell } from './measure.js';
import type { GraphFact, ProveTask } from './tasks.js';

/**
 * Documented proxy constants behind the estimate. Exposed (and overridable) so
 * the assumptions are inspectable rather than buried magic numbers.
 */
export interface EstimateAssumptions {
  /** Approx fresh tokens an agent spends reading one source file. */
  avgFileTokens: number;
  /** Approx fresh tokens for one search/grep round-trip. */
  searchTokens: number;
  /** Approx fresh tokens an `orient` call injects. */
  orientTokens: number;
  /** USD per fresh token — a pricing proxy applied equally to both arms. */
  pricePerToken: number;
  /** Upper bound on answer-bearing files counted, so one mega-hub can't skew it. */
  maxAnswerFiles: number;
  /**
   * Files an agent opens to confirm AFTER an orient call already named them —
   * bounded and small, because orient's value is returning the neighborhood in
   * one call rather than per-task discovery. Counted symmetrically with the
   * WITHOUT arm's reads (both dedup across tasks) so the comparison is fair.
   */
  maxConfirmReads: number;
}

export const DEFAULT_ESTIMATE_ASSUMPTIONS: EstimateAssumptions = {
  avgFileTokens: 1500,
  searchTokens: 400,
  orientTokens: 600,
  pricePerToken: 3e-6, // ≈ $3 / 1M tokens, a round proxy
  maxAnswerFiles: 40,
  maxConfirmReads: 2,
};

/** Build a name → defining-file map. Ambiguous (shared) names collapse — fine for a proxy. */
function nameToFile(facts: GraphFact[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of facts) if (!m.has(f.name)) m.set(f.name, f.filePath);
  return m;
}

/**
 * The distinct files the derived tasks' answers live in — the surface a
 * from-scratch agent must traverse. `locate` answers carry the file path
 * directly (oracle includes it); `caller`/`callee` answers are names we resolve
 * to files via the graph. Names that don't resolve (external) are skipped.
 */
export function answerBearingFiles(facts: GraphFact[], tasks: ProveTask[]): Set<string> {
  const n2f = nameToFile(facts);
  const files = new Set<string>();
  for (const t of tasks) {
    for (const oracle of t.mustIncludeAny) {
      if (oracle.includes('/')) {
        files.add(oracle); // a file path (the locate oracle)
      } else {
        const file = n2f.get(oracle);
        if (file) files.add(file);
      }
    }
  }
  return files;
}

/**
 * Estimate the WITHOUT / WITH cells for the task set. Returns null when there
 * are no tasks (caller surfaces the "graph too sparse" guidance, as the measured
 * arm does).
 */
export function estimateCells(
  facts: GraphFact[],
  tasks: ProveTask[],
  a: EstimateAssumptions = DEFAULT_ESTIMATE_ASSUMPTIONS,
): { without: Cell; with: Cell } | null {
  if (tasks.length === 0) return null;

  const answerFiles = Math.min(answerBearingFiles(facts, tasks).size, a.maxAnswerFiles);
  const nTasks = tasks.length;

  // WITHOUT openlore: one search round-trip per task, then read every distinct
  // answer-bearing file to locate/confirm the structural fact.
  const withoutTurns = nTasks + answerFiles;
  const withoutFresh = nTasks * a.searchTokens + answerFiles * a.avgFileTokens;

  // WITH openlore: one orient call returns the whole neighbourhood (answering the
  // derived tasks structurally); the agent opens at most a small, bounded number
  // of files to confirm. Reads are deduped just like the WITHOUT arm, so neither
  // side is charged per-task for shared files.
  const confirmReads = Math.min(answerFiles, a.maxConfirmReads);
  const withTurns = 1 + confirmReads;
  const withFresh = a.orientTokens + confirmReads * a.avgFileTokens;

  const cell = (turns: number, fresh: number): Cell => ({
    costUsd: fresh * a.pricePerToken,
    freshInputTokens: fresh,
    cacheReadTokens: 0,
    numTurns: turns,
    durationMs: 0,
    // The estimate assumes both arms reach the answer; the tax is effort, not
    // accuracy — so correctness is held equal and the verdict turns on cost/turns.
    correctRate: 1,
    runs: 1,
  });

  return { without: cell(withoutTurns, withoutFresh), with: cell(withTurns, withFresh) };
}
