/**
 * claude-code adapter — appends the OpenLore instruction block to CLAUDE.md
 * (creating it if absent), registers the OpenLore MCP server in `.mcp.json`
 * (the project-scope file Claude Code actually reads for MCP), and adds a
 * SessionStart hook to `.claude/settings.json`.
 *
 * NB: Claude Code loads MCP servers only from `.mcp.json` (project),
 * `~/.claude.json`, or `claude mcp add` — never from `.claude/settings.json`.
 * Earlier versions wrote `mcpServers.openlore` to `settings.json`, so the
 * server never loaded; `apply` now migrates that stale entry away.
 */

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { applyMarkdownBlock, uninstallMarkdownBlock } from './markdown-block.js';
import { mergeEntries, readMeta, removeManaged, isHandEdited } from '../json-managed.js';
import { previewCreate, previewDiff } from '../diff.js';
import type { Adapter, ApplyContext, ApplyResult, PlannedChange } from './types.js';

const MD_FILE = 'CLAUDE.md';
const SETTINGS_PATH = '.claude/settings.json';
const MCP_PATH = '.mcp.json';

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

    // --- 1. MCP server registration → .mcp.json (the file Claude Code reads) ---
    const mcpPath = join(ctx.root, MCP_PATH);
    const existingMcp = await readJsonOrEmpty(mcpPath);
    const hadMcp = await fileExists(mcpPath);
    const prevMcpMeta = readMeta(existingMcp);
    if (prevMcpMeta && isHandEdited(existingMcp, prevMcpMeta) && !ctx.force) {
      mdResult.changes.push({
        path: mcpPath,
        kind: 'noop',
        summary: `${MCP_PATH}: refused to overwrite hand-edited OpenLore entries (use --force)`,
      });
      mdResult.warnings.push(
        `${MCP_PATH} has hand-edits in OpenLore-managed paths — pass --force to overwrite`
      );
      mdResult.conflict = true;
      return mdResult;
    }
    const { next: nextMcp, action: mcpAction } = mergeEntries(existingMcp, [
      { path: 'mcpServers.openlore', value: MCP_ENTRY },
    ]);
    const mcpBefore = hadMcp ? JSON.stringify(existingMcp, null, 2) + '\n' : '';
    const mcpAfter = JSON.stringify(nextMcp, null, 2) + '\n';
    mdResult.changes.push({
      path: mcpPath,
      kind: !hadMcp ? 'create' : mcpAction === 'noop' ? 'noop' : 'update',
      summary: !hadMcp
        ? `create ${MCP_PATH} with mcpServers.openlore`
        : mcpAction === 'noop'
          ? `${MCP_PATH}: already up to date`
          : `update mcpServers.openlore in ${MCP_PATH}`,
      preview: !hadMcp
        ? previewCreate(mcpPath, mcpAfter)
        : mcpAction === 'noop'
          ? undefined
          : previewDiff(mcpPath, mcpBefore, mcpAfter),
    });
    if (!ctx.dryRun && (mcpAction !== 'noop' || !hadMcp)) {
      await mkdir(dirname(mcpPath), { recursive: true });
      await writeFile(mcpPath, mcpAfter, 'utf8');
    }

    // --- 2. SessionStart hook → .claude/settings.json (marker-identified) ---
    const settingsPath = join(ctx.root, SETTINGS_PATH);
    const existing = await readJsonOrEmpty(settingsPath);
    const had = await fileExists(settingsPath);

    // Migrate away the legacy mcpServers.openlore + meta a prior version wrote
    // here (settings.json is never read for MCP). removeManaged strips the
    // managed paths (mcpServers.openlore) and our top-level meta; SessionStart
    // is identified separately by its `_openlore: true` marker, so it survives.
    const migrated = removeManaged(existing);
    const base = migrated.removed ? migrated.next : existing;

    const currentSessionStart =
      ((base.hooks as Record<string, unknown>)?.SessionStart as unknown) ?? [];
    const nextSessionStart = mergeSessionStart(currentSessionStart);

    const next = structuredClone(base) as Record<string, unknown>;
    if (!next.hooks || typeof next.hooks !== 'object') next.hooks = {};
    (next.hooks as Record<string, unknown>).SessionStart = nextSessionStart;

    const changed = JSON.stringify(existing) !== JSON.stringify(next);
    const before = had ? JSON.stringify(existing, null, 2) + '\n' : '';
    const after = JSON.stringify(next, null, 2) + '\n';
    const change: PlannedChange = {
      path: settingsPath,
      kind: !had ? 'create' : !changed ? 'noop' : 'update',
      summary: !had
        ? `create ${SETTINGS_PATH} with SessionStart hook`
        : !changed
          ? `${SETTINGS_PATH}: already up to date`
          : `update SessionStart hook in ${SETTINGS_PATH}`,
      preview: !had
        ? previewCreate(settingsPath, after)
        : !changed
          ? undefined
          : previewDiff(settingsPath, before, after),
    };

    if (!ctx.dryRun && changed) {
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, after, 'utf8');
    }

    mdResult.changes.push(change);
    return mdResult;
  },

  async uninstall(ctx: ApplyContext): Promise<ApplyResult> {
    const md = await uninstallMarkdownBlock(ctx, MD_FILE, false);

    // Strip mcpServers.openlore from .mcp.json; delete the file if it was ours.
    const mcpPath = join(ctx.root, MCP_PATH);
    try {
      const parsedMcp = JSON.parse(await readFile(mcpPath, 'utf8')) as Record<string, unknown>;
      const { next, removed } = removeManaged(parsedMcp);
      if (removed) {
        if (Object.keys(next).length === 0) {
          if (!ctx.dryRun) await unlink(mcpPath);
          md.changes.push({
            path: mcpPath,
            kind: 'delete',
            summary: `remove ${MCP_PATH} (was OpenLore-only)`,
          });
        } else {
          if (!ctx.dryRun) await writeFile(mcpPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
          md.changes.push({
            path: mcpPath,
            kind: 'update',
            summary: `strip OpenLore entries from ${MCP_PATH}`,
          });
        }
      }
    } catch {
      /* no .mcp.json — nothing to do */
    }

    const settingsPath = join(ctx.root, SETTINGS_PATH);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
    } catch {
      return md;
    }
    // Strip our SessionStart entry (identified by the `_openlore` marker, not by
    // the managed-paths meta).
    let changed = false;
    const hooksObj = parsed.hooks as Record<string, unknown> | undefined;
    if (hooksObj && Array.isArray(hooksObj.SessionStart)) {
      const filtered = stripOurSessionStart(hooksObj.SessionStart);
      if (filtered.length !== hooksObj.SessionStart.length) changed = true;
      if (filtered.length === 0) {
        delete hooksObj.SessionStart;
        if (Object.keys(hooksObj).length === 0) delete parsed.hooks;
      } else {
        hooksObj.SessionStart = filtered;
      }
    }

    // Also strip any legacy managed entry (mcpServers.openlore + meta) a prior
    // version wrote here before MCP moved to .mcp.json.
    const { next, removed } = removeManaged(parsed);
    if (removed) changed = true;
    if (!changed) return md;

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
