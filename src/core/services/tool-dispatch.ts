/**
 * Shared tool dispatch — single source of truth mapping a tool name + args to its
 * handler. Consumed by BOTH transports:
 *   - the stdio MCP server (`src/cli/commands/mcp.ts`)
 *   - the local HTTP daemon (`src/cli/commands/serve.ts`)
 *
 * Keeping one dispatch table here prevents the two transports from drifting as
 * handlers are added or their signatures change. This function is intentionally
 * pure: it resolves args → handler → result and nothing else. Transport concerns
 * (input validation, telemetry, epistemic/panic tracking, output truncation) stay
 * in the caller.
 *
 * `directory` is passed explicitly (already resolved from `args.directory` by the
 * caller) but most branches re-read it from `args` to preserve the exact behaviour
 * the MCP server had before this extraction.
 */

import { DEFAULT_DRIFT_MAX_FILES } from '../../constants.js';
import type { DecisionScope } from '../../types/index.js';

import { handleOrient } from './mcp-handlers/orient.js';
import { handleSelectTests } from './mcp-handlers/test-impact.js';
import { handleFindDeadCode } from './mcp-handlers/reachability.js';
import { handleStructuralDiff } from './mcp-handlers/structural-diff.js';
import { handleGetChangeCoupling } from './mcp-handlers/change-coupling.js';
import { handleGetHealthMap } from './mcp-handlers/health-map.js';
import { handleGetLandmarks } from './mcp-handlers/landmarks.js';
import { handleGetMap } from './mcp-handlers/map.js';
import { handleFindPath } from './mcp-handlers/pathfind.js';
import { handleCheckArchitecture } from './mcp-handlers/architecture.js';
import { handleGenerateChangeProposal, handleAnnotateStory } from './mcp-handlers/change.js';
import {
  handleGetCallGraph,
  handleGetSubgraph,
  handleAnalyzeImpact,
  handleGetLowRiskRefactorCandidates,
  handleGetLeafFunctions,
  handleGetCriticalHubs,
  handleGetGodFunctions,
  handleGetFileDependencies,
  handleTraceExecutionPath,
} from './mcp-handlers/graph.js';
import {
  handleSearchCode,
  handleSuggestInsertionPoints,
  handleSearchSpecs,
  handleListSpecDomains,
  handleGetSpec,
  handleUnifiedSearch,
} from './mcp-handlers/semantic.js';
import {
  handleRecordDecision,
  handleListDecisions,
  handleApproveDecision,
  handleRejectDecision,
  handleSyncDecisions,
} from './mcp-handlers/decisions.js';
import {
  handleAnalyzeCodebase,
  handleGetArchitectureOverview,
  handleGetRefactorReport,
  handleGetDuplicateReport,
  handleGetSignatures,
  handleGetMapping,
  handleCheckSpecDrift,
  handleGetFunctionSkeleton,
  handleGetFunctionBody,
  handleGetDecisions,
  handleGetRouteInventory,
  handleGetMiddlewareInventory,
  handleGetSchemaInventory,
  handleGetUIComponents,
  handleGetEnvVars,
  handleGetExternalPackages,
  handleAuditSpecCoverage,
  handleGenerateTests,
  handleGetTestCoverage,
  handleGetMinimalContext,
  handleGetCluster,
  handleDetectChanges,
} from './mcp-handlers/analysis.js';

/** Thrown when a tool name has no registered handler. Callers map this to their
 * transport's "unknown tool" response (isError result / HTTP 404). */
export class UnknownToolError extends Error {
  constructor(public readonly toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = 'UnknownToolError';
  }
}

/**
 * Resolve a tool call to its result. Throws {@link UnknownToolError} for an
 * unregistered name; propagates any handler error unchanged.
 *
 * Note on `directory`: most branches destructure `const { directory } = args`
 * which shadows the top-level param. This is intentional — it preserves the
 * exact pre-extraction behaviour where handlers read directory from args. The
 * top-level param is used only by handlers that don't re-destructure (orient,
 * search_code, suggest_insertion_points). Callers must ensure args.directory
 * and the directory param are the same resolved path.
 */
