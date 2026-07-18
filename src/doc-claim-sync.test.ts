/**
 * Doc-claim sync guards (change: add-doc-claim-sync-guards).
 *
 * The honesty contract treats an unguarded published number as a defect
 * (`honesty-contract.test.ts` pins the README benchmark figures; `mcp-tool-count-doc.test.ts`
 * pins the "N tools" full-surface and preset-size counts to the code). This guard extends the
 * SAME discipline to the remaining quantitative doc claims that nothing bound to code:
 *
 *   1. The README language-count badge (and the docs/output.md call-graph note) must match the
 *      language sets in code — add a language and the badge must move, or CI fails.
 *   2. The "5500+ tests" floor is pinned to one canonical constant here; changing the published
 *      floor requires editing that constant in the same reviewed change. A floor stays a floor.
 *   3. Package metadata must not restate the retired pre-pivot product framing that contradicts
 *      the package `description` and the recorded north star (decision c6d1ad07).
 *
 * Scope note (tool count / preset sizes are NOT re-guarded here): those are already pinned by
 * `src/cli/commands/mcp-tool-count-doc.test.ts` (full surface → `TOOL_DEFINITIONS.length`; the
 * substrate/navigation preset sizes → their `TOOL_PRESETS` set sizes). This file guards the
 * claims that guard did not cover.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CODE_LANGUAGES } from './core/analyzer/language-support.js';
import { IAC_LANGUAGES, isIacLanguage } from './core/analyzer/iac/types.js';

// src/<this> → repo root is one level up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf-8');

// The badge reads "18 languages + 12 IaC". The "18" is the general-purpose code languages —
// NOT `CODE_LANGUAGES.length` (which is 20 because Terraform and Bicep are extension-detected
// code languages that ALSO belong to the IaC bucket). The IaC-overlapping members are counted
// in the "+ 12 IaC" half, so the code-language half derives from the non-IaC remainder. (This
// corrects the proposal's premise, which assumed the badge equals `CODE_LANGUAGES.length`.)
const CODE_LANG_COUNT = CODE_LANGUAGES.filter(l => !isIacLanguage(l)).length; // 18
const IAC_COUNT = IAC_LANGUAGES.length; // 12

// The minimum test count published as a floor. Not statically derivable (counting tests is
// fragile and would falsely pin a moving exact figure), so it is pinned here: change the
// published floor in any surface and this constant must move with it, in the same change.
// It is a FLOOR — published with a "+" suffix, never restated as a measured exact figure.
const MIN_TEST_FLOOR = 5500;

// Keywords / summaries that restate the retired "reverse-engineer specs from code" product,
// contradicting the package `description` ("Persistent architectural memory and structural
// cognition for AI coding agents") and the north-star decision c6d1ad07.
const RETIRED_FRAMING = ['reverse-engineering', 'spec-driven', 'documentation'];

describe('doc-claim sync: language counts track the code', () => {
  it('the README language badge matches the code/IaC language sets', () => {
    const readme = read('README.md');
    const line = readme.split('\n').find(l => l.includes('badge/languages-'));
    expect(line, 'expected a shields.io "badge/languages-" line in README.md').toBeDefined();

    // Badge slug: "languages-18%20%2B%2012%20IaC" → the two counts.
    const slug = /badge\/languages-(\d+)%20%2B%20(\d+)%20IaC/.exec(line!);
    expect(slug, `README language badge slug is not in the expected "languages-<N>%20%2B%20<M>%20IaC" form: ${line}`).not.toBeNull();
    const [badgeCode, badgeIac] = [Number(slug![1]), Number(slug![2])];
    expect(badgeCode, `README badge slug states ${badgeCode} code languages but the code set has ${CODE_LANG_COUNT} (non-IaC members of CODE_LANGUAGES)`).toBe(CODE_LANG_COUNT);
    expect(badgeIac, `README badge slug states ${badgeIac} IaC ecosystems but IAC_LANGUAGES has ${IAC_COUNT}`).toBe(IAC_COUNT);

    // Alt text: "18 languages + 12 IaC ecosystems" — must agree with the slug (and the code).
    const alt = /alt="(\d+) languages \+ (\d+) IaC/.exec(line!);
    expect(alt, `README language badge alt text is not in the expected "<N> languages + <M> IaC" form: ${line}`).not.toBeNull();
    expect(Number(alt![1]), `README badge alt text states ${alt![1]} languages but the code set has ${CODE_LANG_COUNT}`).toBe(CODE_LANG_COUNT);
    expect(Number(alt![2]), `README badge alt text states ${alt![2]} IaC but IAC_LANGUAGES has ${IAC_COUNT}`).toBe(IAC_COUNT);
  });

  it('the docs/output.md call-graph language count matches the code set', () => {
    const text = read('docs/output.md');
    // The call-graph.json row states "(18 languages: TS/JS, Python, …)".
    const m = /\((\d+) languages:/.exec(text);
    expect(m, 'expected a "(<N> languages: …)" call-graph note in docs/output.md').not.toBeNull();
    expect(Number(m![1]), `docs/output.md states ${m![1]} call-graph languages but the code set has ${CODE_LANG_COUNT}; update the count (and its enumeration) when a language is added`).toBe(CODE_LANG_COUNT);
  });
});

describe('doc-claim sync: the test-count floor is pinned to its guard', () => {
  const readme = read('README.md');

  it('the README tests badge states the canonical floor, as a floor', () => {
    const line = readme.split('\n').find(l => l.includes('badge/tests-'));
    expect(line, 'expected a shields.io "badge/tests-" line in README.md').toBeDefined();
    // "tests-5500%2B-success" — the %2B is the "+" that makes it a floor, not an exact figure.
    const m = /badge\/tests-(\d+)%2B/.exec(line!);
    expect(m, `README tests badge is not in the expected "tests-<N>%2B" (floor) form: ${line}`).not.toBeNull();
    expect(Number(m![1]), `README tests badge states ${m![1]}+ but the canonical floor is ${MIN_TEST_FLOOR}; update MIN_TEST_FLOOR in this guard to move the published floor`).toBe(MIN_TEST_FLOOR);
  });

  it('the README dev-instructions test count agrees with the same floor', () => {
    // "npm run test:run  # 5500+ unit tests, one-shot …"
    const m = /(\d+)\+ unit tests/.exec(readme);
    expect(m, 'expected a "<N>+ unit tests" note in the README build instructions').not.toBeNull();
    expect(Number(m![1]), `README build note states ${m![1]}+ unit tests but the canonical floor is ${MIN_TEST_FLOOR}; both README sites must agree with MIN_TEST_FLOOR`).toBe(MIN_TEST_FLOOR);
  });
});

describe('doc-claim sync: package metadata matches the recorded north star', () => {
  const pkg = JSON.parse(read('package.json')) as {
    description: string;
    keywords: string[];
    openspec: { summary: string };
  };

  it('the package description is the north-star anchor', () => {
    // The description is the fixed anchor the keywords/summary must not contradict.
    expect(pkg.description.toLowerCase()).toContain('architectural memory');
    expect(pkg.description.toLowerCase()).toContain('coding agents');
  });

  it('keywords do not restate the retired pre-pivot framing', () => {
    for (const retired of RETIRED_FRAMING) {
      expect(
        pkg.keywords.includes(retired),
        `package.json keyword "${retired}" restates the retired "reverse-engineer specs from code" product, contradicting the description and north star (c6d1ad07)`,
      ).toBe(false);
    }
  });

  it('the openspec.summary describes the substrate positioning, not the retired product', () => {
    expect(
      /reverse-engineer/i.test(pkg.openspec.summary),
      `package.json openspec.summary still restates the retired "reverse-engineer specs" framing: "${pkg.openspec.summary}"`,
    ).toBe(false);
  });
});
