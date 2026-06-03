/**
 * McpWatcher — incremental re-indexer for the MCP server's --watch mode.
 *
 * Watches source files for changes and incrementally updates:
 *   1. signatures in llm-context.json (always)
 *   2. vector index (only when embed: true and an embedding server is reachable)
 *
 * The call graph is deliberately excluded — rebuilding it requires full
 * tree-sitter analysis of all call sites and is too expensive for a watch loop.
 * It stays current via the post-commit hook (openlore analyze --force --embed).
 *
 * Spec 13.1 (watch-mode performance): freshness is O(change), not O(repo).
 *   • Per-file events COALESCE into one batched flush (single debounce timer +
 *     hard max-batch ceiling), so a burst / branch-switch runs the pipeline once,
 *     not once per file.
 *   • The patched llm-context is handed to the MCP read cache in place
 *     (primeContextCache), so the next tool call is a cache HIT — no 2.1 MB
 *     cold re-parse — even after the disk write.
 *   • Vector updates are row-level (VectorIndex.updateFiles), not a full-corpus
 *     read+overwrite, and run on a separate lower-priority lane so signature
 *     freshness never blocks on embedding.
 *   • VCS-flood / bulk batches are detected and collapsed to a single refresh.
 *   • stderr emits one summary line per batch by default (per-file detail behind
 *     OPENLORE_WATCH_DEBUG).
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import chokidar, { type FSWatcher } from 'chokidar';
import { extractSignatures, detectLanguage } from '../analyzer/signature-extractor.js';
import type { FunctionNode } from '../analyzer/call-graph.js';
import { EdgeStore } from './edge-store.js';
import { primeContextCache, type CachedContext } from './mcp-handlers/utils.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  WATCH_DEBOUNCE_MS,
  WATCH_MAX_BATCH_MS,
  WATCH_BULK_THRESHOLD,
  WATCH_EMBED_FILE_CEILING,
  WATCH_VCS_SETTLE_MS,
} from '../../constants.js';

const CALL_GRAPH_LANGS = new Set([
  'Python', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Ruby', 'Java', 'C++', 'Swift',
]);
/** Max callerFiles to re-parse in a single watch event (guards against high-fanIn renames). */
const CALLER_REPARSE_LIMIT = 10;

/**
 * Session-global latch: a SCHEMA_VERSION bump wipes the graph store, and an
 * incremental update can't repair it — only a full `analyze` can. We schedule
 * exactly one background rebuild per process (Spec 26 B10). Latched (never
 * cleared) so a persistently-failing rebuild can't spin into a loop; on failure
 * we fall back to the existing "run analyze" note.
 */
let backgroundRebuildTriggered = false;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpWatcherOptions {
  /** Absolute path to the project root being watched */
  rootPath: string;
  /** Absolute path to .openlore/analysis/ — where llm-context.json lives */
  outputPath?: string;
  /** Milliseconds to debounce file-change events (default: WATCH_DEBOUNCE_MS) */
  debounceMs?: number;
  /** Hard flush ceiling under a continuous change stream (default: WATCH_MAX_BATCH_MS) */
  maxBatchMs?: number;
  /** Batch size that trips VCS-flood handling (default: WATCH_BULK_THRESHOLD) */
  bulkThreshold?: number;
  /** Run the live vector update; false = signatures-only (default: true) */
  embed?: boolean;
  /** Above this many watched source files, auto-degrade to signatures-only */
  embedFileCeiling?: number;
  /** Extra glob patterns to ignore in addition to defaults */
  ignore?: string[];
}

interface ChangedFile {
  rel: string;
  content: string;
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|php|cs|cpp|cc|cxx|h|hpp|c|swift)$/;

