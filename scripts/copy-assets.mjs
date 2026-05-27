#!/usr/bin/env node
/**
 * Copy non-TypeScript assets from src/ to dist/ after `tsc`.
 *
 * Currently:
 *   - src/cli/install/templates/*  →  dist/cli/install/templates/*
 *   - src/core/scip/vendor/*       →  dist/core/scip/vendor/*  (vendored scip.proto, loaded at runtime)
 */

import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const assets = [
  {
    from: resolve(repoRoot, 'src/cli/install/templates'),
    to: resolve(repoRoot, 'dist/cli/install/templates'),
  },
  {
    from: resolve(repoRoot, 'src/core/scip/vendor'),
    to: resolve(repoRoot, 'dist/core/scip/vendor'),
  },
];

for (const { from, to } of assets) {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
  console.log(`[copy-assets] ${from} → ${to}`);
}
