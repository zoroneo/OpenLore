/**
 * Preset surface benchmark — the deterministic half of the DefaultSurfaceRevealsAllFaces
 * gate (change: refine-happy-path-and-defaults).
 *
 * The proposal's gate for flipping the out-of-box default from `navigation` (read
 * face only) to a face-complete surface (the `substrate` preset) is:
 *   "move the default unless the evaluation shows a regression in SELECTION ACCURACY
 *    or TOKEN ECONOMY."
 *
 * Two of those three quantities are deterministic and need no agent, and this harness
 * measures them now:
 *   - TOKEN ECONOMY — the upfront tools/list payload (bytes + estimated tokens) each
 *     preset costs in the prompt prefix, using the exact measurement the budget guard
 *     in mcp-presets.test.ts uses.
 *   - FACE COVERAGE — which capability families (faces) each preset exposes, i.e.
 *     whether the surface "reveals all faces" (navigate + remember + verify + change).
 *
 * The third quantity — SELECTION ACCURACY — requires a live agent making tool-choice
 * decisions over a task corpus; this harness documents that protocol but cannot run it
 * without an agent/key. So this is decision-SUPPORT, not the final verdict.
 *
 * Run: npx tsx scripts/bench-preset-surface.ts [--json]
 * No LLM, no network, no analyzed repo required — pure surface arithmetic.
 */

import {
  TOOL_DEFINITIONS,
  TOOL_PRESETS,
  selectActiveTools,
  toolAnnotations,
} from '../src/cli/commands/mcp.js';
import { capabilityFamily, CAPABILITY_FAMILIES, type CapabilityFamily } from '../src/core/services/mcp-handlers/tool-contract.js';
import { LEAN_DEFAULT_PRESET } from '../src/constants.js';

/** The four faces the default surface should reveal (DefaultSurfaceRevealsAllFaces). */
const HIGH_VALUE_FACES: CapabilityFamily[] = ['navigate', 'remember', 'verify', 'change'];

/** Rough token estimate — bytes / 4, the standard heuristic for English/JSON. */
function estTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

/** The exact tools/list payload measurement used by the mcp-presets budget guard. */
function payloadBytes(preset: string): number {
  const tools = selectActiveTools(TOOL_DEFINITIONS, { preset }).map((t) => ({
    ...t,
    annotations: toolAnnotations(t.name),
  }));
  return Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
}

interface PresetMeasurement {
  preset: string;
  toolCount: number;
  bytes: number;
  estTokens: number;
  families: CapabilityFamily[];
  revealsAllFaces: boolean;
}

function measure(preset: string): PresetMeasurement {
  const tools = selectActiveTools(TOOL_DEFINITIONS, { preset });
  const families = new Set<CapabilityFamily>();
  for (const t of tools) {
    const fam = capabilityFamily(t.name);
    if (fam) families.add(fam);
  }
  const bytes = payloadBytes(preset);
  const orderedFamilies = CAPABILITY_FAMILIES.filter((f) => families.has(f));
  return {
    preset,
    toolCount: tools.length,
    bytes,
    estTokens: estTokens(bytes),
    families: orderedFamilies,
    revealsAllFaces: HIGH_VALUE_FACES.every((f) => families.has(f)),
  };
}

const PRESETS_TO_REPORT = ['minimal', LEAN_DEFAULT_PRESET, 'substrate', 'full'];

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function run(): void {
  const json = process.argv.includes('--json');
  const measurements = PRESETS_TO_REPORT.map(measure);

  const lean = measurements.find((m) => m.preset === LEAN_DEFAULT_PRESET)!;
  const substrate = measurements.find((m) => m.preset === 'substrate')!;

  const gate = {
    leanDefault: LEAN_DEFAULT_PRESET,
    candidate: 'substrate',
    tokenEconomy: {
      deltaBytes: substrate.bytes - lean.bytes,
      deltaEstTokens: substrate.estTokens - lean.estTokens,
      // The platform's tool-search guidance reaches for deferral past ~10K tokens of
      // tool definitions; a candidate default well under that is economically safe.
      candidateEstTokens: substrate.estTokens,
      withinSelectionGuidance: substrate.estTokens < 10_000,
    },
    faceCoverage: {
      leanFaces: lean.families,
      candidateFaces: substrate.families,
      leanRevealsAllFaces: lean.revealsAllFaces,
      candidateRevealsAllFaces: substrate.revealsAllFaces,
    },
    selectionAccuracy: 'NOT MEASURED — requires a live agent over a task corpus (see protocol below)',
  };

  if (json) {
    process.stdout.write(JSON.stringify({ measurements, gate }, null, 2) + '\n');
    return;
  }

  const lines: string[] = [];
  lines.push('');
  lines.push('Preset surface comparison — deterministic, no LLM (DefaultSurfaceRevealsAllFaces gate)');
  lines.push('');
  lines.push('  preset      tools   payload   ~tokens   faces');
  lines.push('  ' + '-'.repeat(74));
  for (const m of measurements) {
    lines.push(
      '  ' +
        m.preset.padEnd(11) +
        String(m.toolCount).padStart(4) +
        '   ' +
        kb(m.bytes).padStart(8) +
        '  ' +
        `~${(m.estTokens / 1000).toFixed(1)}k`.padStart(8) +
        '   ' +
        m.families.join(', '),
    );
  }
  lines.push('');
  lines.push(`Default-flip gate: ${LEAN_DEFAULT_PRESET} (current default) → substrate (candidate)`);
  lines.push('');
  lines.push(
    `  Token economy : substrate costs +${kb(gate.tokenEconomy.deltaBytes)} / ~+${(gate.tokenEconomy.deltaEstTokens / 1000).toFixed(1)}k tokens upfront ` +
      `(candidate ~${(substrate.estTokens / 1000).toFixed(1)}k tokens; ${gate.tokenEconomy.withinSelectionGuidance ? 'within' : 'OVER'} the ~10k tool-search threshold).`,
  );
  lines.push(
    `  Face coverage : ${LEAN_DEFAULT_PRESET} reveals {${lean.families.join(', ')}} (all-faces: ${lean.revealsAllFaces}); ` +
      `substrate reveals {${substrate.families.join(', ')}} (all-faces: ${substrate.revealsAllFaces}).`,
  );
  lines.push(
    `  Verdict (deterministic half): substrate ${substrate.revealsAllFaces ? 'IS face-complete' : 'is NOT face-complete'} and ` +
      `${gate.tokenEconomy.withinSelectionGuidance ? 'within token budget' : 'OVER token budget'}.`,
  );
  lines.push('');
  lines.push('  Remaining gate — SELECTION ACCURACY (needs a live agent, not run here):');
  lines.push('    Protocol: for a fixed task corpus, present each preset to an agent and record');
  lines.push('    whether it selects the correct tool(s) per task (and round-trips to answer).');
  lines.push('    Flip the default to substrate iff accuracy does not regress vs navigation.');
  lines.push('    A starting corpus + driver live in scripts/bench-agent.tasks.ts / bench-agent.ts.');
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}

run();