// Directory NAMES that must never be watched. Build-output and dependency
// directories can hold hundreds of thousands of files (a Rust `target/` is
// routinely tens of GB), so watching them is both wasteful and a hard EMFILE
// trigger on the first tool call.
//
// Matched against root-RELATIVE path segments (see isIgnoredRelPath), which is
// what makes this robust:
//   • The ignored directory ITSELF matches (not just its children), so chokidar
//     prunes the whole subtree and never opens FDs inside it — the actual EMFILE
//     fix. A naive `path.includes('/target/')` check only matches descendants,
//     so chokidar still descends into target/ and readdir-storms before pruning.
//   • Only segments BELOW the watch root are considered, so a repo that happens
//     to live under e.g. /home/user/dist/myapp is not wrongly ignored.
const IGNORED_DIR_NAMES = new Set([
  // VCS / openlore
  '.git', '.hg', '.svn', '.openlore',
  // JS / TS
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.svelte-kit',
  '.turbo', '.parcel-cache', '.cache', 'coverage', '.vite',
  // Rust
  'target',
  // Python
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.tox', '.ruff_cache',
  // Go / vendored deps
  'vendor',
  // JVM
  '.gradle',
  // .NET
  'obj',
  // Editor metadata
  '.idea',
]);
const IGNORED_SUFFIXES = ['.test.ts', '.test.js', '.spec.ts', '.spec.js'];

/**
 * True if a root-relative path should never be watched. Evaluated as a cheap
 * segment scan before any FD is opened, so it stays allocation-light. A path is
 * ignored if ANY of its segments is a known build/dependency/VCS directory
 * name, or it has a test-file suffix. Exported for testing.
 *
 * @param relPath path relative to the watch root (forward- or back-slashed)
 */
export function isIgnoredRelPath(relPath: string): boolean {
  if (!relPath || relPath === '.') return false;
  const segments = relPath.split(/[/\\]/);
  for (const seg of segments) {
    if (IGNORED_DIR_NAMES.has(seg)) return true;
  }
  for (const suf of IGNORED_SUFFIXES) {
    if (relPath.endsWith(suf)) return true;
  }
  return false;
}

// ── McpWatcher ────────────────────────────────────────────────────────────────

export class McpWatcher {
  private readonly rootPath: string;
  private readonly outputPath: string;
  private readonly contextPath: string;
  private readonly debounceMs: number;
  private readonly maxBatchMs: number;
  private readonly bulkThreshold: number;
  private readonly embedFileCeiling: number;
  private readonly extraIgnore: string[];
  private readonly debug: boolean;

  private fsWatcher?: FSWatcher;
  private gitWatcher?: FSWatcher;

  // ── Coalescing queue (Step 1) ──────────────────────────────────────────────
  private pending = new Set<string>();              // absolute paths awaiting a flush
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private maxBatchTimer?: ReturnType<typeof setTimeout>;
  private running = false;                           // single-flight for the signature flush
  private vcsBulkFlag = false;                       // set by the .git ref watcher

  // ── Embedding lane (Step 4 — decoupled, lower priority) ─────────────────────
  private embed: boolean;
  private embedDegraded = false;                     // auto-degraded on a too-large tree
  private embedFiles = new Map<string, string>();    // rel → content awaiting embed
  private embedNodes = new Map<string, FunctionNode>(); // id → node awaiting embed
  private embedTimer?: ReturnType<typeof setTimeout>;
  private embedRunning = false;
  private lastEmbedContext?: CachedContext;