export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  directory: string,
): Promise<unknown> {
  if (name === 'orient') {
    const { task, limit = 5, tokenBudget, lean } = args as { task: string; limit?: number; tokenBudget?: number; lean?: boolean };
    return handleOrient(directory, task, limit, tokenBudget, lean);
  } else if (name === 'analyze_codebase') {
    const { directory, force = false } = args as { directory: string; force?: boolean };
    return handleAnalyzeCodebase(directory, force);
  } else if (name === 'get_architecture_overview') {
    const { directory } = args as { directory: string };
    return handleGetArchitectureOverview(directory);
  } else if (name === 'get_refactor_report') {
    const { directory } = args as { directory: string };
    return handleGetRefactorReport(directory);
  } else if (name === 'get_call_graph') {
    const { directory } = args as { directory: string };
    return handleGetCallGraph(directory);
  } else if (name === 'get_signatures') {
    const { directory, filePattern } = args as { directory: string; filePattern?: string };
    return handleGetSignatures(directory, filePattern);
  } else if (name === 'get_subgraph') {
    const { directory, functionName, direction = 'downstream', maxDepth = 3, format = 'json' } =
      args as { directory: string; functionName: string; direction?: 'downstream' | 'upstream' | 'both'; maxDepth?: number; format?: 'json' | 'mermaid' };
    return handleGetSubgraph(directory, functionName, direction, maxDepth, format);
  } else if (name === 'trace_execution_path') {
    const { directory, entryFunction, targetFunction, maxDepth = 6, maxPaths = 10 } =
      args as { directory: string; entryFunction: string; targetFunction: string; maxDepth?: number; maxPaths?: number };
    return handleTraceExecutionPath(directory, entryFunction, targetFunction, maxDepth, maxPaths);
  } else if (name === 'get_mapping') {
    const { directory, domain, orphansOnly } = args as { directory: string; domain?: string; orphansOnly?: boolean };
    return handleGetMapping(directory, domain, orphansOnly);
  } else if (name === 'analyze_impact') {
    const { directory, symbol, depth = 2 } =
      args as { directory: string; symbol: string; depth?: number };
    return handleAnalyzeImpact(directory, symbol, depth);
  } else if (name === 'select_tests') {
    const { directory, changedSymbols, diffRef, maxDepth } =
      args as { directory: string; changedSymbols?: string[]; diffRef?: string; maxDepth?: number };
    return handleSelectTests({ directory, changedSymbols, diffRef, maxDepth });
  } else if (name === 'find_dead_code') {
    const { directory, ifDeleted, maxResults, filePattern } =
      args as { directory: string; ifDeleted?: string; maxResults?: number; filePattern?: string };
    return handleFindDeadCode({ directory, ifDeleted, maxResults, filePattern });
  } else if (name === 'structural_diff') {
    const { directory, baseRef, headRef, maxResults } =
      args as { directory: string; baseRef?: string; headRef?: string; maxResults?: number };
    return handleStructuralDiff({ directory, baseRef, headRef, maxResults });
  } else if (name === 'get_change_coupling') {
    const { directory, file, limit } = args as { directory: string; file?: string; limit?: number };
    return handleGetChangeCoupling({ directory, file, limit });
  } else if (name === 'check_architecture') {
    const { directory, from, to } = args as { directory: string; from?: string; to?: string };
    return handleCheckArchitecture({ directory, from, to });
  } else if (name === 'get_low_risk_refactor_candidates') {
    const { directory, limit = 5, filePattern } =
      args as { directory: string; limit?: number; filePattern?: string };
    return handleGetLowRiskRefactorCandidates(directory, limit, filePattern);
  } else if (name === 'get_leaf_functions') {
    const { directory, limit = 20, filePattern, sortBy = 'fanIn' } =
      args as { directory: string; limit?: number; filePattern?: string; sortBy?: 'fanIn' | 'name' | 'file' };
    return handleGetLeafFunctions(directory, limit, filePattern, sortBy);
  } else if (name === 'get_critical_hubs') {
    const { directory, limit = 10, minFanIn = 3 } =
      args as { directory: string; limit?: number; minFanIn?: number };
    return handleGetCriticalHubs(directory, limit, minFanIn);
  } else if (name === 'get_duplicate_report') {
    const { directory } = args as { directory: string };
    return handleGetDuplicateReport(directory);
  } else if (name === 'get_function_skeleton') {
    const { directory, filePath } = args as { directory: string; filePath: string };
    return handleGetFunctionSkeleton(directory, filePath);
  } else if (name === 'get_god_functions') {
    const { directory, filePath, fanOutThreshold = 8 } =
      args as { directory: string; filePath?: string; fanOutThreshold?: number };
    return handleGetGodFunctions(directory, filePath, fanOutThreshold);
  } else if (name === 'check_spec_drift') {
    const { directory, base = 'auto', files = [], domains = [], failOn = 'warning', maxFiles = DEFAULT_DRIFT_MAX_FILES } =
      args as { directory: string; base?: string; files?: string[]; domains?: string[]; failOn?: 'error' | 'warning' | 'info'; maxFiles?: number };
    return handleCheckSpecDrift(directory, base, files, domains, failOn, maxFiles);
  } else if (name === 'search_code') {
    const { directory, query, limit = 10, language, minFanIn, tokenBudget } =
      args as { directory: string; query: string; limit?: number; language?: string; minFanIn?: number; tokenBudget?: number };
    return handleSearchCode(directory, query, limit, language, minFanIn, tokenBudget);
  } else if (name === 'suggest_insertion_points') {
    const { directory, description, limit = 5, language } =
      args as { directory: string; description: string; limit?: number; language?: string };
    return handleSuggestInsertionPoints(directory, description, limit, language);
  } else if (name === 'search_specs') {
    const { directory, query, limit = 10, domain, section } =
      args as { directory: string; query: string; limit?: number; domain?: string; section?: string };
    return handleSearchSpecs(directory, query, limit, domain, section);
  } else if (name === 'search_unified') {
    const { directory, query, limit = 10, language, domain, section } =
      args as { directory: string; query: string; limit?: number; language?: string; domain?: string; section?: string };
    return handleUnifiedSearch(directory, query, limit, language, domain, section);
  } else if (name === 'list_spec_domains') {
    const { directory } = args as { directory: string };
    return handleListSpecDomains(directory);
  } else if (name === 'get_spec') {
    const { directory, domain } = args as { directory: string; domain: string };
    return handleGetSpec(directory, domain);
  } else if (name === 'get_function_body') {
    const { directory, filePath, functionName } =
      args as { directory: string; filePath: string; functionName: string };
    return handleGetFunctionBody(directory, filePath, functionName);
  } else if (name === 'get_file_dependencies') {
    const { directory, filePath, direction = 'both' } =
      args as { directory: string; filePath: string; direction?: 'imports' | 'importedBy' | 'both' };
    return handleGetFileDependencies(directory, filePath, direction);
  } else if (name === 'generate_change_proposal') {
    const { directory, description, slug, storyContent } =
      args as { directory: string; description: string; slug: string; storyContent?: string };
    return handleGenerateChangeProposal(directory, description, slug, storyContent);
  } else if (name === 'annotate_story') {
    const { directory, storyFilePath, description } =
      args as { directory: string; storyFilePath: string; description: string };
    return handleAnnotateStory(directory, storyFilePath, description);
  } else if (name === 'get_decisions') {
    const { directory, query } = args as { directory: string; query?: string };
    return handleGetDecisions(directory, query);
  } else if (name === 'get_route_inventory') {
    const { directory } = args as { directory: string };
    return handleGetRouteInventory(directory);
  } else if (name === 'get_middleware_inventory') {
    const { directory } = args as { directory: string };
    return handleGetMiddlewareInventory(directory);
  } else if (name === 'get_schema_inventory') {
    const { directory } = args as { directory: string };
    return handleGetSchemaInventory(directory);
  } else if (name === 'get_ui_components') {
    const { directory } = args as { directory: string };
    return handleGetUIComponents(directory);
  } else if (name === 'get_env_vars') {
    const { directory } = args as { directory: string };
    return handleGetEnvVars(directory);
  } else if (name === 'get_external_packages') {
    const { directory } = args as { directory: string };
    return handleGetExternalPackages(directory);
  } else if (name === 'audit_spec_coverage') {
    const { directory, maxUncovered = 50, hubThreshold = 5 } =
      args as { directory: string; maxUncovered?: number; hubThreshold?: number };
    return handleAuditSpecCoverage(directory, maxUncovered, hubThreshold);
  } else if (name === 'generate_tests') {
    const { directory, domains, framework, useLlm, dryRun } =
      args as {
        directory: string;
        domains?: string[];
        framework?: string;
        useLlm?: boolean;
        dryRun?: boolean;
      };
    return handleGenerateTests({ directory, domains, framework, useLlm, dryRun });
  } else if (name === 'get_test_coverage') {
    const { directory, domains, minCoverage } =
      args as { directory: string; domains?: string[]; minCoverage?: number };
    return handleGetTestCoverage({ directory, domains, minCoverage });
  } else if (name === 'get_minimal_context') {
    const { directory, functionName, filePath } =
      args as { directory: string; functionName: string; filePath?: string };
    return handleGetMinimalContext(directory, functionName, filePath);
  } else if (name === 'get_cluster') {
    const { directory, functionName } = args as { directory: string; functionName: string };
    return handleGetCluster(directory, functionName);
  } else if (name === 'get_landmarks') {
    const { directory, limit, label } = args as { directory: string; limit?: number; label?: string };
    return handleGetLandmarks(directory, { limit, label });
  } else if (name === 'get_map') {
    const { directory, communityId } = args as { directory: string; communityId?: string };
    return handleGetMap(directory, communityId);
  } else if (name === 'find_path') {
    const { directory, from, to, useCallDistance } = args as { directory: string; from: string; to: string; useCallDistance?: boolean };
    return handleFindPath(directory, from, to, { useCallDistance });
  } else if (name === 'detect_changes') {
    const { directory, base } = args as { directory: string; base?: string };
    return handleDetectChanges(directory, base);
  } else if (name === 'get_health_map') {
    const { directory, limit } = args as { directory: string; limit?: number };
    return handleGetHealthMap({ directory, limit });
  } else if (name === 'record_decision') {
    const { directory, title, rationale, consequences, affectedFiles, supersedes, scope } =
      args as { directory: string; title: string; rationale: string; consequences?: string; affectedFiles?: string[]; supersedes?: string; scope?: DecisionScope };
    return handleRecordDecision(directory, title, rationale, consequences, affectedFiles, supersedes, scope);
  } else if (name === 'list_decisions') {
    const { directory, status } = args as { directory: string; status?: string };
    return handleListDecisions(directory, status);
  } else if (name === 'approve_decision') {
    const { directory, id, note } = args as { directory: string; id: string; note?: string };
    return handleApproveDecision(directory, id, note);
  } else if (name === 'reject_decision') {
    const { directory, id, note } = args as { directory: string; id: string; note?: string };
    return handleRejectDecision(directory, id, note);
  } else if (name === 'sync_decisions') {
    const { directory, dryRun = false, id } = args as { directory: string; dryRun?: boolean; id?: string };
    return handleSyncDecisions(directory, dryRun, id);
  }
  throw new UnknownToolError(name);
}
