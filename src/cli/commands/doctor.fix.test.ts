/**
 * make-index-self-healing: `openlore doctor --fix` plans exactly the remediations
 * the read-only checks surfaced — nothing a check did not print — and each action
 * runs at most once. (The heavy execution — re-analyze / re-wire — is exercised
 * end-to-end in dogfood, not here.)
 */
import { describe, it, expect } from 'vitest';
import { planRemediations } from './doctor.js';

// CheckResult is not exported; the planner only reads status/remediation, so a
// structural literal is sufficient and keeps the test decoupled from the type.
type C = Parameters<typeof planRemediations>[0][number];

const analyzeFix = { kind: 'analyze', label: 'openlore analyze --force' } as const;
const rewireFix = { kind: 'rewire-mcp', label: 'openlore install --agent claude-code --force' } as const;

describe('planRemediations', () => {
  it('includes only non-ok checks that carry a remediation', () => {
    const checks: C[] = [
      { name: 'Node.js version', status: 'ok', detail: '' },
      { name: 'Analysis artifacts', status: 'warn', detail: '', remediation: analyzeFix },
      { name: 'Disk space', status: 'warn', detail: '' }, // warn but no remediation → excluded
      { name: 'MCP wiring', status: 'warn', detail: '', remediation: rewireFix },
    ];
    const plan = planRemediations(checks);
    expect(plan.map((p) => p.remediation.label)).toEqual([analyzeFix.label, rewireFix.label]);
  });

  it('never plans a remediation for a passing check', () => {
    const checks: C[] = [
      { name: 'Analysis artifacts', status: 'ok', detail: '', remediation: analyzeFix },
    ];
    expect(planRemediations(checks)).toEqual([]);
  });

  it('dedupes repeated actions so each runs at most once', () => {
    const checks: C[] = [
      { name: 'Analysis artifacts', status: 'warn', detail: '', remediation: analyzeFix },
      { name: 'Something else', status: 'fail', detail: '', remediation: analyzeFix },
    ];
    const plan = planRemediations(checks);
    expect(plan).toHaveLength(1);
    expect(plan[0].remediation.label).toBe(analyzeFix.label);
  });
});
