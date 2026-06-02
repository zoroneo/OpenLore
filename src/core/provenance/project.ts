/**
 * Projection: per-file provenance → typed `authored_by` / `changed_in_pr` graph
 * edges (spec-18). The decisions/IaC analogue: git history is the authored source;
 * this projection is derived and regenerable. Edges hang off existing file nodes —
 * no person/PR nodes are added to the call graph, keeping it un-bloated (the cap is
 * applied upstream in the extractor).
 *
 * Edge direction is code → context: a file is `authored_by` a person and
 * `changed_in_pr` a pull request.
 */

import type { FileProvenance } from './git-provenance.js';

/** file → person. `role: 'last'` marks the last-touch author. */
export interface AuthoredByEdge {
  kind: 'authored_by';
  filePath: string;
  name: string;
  email: string;
  /** Author date of the last-touch commit (only meaningful for role 'last'). */
  lastDate?: string;
  role: 'last' | 'recent';
}

/** file → pull request. `title`/`state` present only when `gh` enrichment succeeded. */
export interface ChangedInPrEdge {
  kind: 'changed_in_pr';
  filePath: string;
  pr: number;
  title?: string;
  state?: string;
}

export interface ProjectedProvenance {
  authoredBy: AuthoredByEdge[];
  changedInPr: ChangedInPrEdge[];
}

/** "Name <email>" display key for a person (stable identity). */
export function personKey(name: string, email: string): string {
  return email ? `${name} <${email}>` : name;
}

export function projectProvenance(records: FileProvenance[]): ProjectedProvenance {
  const authoredBy: AuthoredByEdge[] = [];
  const changedInPr: ChangedInPrEdge[] = [];

  for (const r of [...records].sort((a, b) => a.filePath.localeCompare(b.filePath))) {
    // Last-touch author first, then the remaining recent authors (deduped).
    authoredBy.push({
      kind: 'authored_by',
      filePath: r.filePath,
      name: r.lastAuthor.name,
      email: r.lastAuthor.email,
      lastDate: r.lastDate,
      role: 'last',
    });
    const lastKey = personKey(r.lastAuthor.name, r.lastAuthor.email);
    for (const a of r.recentAuthors) {
      if (personKey(a.name, a.email) === lastKey) continue;
      authoredBy.push({ kind: 'authored_by', filePath: r.filePath, name: a.name, email: a.email, role: 'recent' });
    }

    for (const pr of r.prs) {
      changedInPr.push({
        kind: 'changed_in_pr',
        filePath: r.filePath,
        pr: pr.number,
        ...(pr.title ? { title: pr.title } : {}),
        ...(pr.state ? { state: pr.state } : {}),
      });
    }
  }

  return { authoredBy, changedInPr };
}
