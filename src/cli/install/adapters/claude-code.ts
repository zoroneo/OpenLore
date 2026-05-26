/**
 * claude-code adapter — appends the OpenLore instruction block to CLAUDE.md
 * (creating it if absent) and adds a SessionStart hook + MCP server
 * registration to `.claude/settings.json`.
 */

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { applyMarkdownBlock, uninstallMarkdownBlock } from './markdown-block.js';
import { mergeEntries, readMeta, removeManaged, isHandEdited } from '../json-managed.js';
import type { Adapter, ApplyContext, ApplyResult, PlannedChange } from './types.js';

const MD_FILE = 'CLAUDE.md';
const SETTINGS_PATH = '.claude/settings.json';

const MCP_ENTRY = {
  command: 'npx',
  args: ['--yes', 'openlore', 'mcp'],
};

/**
 * Our SessionStart entry is marked with `_openlore: true` so we can identify
 * (and replace, or remove on uninstall) just our group without touching any
 * other SessionStart hooks the user may have configured. Claude Code ignores
 * unknown fields on matcher groups.
 */
const ORIENT_COMMAND = 'npx --yes openlore orient --json';
const SESSION_HOOK = {
  matcher: '',
  _openlore: true,
  hooks: [
    {
      type: 'command',
      command: ORIENT_COMMAND,
    },
  ],
};

function isOurSessionEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  return (entry as Record<string, unknown>)._openlore === true;
}

function mergeSessionStart(existing: unknown): unknown[] {
  const arr = Array.isArray(existing) ? existing : [];
  const withoutOurs = arr.filter((e) => !isOurSessionEntry(e));
  return [...withoutOurs, SESSION_HOOK];
}

function stripOurSessionStart(existing: unknown): unknown[] {
  const arr = Array.isArray(existing) ? existing : [];
  return arr.filter((e) => !isOurSessionEntry(e));
}

async function readJsonOrEmpty(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export const claudeCodeAdapter: Adapter = {
  name: 'claude-code',
  async apply(ctx: ApplyContext): Promise<ApplyResult> {
    const mdResult = await applyMarkdownBlock(ctx, {
      fileName: MD_FILE,
      createIfMissing: true,
      blockBody: ctx.instructionTemplate,
    });

    const settingsPath = join(ctx.root, SETTINGS_PATH);
    const existing = await readJsonOrEmpty(settingsPath);
    const had = await fileExists(settingsPath);
    const prevMeta = readMeta(existing);
    if (prevMeta && isHandEdited(existing, prevMeta) && !ctx.force) {
      mdResult.changes.push({
        path: settingsPath,
        kind: 'noop',
        summary: `${SETTINGS_PATH}: refused to overwrite hand-edited OpenLore entries (use --force)`,
      });
      mdResult.warnings.push(
        `${SETTINGS_PATH} has hand-edits in OpenLore-managed paths — pass --force to overwrite`
      );
      mdResult.conflict = true;
      return mdResult;
    }

    // SessionStart is computed imperatively (preserving any user-defined
    // entries) and written through mergeEntries, but only mcpServers.openlore
    // is tracked in our meta — we identify our SessionStart entry by its
    // `_openlore: true` marker, not by claiming the whole array.
    const currentSessionStart =
      ((existing.hooks as Record<string, unknown>)?.SessionStart as unknown) ?? [];
    const nextSessionStart = mergeSessionStart(currentSessionStart);

    const { next, action } = mergeEntries(existing, [
      { path: 'mcpServers.openlore', value: MCP_ENTRY },
    ]);
    // Apply the SessionStart update outside the managed-paths set.
    if (!next.hooks || typeof next.hooks !== 'object') next.hooks = {};
    (next.hooks as Record<string, unknown>).SessionStart = nextSessionStart;

    // Re-derive action: if existing already had identical SessionStart + meta noop, it's noop.
    const sessionChanged =
      JSON.stringify(currentSessionStart) !== JSON.stringify(nextSessionStart);
    const finalAction =
      action === 'noop' && !sessionChanged ? 'noop' : action === 'created' ? 'created' : 'updated';

    const change: PlannedChange = {
      path: settingsPath,
      kind: !had ? 'create' : finalAction === 'noop' ? 'noop' : 'update',
      summary: !had
        ? `create ${SETTINGS_PATH} with SessionStart hook + mcpServers.openlore`
        : finalAction === 'noop'
          ? `${SETTINGS_PATH}: already up to date`
          : `update SessionStart hook + mcpServers.openlore in ${SETTINGS_PATH}`,
    };

    if (!ctx.dryRun && (finalAction !== 'noop' || !had)) {
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    }

    mdResult.changes.push(change);
    return mdResult;
  },

  async uninstall(ctx: ApplyContext): Promise<ApplyResult> {
    const md = await uninstallMarkdownBlock(ctx, MD_FILE, false);
    const settingsPath = join(ctx.root, SETTINGS_PATH);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
    } catch {
      return md;
    }
    // Strip our SessionStart entry first (it's identified by _openlore marker,
    // not by the managed-paths meta).
    const hooksObj = parsed.hooks as Record<string, unknown> | undefined;
    if (hooksObj && Array.isArray(hooksObj.SessionStart)) {
      const filtered = stripOurSessionStart(hooksObj.SessionStart);
      if (filtered.length === 0) {
        delete hooksObj.SessionStart;
        if (Object.keys(hooksObj).length === 0) delete parsed.hooks;
      } else {
        hooksObj.SessionStart = filtered;
      }
    }

    const { next, removed } = removeManaged(parsed);
    if (!removed && parsed.hooks === undefined) {
      // We may have only stripped a SessionStart entry — that still counts as work.
    } else if (!removed) {
      return md;
    }

    // If file is now empty (only had our entries), delete it.
    const isEmpty = Object.keys(next).length === 0;
    if (isEmpty) {
      if (!ctx.dryRun) await unlink(settingsPath);
      md.changes.push({
        path: settingsPath,
        kind: 'delete',
        summary: `remove ${SETTINGS_PATH} (was OpenLore-only)`,
      });
    } else {
      if (!ctx.dryRun) await writeFile(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
      md.changes.push({
        path: settingsPath,
        kind: 'update',
        summary: `strip OpenLore entries from ${SETTINGS_PATH}`,
      });
    }
    return md;
  },
};
