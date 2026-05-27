/**
 * `openlore export scip` — emit an `index.scip` derived from the analysis graph.
 *
 * Loads the persisted call graph and projects it into SCIP (see
 * src/core/scip/index.ts). The SQLite/JSON graph remains canonical; this is a
 * one-way interop export for the Sourcegraph / Glean ecosystem.
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { logger } from '../../utils/logger.js';
import { readCachedContext } from '../../core/services/mcp-handlers/utils.js';
import { exportScip, type ExportReport } from '../../core/scip/index.js';
import type { PackageInfo } from '../../core/scip/moniker.js';

const require = createRequire(import.meta.url);

export interface ScipExportOptions {
  out?: string;
  projectRoot?: string;
  include?: string[];
  exclude?: string[];
}

/** openlore's own version, emitted as SCIP tool_info.version. */
function toolVersion(): string {
  const pkg = require('../../../package.json') as { version: string };
  return pkg.version;
}

/**
 * Derive the SCIP `<package>` coordinates for the target project. Reads
 * package.json when present (npm); otherwise infers the ecosystem from a
 * manifest file and falls back to the directory name at version 0.0.0.
 */
export function derivePackageInfo(projectRoot: string): PackageInfo {
  const pkgJsonPath = join(projectRoot, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { name?: string; version?: string };
      if (pkg.name) {
        return { manager: 'npm', name: pkg.name, version: pkg.version ?? '0.0.0' };
      }
    } catch {
      // fall through to manifest inference
    }
  }
  const manifests: Array<[string, string]> = [
    ['Cargo.toml', 'cargo'],
    ['go.mod', 'gomod'],
    ['pyproject.toml', 'pip'],
    ['setup.py', 'pip'],
    ['Gemfile', 'gem'],
    ['pom.xml', 'maven'],
  ];
  const manager = manifests.find(([f]) => existsSync(join(projectRoot, f)))?.[1] ?? 'npm';
  return { manager, name: basename(projectRoot), version: '0.0.0' };
}

export async function runScipExport(opts: ScipExportOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());

  const ctx = await readCachedContext(projectRoot);
  const graph = ctx?.callGraph;
  if (!graph || graph.nodes.length === 0) {
    logger.error('No analysis graph found. Run `openlore analyze` first.');
    return 2;
  }

  const report: ExportReport = {
    documentCount: 0,
    occurrenceCount: 0,
    symbolCount: 0,
    definitionCount: 0,
    unspecifiedLanguageFiles: [],
    warnings: [],
  };

  let buffer: Buffer;
  try {
    buffer = exportScip(graph, {
      projectRoot,
      package: derivePackageInfo(projectRoot),
      toolVersion: toolVersion(),
      include: opts.include,
      exclude: opts.exclude,
      report,
    });
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const outPath = resolve(opts.out ?? join(projectRoot, 'index.scip'));
  await writeFile(outPath, buffer);

  logger.success(`Wrote ${outPath} (${buffer.byteLength} bytes)`);
  logger.info('documents', report.documentCount);
  logger.info('symbols', report.symbolCount);
  logger.info('occurrences', report.occurrenceCount);
  logger.info('definitions', report.definitionCount);
  if (report.unspecifiedLanguageFiles.length > 0) {
    logger.warning(
      `${report.unspecifiedLanguageFiles.length} file(s) have no SCIP language enum and were tagged UnspecifiedLanguage.`
    );
  }
  for (const w of report.warnings) logger.warning(w);

  return 0;
}