  constructor(options: McpWatcherOptions) {
    this.rootPath   = options.rootPath;
    this.outputPath = options.outputPath
      ?? join(options.rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    this.contextPath = join(this.outputPath, ARTIFACT_LLM_CONTEXT);
    this.debounceMs  = options.debounceMs ?? WATCH_DEBOUNCE_MS;
    this.maxBatchMs  = options.maxBatchMs ?? WATCH_MAX_BATCH_MS;
    this.bulkThreshold = options.bulkThreshold ?? WATCH_BULK_THRESHOLD;
    this.embedFileCeiling = options.embedFileCeiling ?? WATCH_EMBED_FILE_CEILING;
    this.embed       = options.embed ?? true;
    this.extraIgnore = options.ignore ?? [];
    this.debug       = !!process.env.OPENLORE_WATCH_DEBUG;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Auto-degrade live embedding on very large trees (Step 4). Counting is
    // bounded — it stops as soon as the ceiling is exceeded.
    if (this.embed) {
      const count = await this.countSourceFiles(this.embedFileCeiling + 1);
      if (count > this.embedFileCeiling) {
        this.embedDegraded = true;
        process.stderr.write(
          `[mcp-watcher] ${count}+ source files exceed the live-embed ceiling ` +
          `(${this.embedFileCeiling}); running signatures-only — embeddings refresh at commit\n`
        );
      }
    }

    await new Promise<void>((resolve, reject) => {
      const extraIgnore = this.extraIgnore;
      const rootPath = this.rootPath;
      this.fsWatcher = chokidar.watch(rootPath, {
        // Resolve each candidate to a root-relative path first, then prune by
        // directory name. This prunes the ignored directory itself (chokidar
        // never opens FDs inside it — the EMFILE fix) without false-matching on
        // parent path components above the watch root.
        ignored: (filePath: string) => {
          const rel = relative(rootPath, filePath);
          return isIgnoredRelPath(rel) || extraIgnore.some((p) => rel.includes(p));
        },
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      });

      this.fsWatcher.on('change', (absPath: string) => {
        if (SOURCE_EXTENSIONS.test(absPath)) {
          this.enqueue(absPath);
        }
      });

      this.fsWatcher.on('ready', () => resolve());
      this.fsWatcher.on('error', (err: unknown) => reject(err));
    });

    // Best-effort VCS-flood detection (Step 5): a branch switch / rebase / merge
    // bumps these refs. We never recurse into .git (it stays ignored above); we
    // watch only these specific files, then collapse the churn into one refresh.
    try {
      const gitDir = join(this.rootPath, '.git');
      const refs = ['HEAD', 'index', 'MERGE_HEAD', 'ORIG_HEAD'].map((f) => join(gitDir, f));
      this.gitWatcher = chokidar.watch(refs, {
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
      });
      this.gitWatcher.on('all', () => this.onVcsEvent());
    } catch {
      // no .git, or watch failed — VCS detection falls back to the batch-size
      // threshold in handleBatch, which is enough for G3.
    }

    process.stderr.write(
      `[mcp-watcher] watching ${this.rootPath}` +
      `${this.embed && !this.embedDegraded ? '' : ' (signatures-only)'}\n`
    );
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxBatchTimer) clearTimeout(this.maxBatchTimer);
    if (this.embedTimer) clearTimeout(this.embedTimer);
    this.debounceTimer = this.maxBatchTimer = this.embedTimer = undefined;
    // Best-effort: persist anything still queued so a save right before shutdown
    // is not lost.
    if (this.pending.size > 0 && !this.running) {
      const batch = Array.from(this.pending);
      this.pending.clear();
      try { await this.handleBatch(batch, { syncFlush: true }); } catch { /* ignore */ }
    }
    await this.fsWatcher?.close();
    await this.gitWatcher?.close();
    process.stderr.write('[mcp-watcher] stopped\n');
  }

  // ── Coalescing (Step 1) ──────────────────────────────────────────────────────

