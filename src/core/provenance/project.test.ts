import { describe, it, expect } from 'vitest';
import { projectProvenance, personKey } from './project.js';
import type { FileProvenance } from './git-provenance.js';

const rec: FileProvenance = {
  filePath: 'src/a.ts',
  lastAuthor: { name: 'Bob', email: 'bob@example.com' },
  lastDate: '2026-02-01T10:00:00Z',
  lastCommit: 'abc1234',
  lastSubject: 'fix: b (#42)',
  recentAuthors: [
    { name: 'Bob', email: 'bob@example.com' },
    { name: 'Alice', email: 'alice@example.com' },
  ],
  prs: [{ number: 42, title: 'Fix the bucket', state: 'merged' }],
};

describe('projectProvenance', () => {
  it('emits one last-touch authored_by edge plus recent-author edges (last deduped)', () => {
    const { authoredBy } = projectProvenance([rec]);
    expect(authoredBy[0]).toMatchObject({ kind: 'authored_by', filePath: 'src/a.ts', name: 'Bob', role: 'last', lastDate: '2026-02-01T10:00:00Z' });
    // Bob is the last author, so the recent list contributes only Alice (deduped).
    expect(authoredBy.filter(e => e.role === 'recent').map(e => e.name)).toEqual(['Alice']);
  });

  it('emits changed_in_pr edges carrying gh enrichment when present', () => {
    const { changedInPr } = projectProvenance([rec]);
    expect(changedInPr).toEqual([
      { kind: 'changed_in_pr', filePath: 'src/a.ts', pr: 42, title: 'Fix the bucket', state: 'merged' },
    ]);
  });

  it('omits title/state for git-only PRs', () => {
    const gitOnly: FileProvenance = { ...rec, prs: [{ number: 7 }] };
    const { changedInPr } = projectProvenance([gitOnly]);
    expect(changedInPr).toEqual([{ kind: 'changed_in_pr', filePath: 'src/a.ts', pr: 7 }]);
  });

  it('is deterministic and file-sorted', () => {
    const out = projectProvenance([{ ...rec, filePath: 'src/z.ts' }, { ...rec, filePath: 'src/a.ts' }]);
    expect(out.authoredBy.map(e => e.filePath)).toEqual(['src/a.ts', 'src/a.ts', 'src/z.ts', 'src/z.ts']);
  });

  it('personKey formats name + email', () => {
    expect(personKey('Bob', 'bob@x.com')).toBe('Bob <bob@x.com>');
    expect(personKey('Bob', '')).toBe('Bob');
  });
});
