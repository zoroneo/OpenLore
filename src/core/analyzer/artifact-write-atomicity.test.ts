/**
 * harden-artifact-write-atomicity — the writer-adoption guard.
 *
 * The durability of the atomic-write helper and the analysis lock is proven by
 * `atomic-store.test.ts` (torn-write / rename atomicity) and `lock.test.ts`
 * (serialization / stale-steal). What this file guards is that the two artifact
 * WRITERS actually route through them — the spec's "one implementation, all
 * writers" requirement — so the guarantee can never silently regress to a bare
 * `writeFile` or a per-site inline `tmp + rename` on the largest, most-read
 * artifacts (`llm-context.json` and its siblings).
 *
 * A source scan, not a runtime test: the writers span a full analyze pipeline and
 * a live watcher, and the invariant we protect is structural — every persisted
 * artifact goes through `atomicWriteFile`, and each writer's artifact-mutation
 * section is fenced by `withAnalysisLock`. Plain `.test.ts` so CI runs it.
 *
 * Guards architecture-spec requirements ArtifactWritesAreAtomic and
 * ConcurrentArtifactWritersSerialize.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(SRC_ROOT, rel), 'utf-8');

// A bare `writeFile(` call. `atomicWriteFile(` uses a capital W, so this
// lowercase-w pattern never matches the shared helper — only an unguarded write.
const BARE_WRITE_FILE = /\bwriteFile\s*\(/g;
// A per-site inline `tmp + rename` — the discipline we consolidated into one home.
const INLINE_RENAME = /\brename\s*\(/g;

const ARTIFACT_GENERATOR = 'core/analyzer/artifact-generator.ts';
const WATCHER = 'core/services/mcp-watcher.ts';

describe('harden-artifact-write-atomicity: every artifact writer adopts the shared discipline', () => {
  it('the analyze artifact generator writes only through atomicWriteFile — no bare writeFile', () => {
    const src = read(ARTIFACT_GENERATOR);
    expect(src).toMatch(/import\s*\{\s*atomicWriteFile\s*\}\s*from\s*['"]\.\.\/decisions\/atomic-store\.js['"]/);
    expect(src.match(BARE_WRITE_FILE)).toBeNull();
  });

  it('the analyze artifact generator fences its save-set with withAnalysisLock', () => {
    const src = read(ARTIFACT_GENERATOR);
    expect(src).toMatch(/import\s*\{\s*withAnalysisLock\s*\}\s*from\s*['"]\.\.\/decisions\/lock\.js['"]/);
    expect(src).toMatch(/withAnalysisLock\(\s*this\.options\.outputDir/);
  });

  it('the watcher persists every artifact through atomicWriteFile — no bare writeFile, no inline rename', () => {
    const src = read(WATCHER);
    expect(src).toMatch(/import\s*\{\s*atomicWriteFile\s*\}\s*from\s*['"]\.\.\/decisions\/atomic-store\.js['"]/);
    // Both the bare write and the inline tmp+rename sites are gone — one home now.
    expect(src.match(BARE_WRITE_FILE)).toBeNull();
    expect(src.match(INLINE_RENAME)).toBeNull();
    expect(src).not.toMatch(/\.tmp/);
  });

  it('the watcher fences each artifact-mutation lane with withAnalysisLock', () => {
    const src = read(WATCHER);
    expect(src).toMatch(/import\s*\{\s*withAnalysisLock\s*\}\s*from\s*['"]\.\.\/decisions\/lock\.js['"]/);
    // Both the change lane (handleBatch) and the deletion lane fence on this.outputPath.
    const fences = src.match(/withAnalysisLock\(\s*this\.outputPath/g) ?? [];
    expect(fences.length).toBeGreaterThanOrEqual(2);
  });

  it('persistContext itself stays lock-free (it runs inside a lane that already holds the lock)', () => {
    // A lock re-acquire inside persistContext would deadlock the lane that fences it.
    const src = read(WATCHER);
    const persist = src.slice(src.indexOf('private async persistContext'));
    const body = persist.slice(0, persist.indexOf('\n  }'));
    expect(body).toMatch(/atomicWriteFile\(this\.contextPath/);
    expect(body).not.toMatch(/withAnalysisLock|acquireAnalysisLock/);
  });
});