  /**
   * Add a changed path to the pending set and (re)arm a single debounce timer,
   * plus a one-shot hard ceiling so a continuous stream still flushes.
   */
  private enqueue(absPath: string): void {
    this.pending.add(absPath);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs);
    if (!this.maxBatchTimer) {
      this.maxBatchTimer = setTimeout(() => this.flush(), this.maxBatchMs);
    }
  }

  /** A .git ref changed — settle, then flush whatever changed as one bulk batch. */
  private onVcsEvent(): void {
    this.vcsBulkFlag = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), WATCH_VCS_SETTLE_MS);
    if (this.debug) {
      process.stderr.write('[mcp-watcher] VCS operation detected — coalescing into one refresh\n');
    }
  }

  /**
   * Drain the pending set into a single batch. Single-flight: if a flush is
   * already running, leave the new paths in `pending` and reschedule once it
   * finishes — never interleave two flushes.
   */
  private flush(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    if (this.maxBatchTimer) { clearTimeout(this.maxBatchTimer); this.maxBatchTimer = undefined; }
    if (this.running) return;            // a follow-up is scheduled in finally{}
    if (this.pending.size === 0) return;

    const batch = Array.from(this.pending);
    this.pending.clear();
    this.running = true;
    this.handleBatch(batch)
      .catch((err) => process.stderr.write(`[mcp-watcher] error: ${(err as Error).message}\n`))
      .finally(() => {
        this.running = false;
        if (this.pending.size > 0) {
          this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs);
        }
      });
  }

  // ── Core re-index ──────────────────────────────────────────────────────────

  /**
   * Re-index a single changed file. Exposed for unit testing without needing a
   * real file watcher; flushes synchronously so callers observe the update on
   * disk immediately. Internally this is just a batch of one.
   */
  async handleChange(absPath: string): Promise<void> {
    await this.handleBatch([absPath], { syncFlush: true });
  }

  /**
   * Process a coalesced batch of changed files as ONE pipeline pass:
   *   • per-file incremental edge update (content-hash skip), all under one open
   *     EdgeStore;
   *   • ONE signature patch + ONE llm-context persist + ONE read-cache handoff;
   *   • ONE vector update (inline when syncFlush, else on the embed lane).
   */
  private async handleBatch(absPaths: string[], opts: { syncFlush?: boolean } = {}): Promise<void> {
    const t0 = Date.now();
    const consumedVcsBulk = this.vcsBulkFlag;
    this.vcsBulkFlag = false;

    // 1. Resolve + read candidate files (skip tests / unknown langs / deleted).
    const files: Array<{ rel: string; abs: string; content: string }> = [];
    for (const abs of absPaths) {
      const rel = relative(this.rootPath, abs);
      if (isTestFile(rel)) continue;
      if (detectLanguage(rel) === 'unknown') continue;
      let content: string;
      try {
        content = await readFile(abs, 'utf-8');
      } catch {
        continue; // file may have been deleted between the event and now
      }
      files.push({ rel, abs, content });
    }
    if (files.length === 0) return;

    // 2. Incremental edge update (CGC _handle_modification algorithm), one open
    //    store for the whole batch. Content-hash skip drops no-op autosaves.
    const changedFiles: ChangedFile[] = [];
    const changedNodes: FunctionNode[] = [];
    if (EdgeStore.exists(this.outputPath)) {
      const store = EdgeStore.open(EdgeStore.dbPath(this.outputPath));
      try {
        // Schema-bump guard: opening a stale-version DB wipes it (rebuild-on-bump).
        // An incremental per-file update on a wiped store would leave a PARTIAL graph
        // (only the changed file's nodes). Skip it — a full `analyze` must rebuild.
        if (store.wasReset) {
          process.stderr.write(
            '[mcp-watcher] graph index was reset by a schema-version upgrade — scheduling a background rebuild. ' +
            'Skipping incremental update to avoid a partial graph.\n'
          );
          this.scheduleBackgroundRebuild();
        }
        for (const f of files) {
          if (store.wasReset) break;
          const newHash = createHash('sha256').update(f.content).digest('hex');
          if (store.getFileHash(f.rel) === newHash) continue; // no-op autosave

          // Reverse lookup BEFORE delete so we know which files call into this one.
          const callerFiles = store.getCallerFiles(f.rel);
          // Re-parse BEFORE mutating DB — graph stays readable (old state) during
          // parse. Seed resolution with all known nodes so re-parsed callers'
          // cross-file calls don't degrade to `external::`.
          const resolutionNodes = store.getAllInternalNodes();
          const { edges: newEdges, nodes: newNodes } =
            await buildGraphSubset(f.rel, f.content, callerFiles, this.rootPath, resolutionNodes);

          // Atomic swap so concurrent MCP reads never see a torn graph.
          store.transaction(() => {
            store.deleteEdgesForFile(f.rel);
            for (const cf of callerFiles.slice(0, CALLER_REPARSE_LIMIT)) {
              store.deleteOutgoingEdgesForFile(cf);
            }
            store.deleteNodesForFile(f.rel);
            store.insertNodes(newNodes);
            store.insertEdges(newEdges);
            store.setFileHash(f.rel, newHash);
          });

          changedFiles.push({ rel: f.rel, content: f.content });
          for (const n of newNodes) changedNodes.push(n);
          if (this.debug) {
            process.stderr.write(
              `[mcp-watcher] graph: ${f.rel} (+${newNodes.length} nodes, +${newEdges.length} edges, ${callerFiles.length} callers)\n`
            );
          }
        }
      } finally {
        store.close();
      }
    } else {
      // No edge store yet — still refresh signatures for every candidate.
      for (const f of files) changedFiles.push({ rel: f.rel, content: f.content });
    }

    if (changedFiles.length === 0) return; // every event was a no-op autosave

    // 3. Signatures: load context (shared in-memory cache), patch all changed
    //    files, then ONE persist + read-cache handoff (Step 2). The handoff
    //    means the next tool call is a cache HIT — no cold 2.1 MB re-parse.
    const context = await this.loadContext();
    if (!context) {
      process.stderr.write(`[mcp-watcher] no context at ${this.contextPath} — run analyze first\n`);
      return;
    }
    if (!context.signatures) context.signatures = [];
    for (const f of changedFiles) {
      const newMap = extractSignatures(f.rel, f.content);
      const idx = context.signatures.findIndex((m) => m.path === f.rel);
      if (idx >= 0) context.signatures[idx] = newMap;
      else context.signatures.push(newMap);
    }
    await this.persistContext(context);

    // 4. Vector update — decoupled from signature freshness (Step 4).
    const isBulk = consumedVcsBulk || changedFiles.length >= this.bulkThreshold;
    if (this.embed && !this.embedDegraded && context.callGraph) {
      if (opts.syncFlush) {
        // Direct handleChange path: inline so callers/tests observe it.
        await this.updateVectors(context, changedFiles, changedNodes);
      } else {
        // Watcher path: schedule on the lower-priority embed lane. On a bulk
        // event this still collapses to a single deferred pass.
        this.scheduleEmbed(context, changedFiles, changedNodes);
      }
    }

    // 5. One summary line per batch (Step 6). Per-file detail is behind debug.
    const n = changedFiles.length;
    process.stderr.write(
      `[mcp-watcher] ${isBulk ? `coalesced ${n} changes` : `updated ${n} file${n === 1 ? '' : 's'}`} (${Date.now() - t0}ms)\n`
    );
  }

  /**
   * Self-heal a schema-reset graph by spawning one detached `analyze --force`
   * (BM25-only, no network). Runs at most once per process (`backgroundRebuild
   * Triggered`); a spawn failure logs and falls back to the existing "run
   * analyze" note rather than retrying — no thundering herd, no loop (B10).
   */
  private scheduleBackgroundRebuild(): void {
    if (backgroundRebuildTriggered) return;
    backgroundRebuildTriggered = true;
    const cli = process.argv[1];
    if (!cli) {
      process.stderr.write('[mcp-watcher] cannot locate the openlore CLI to auto-rebuild — run "openlore analyze".\n');
      return;
    }
    try {
      const child = spawn(
        process.execPath,
        [cli, 'analyze', '--force', '--no-embed', '--output', this.outputPath],
        { cwd: this.rootPath, stdio: 'ignore', detached: true }
      );
      child.on('error', (err) => {
        process.stderr.write(`[mcp-watcher] background rebuild failed to start (${err.message}) — run "openlore analyze".\n`);
      });
      child.unref();
      process.stderr.write('[mcp-watcher] background "openlore analyze --force" started; the graph will self-heal shortly.\n');
    } catch (err) {
      process.stderr.write(`[mcp-watcher] background rebuild could not be spawned (${(err as Error).message}) — run "openlore analyze".\n`);
    }
  }

  // ── llm-context load + persistence + read-cache handoff (Step 2) ─────────────

  /**
   * True when this watcher writes to the canonical `<root>/.openlore/analysis`
   * layout that the MCP read handlers cache against. Only then is the shared
   * in-memory read cache (primeContextCache) the right channel to prime; a custom
   * `outputPath` (tests / non-standard installs) writes only to disk.
   */
  private get usesStandardLayout(): boolean {
    return this.outputPath === join(this.rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  }

  /**
   * Load the context the watcher is about to patch. This ALWAYS reads fresh from
   * disk — never through the shared read cache — because the cache is a read-path
   * (tool-call) optimization, and patching a possibly-stale cached object could
   * silently drop signatures written by a concurrent `analyze` between events.
   * The writer reads ground truth; persistContext then primes the read cache with
   * the result so the next tool call is still a hit (Step 2a, G1).
   */
  private async loadContext(): Promise<CachedContext | null> {
    try {
      const raw = await readFile(this.contextPath, 'utf-8');
      return JSON.parse(raw) as CachedContext;
    } catch {
      return null;
    }
  }

  private async persistContext(context: CachedContext): Promise<void> {
    // Strip the runtime-only EdgeStore handle before serializing.
    const { edgeStore: _edgeStore, ...serializable } = context as CachedContext & { edgeStore?: unknown };
    void _edgeStore;
    await writeFile(this.contextPath, JSON.stringify(serializable, null, 2), 'utf-8');
    // Hand the patched object back to the read cache, aligned to the new on-disk
    // mtime, so the next tool call is a cache hit (no cold re-parse). This is the
    // fix for root-cause item 2 (mtime bump forcing a full re-read). Only valid
    // for the canonical layout the read handlers cache against.
    if (this.usesStandardLayout) await primeContextCache(this.rootPath, context);
  }

  // ── Embedding lane (Step 4) ──────────────────────────────────────────────────

  private scheduleEmbed(context: CachedContext, changedFiles: ChangedFile[], nodes: FunctionNode[]): void {
    for (const f of changedFiles) this.embedFiles.set(f.rel, f.content);
    for (const node of nodes) this.embedNodes.set(node.id, node);
    this.lastEmbedContext = context;
    if (this.embedTimer) clearTimeout(this.embedTimer);
    // Slightly behind the signature debounce so structural freshness always lands
    // first and multiple flushes batch into one embed pass.
    this.embedTimer = setTimeout(() => void this.runEmbedLane(), this.debounceMs);
  }

  private async runEmbedLane(): Promise<void> {
    if (this.embedRunning) {
      // Re-arm: drain again once the in-flight pass finishes.
      this.embedTimer = setTimeout(() => void this.runEmbedLane(), this.debounceMs);
      return;
    }
    if (this.embedFiles.size === 0 || !this.lastEmbedContext) return;
    const changedFiles: ChangedFile[] = Array.from(this.embedFiles, ([rel, content]) => ({ rel, content }));
    const nodes = Array.from(this.embedNodes.values());
    const context = this.lastEmbedContext;
    this.embedFiles.clear();
    this.embedNodes.clear();
    this.embedRunning = true;
    try {
      await this.updateVectors(context, changedFiles, nodes);
    } catch (err) {
      process.stderr.write(`[mcp-watcher] embed error: ${(err as Error).message}\n`);
    } finally {
      this.embedRunning = false;
      if (this.embedFiles.size > 0) {
        this.embedTimer = setTimeout(() => void this.runEmbedLane(), this.debounceMs);
      }
    }
  }

  /**
   * Row-level vector update for the changed files only (Step 3). Falls back to a
   * silent no-op when no embedding service and no index are available.
   */
  private async updateVectors(context: CachedContext, changedFiles: ChangedFile[], changedNodes: FunctionNode[]): Promise<void> {
    try {
      const { VectorIndex } = await import('../analyzer/vector-index.js');
      const { EmbeddingService } = await import('../analyzer/embedding-service.js');
      const { readOpenLoreConfig } = await import('./config-manager.js');

      if (!VectorIndex.exists(this.outputPath)) return;

      let embedSvc: InstanceType<typeof EmbeddingService> | null;
      try {
        embedSvc = EmbeddingService.fromEnv();
      } catch {
        const cfg = await readOpenLoreConfig(this.rootPath);
        embedSvc = cfg ? EmbeddingService.fromConfig(cfg) : null;
      }
      // embedSvc may be null: updateFiles then refreshes the BM25-only corpus
      // rather than re-embedding, keeping the keyword index live in watch mode.

      const cg = context.callGraph;
      if (!cg) return;
      const hubIds = new Set((cg.hubFunctions ?? []).map((f) => f.id));
      const entryIds = new Set((cg.entryPoints ?? []).map((f) => f.id));
      const changedFilePaths = new Set(changedFiles.map((f) => f.rel));
      const fileContents = new Map(changedFiles.map((f) => [f.rel, f.content]));
      // Prefer the freshly-parsed nodes; fall back to the (possibly stale)
      // call-graph nodes for the changed files when no edge store seeded them.
      const nodes = changedNodes.length > 0
        ? changedNodes
        : (cg.nodes ?? []).filter((n) => changedFilePaths.has(n.filePath));

      const { embedded, reused, total, hasEmbeddings } = await VectorIndex.updateFiles(
        this.outputPath,
        nodes,
        changedFilePaths,
        context.signatures ?? [],
        hubIds,
        entryIds,
        embedSvc,
        fileContents,
      );

      if (this.debug) {
        process.stderr.write(
          hasEmbeddings
            ? `[mcp-watcher] re-embedded ${changedFilePaths.size} file(s): ${embedded} new, ${reused} reused\n`
            : `[mcp-watcher] refreshed BM25 index for ${changedFilePaths.size} file(s): ${total} functions\n`
        );
      }
    } catch (err) {
      process.stderr.write(`[mcp-watcher] embed error: ${(err as Error).message}\n`);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Bounded count of watched source files; stops early once `cap` is exceeded. */
  private async countSourceFiles(cap: number): Promise<number> {
    let count = 0;
    const walk = async (dir: string): Promise<void> => {
      if (count > cap) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (count > cap) return;
        const abs = join(dir, entry.name);
        const rel = relative(this.rootPath, abs);
        if (entry.isDirectory()) {
          if (!isIgnoredRelPath(rel)) await walk(abs);
        } else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name) && !isIgnoredRelPath(rel)) {
          count++;
        }
      }
    };
    await walk(this.rootPath);
    return count;
  }
}

// ── Module helpers ──────────────────────────────────────────────────────────────

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes('.test.') ||
    relPath.includes('.spec.') ||
    relPath.includes('__tests__')
  );
}

/**
 * Re-parse changedFile + up to CALLER_REPARSE_LIMIT callerFiles.
 * Returns fresh edges (all files in subset) and nodes (changedFile only —
 * callerFiles nodes are untouched since their function signatures didn't change).
 */
async function buildGraphSubset(
  changedRel: string,
  changedContent: string,
  callerFiles: string[],
  rootDir: string,
  resolutionNodes?: import('../analyzer/call-graph.js').FunctionNode[],
): Promise<{
  edges: import('../analyzer/call-graph.js').CallEdge[];
  nodes: import('../analyzer/call-graph.js').FunctionNode[];
}> {
  const lang = detectLanguage(changedRel);
  if (!CALL_GRAPH_LANGS.has(lang)) return { edges: [], nodes: [] };

  const { CallGraphBuilder } = await import('../analyzer/call-graph.js');
  // Use relative paths as node IDs (consistent with analyze output)
  const files: Array<{ path: string; content: string; language: string }> = [
    { path: changedRel, content: changedContent, language: lang },
  ];

  for (const cf of callerFiles.slice(0, CALLER_REPARSE_LIMIT)) {
    const cfLang = detectLanguage(cf);
    if (!CALL_GRAPH_LANGS.has(cfLang)) continue;
    try {
      const cfContent = await readFile(join(rootDir, cf), 'utf-8');
      files.push({ path: cf, content: cfContent, language: cfLang });
    } catch {
      // skip unreadable files
    }
  }

  const builder = new CallGraphBuilder();
  const result = await builder.build(files, undefined, undefined, resolutionNodes);

  // Only return nodes from changedFile — callerFiles nodes are already in DB and unchanged
  const changedNodes = Array.from(result.nodes.values()).filter((n) => n.filePath === changedRel);

  return { edges: result.edges, nodes: changedNodes };
}
