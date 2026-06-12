/**
 * Intra-procedural control-flow & data-flow overlay (spec: add-intraprocedural-cfg-dataflow-overlay).
 *
 * Builds, per function and purely from AST shape (no types, no inference, no LLM):
 *   1. a control-flow graph (CFG): basic blocks + the edges induced by branches,
 *      loops, early exits (return/break/continue/throw), computed while the parse
 *      tree is live (parse trees are freed before later analysis passes);
 *   2. a reaching-definitions (def-use) overlay over that CFG: a deterministic
 *      fixpoint producing data-dependence edges from each definition site to each
 *      use it reaches without an intervening reassignment.
 *
 * Every data-dependence edge carries a precision label: `exact` for a sound
 * local-scalar def-use, `may` for a conservatively over-approximated dependence
 * (object field, array/dict element, closure capture). The cross-call `may` hop
 * is synthesized by the value-level consumer, not here — this overlay is strictly
 * intra-procedural.
 *
 * The returned {@link FunctionCfg} holds ONLY primitive data (numbers, strings):
 * no AST node references survive the call, so it is WASM-tree-lifetime safe and
 * trivially serializable to the disposable SQLite store.
 *
 * Modeled on the Elixir `walk` closure precedent in call-graph.ts — the first
 * real statement-level AST visitor in the analyzer.
 */

/** Precision provenance of a single data-dependence edge. */
export type DataFlowPrecision = 'exact' | 'may';

/** Kind of a basic block, for branch/loop/exit classification. */
export type CfgBlockKind = 'entry' | 'exit' | 'normal' | 'branch' | 'loop' | 'merge';

/** Kind of a control-flow edge between two blocks. */
export type CfgEdgeKind = 'normal' | 'true' | 'false' | 'back' | 'exit';

export interface CfgBlock {
  /** Index into FunctionCfg.blocks; stable within one CFG. */
  id: number;
  kind: CfgBlockKind;
}

export interface CfgEdge {
  from: number;
  to: number;
  kind: CfgEdgeKind;
}

/**
 * A data-dependence (def-use) edge: the value assigned to `variable` at line
 * `defLine` reaches the read at line `useLine` without an intervening
 * reassignment. `precision` is a deterministic property of the analysis.
 */
export interface DefUseEdge {
  variable: string;
  defLine: number;
  useLine: number;
  precision: DataFlowPrecision;
}

/** Compact per-function overlay record. Pure data — no AST nodes retained. */
export interface FunctionCfg {
  blocks: CfgBlock[];
  edges: CfgEdge[];
  /** Reaching-definitions def-use edges over the CFG. */
  defUse: DefUseEdge[];
  /** Parameter names, treated as definitions at function entry. */
  params: string[];
  /** 1-based line at which parameters are considered defined (function start). */
  paramLine: number;
}

// ============================================================================
// MINIMAL AST NODE SHAPE
// ============================================================================

/**
 * Structural subset of tree-sitter's SyntaxNode used by the visitor. Native
 * `Parser.SyntaxNode` satisfies this; keeping it minimal avoids coupling to the
 * concrete parser type and keeps the visitor testable.
 */
export interface CfgNode {
  type: string;
  text: string;
  startPosition: { row: number };
  namedChildren: CfgNode[];
  children: CfgNode[];
  childForFieldName(field: string): CfgNode | null;
}

// ============================================================================
// PER-LANGUAGE GRAMMAR SPEC
// ============================================================================

interface CfgLangSpec {
  /** `if`-style branch node types. */
  ifTypes: Set<string>;
  /** Loop node types (while/for/range). */
  loopTypes: Set<string>;
  /** `try`/`catch`/`finally` node type (exception branch). */
  tryTypes: Set<string>;
  /** `switch`/`match` node type (multi-way branch). */
  switchTypes: Set<string>;
  /** Nested function/closure node types — not descended into as outer CFG; their
   *  free-variable reads become `may` (closure-capture) uses of the outer scope. */
  nestedFnTypes: Set<string>;
  /** True for C-style switch where a case without `break` falls into the next
   *  (TS/JS); false where each case auto-breaks (Go switch, Python match). */
  switchFallsThrough: boolean;
  /** Early-exit statement node types. */
  returnTypes: Set<string>;
  breakTypes: Set<string>;
  continueTypes: Set<string>;
  throwTypes: Set<string>;
  /** Statement-container (compound) node types whose children are statements. */
  blockTypes: Set<string>;
  /** Plain assignment node types (target = value). */
  assignTypes: Set<string>;
  /** Augmented assignment node types (target op= value) — target is both use+def. */
  augAssignTypes: Set<string>;
  /** Declaration-with-initializer node types (e.g. variable_declarator, short_var_declaration). */
  declTypes: Set<string>;
  /** Container node types that wrap one or more declarations (e.g. lexical_declaration). */
  declContainerTypes: Set<string>;
  /** Field-access node types — a write/read through these is a `may` dependence. */
  memberTypes: Set<string>;
  /** Subscript/index node types — a write/read through these is a `may` dependence. */
  subscriptTypes: Set<string>;
  /** Identifier node type for variable names. */
  identTypes: Set<string>;
  /** Call-expression node types (used to skip the callee name as a use). */
  callTypes: Set<string>;
  /** Field name for the condition of an if/loop, when present. */
  conditionField: string;
  /** Field names for an if's then / else branches. */
  consequenceField: string;
  alternativeField: string;
  /** Field name for a loop / function body. */
  bodyField: string;
  /** Field names for assignment left / right. */
  leftField: string;
  rightField: string;
  /** Field name for a function's parameter list. */
  paramsField: string;
}

const TS_SPEC: CfgLangSpec = {
  ifTypes: new Set(['if_statement']),
  loopTypes: new Set(['while_statement', 'for_statement', 'for_in_statement', 'do_statement']),
  tryTypes: new Set(['try_statement']),
  switchTypes: new Set(['switch_statement']),
  nestedFnTypes: new Set(['arrow_function', 'function_expression', 'function_declaration', 'generator_function', 'generator_function_declaration', 'method_definition']),
  switchFallsThrough: true,
  returnTypes: new Set(['return_statement']),
  breakTypes: new Set(['break_statement']),
  continueTypes: new Set(['continue_statement']),
  throwTypes: new Set(['throw_statement']),
  blockTypes: new Set(['statement_block']),
  assignTypes: new Set(['assignment_expression']),
  augAssignTypes: new Set(['augmented_assignment_expression']),
  declTypes: new Set(['variable_declarator']),
  declContainerTypes: new Set(['lexical_declaration', 'variable_declaration']),
  memberTypes: new Set(['member_expression']),
  subscriptTypes: new Set(['subscript_expression']),
  identTypes: new Set(['identifier', 'shorthand_property_identifier']),
  callTypes: new Set(['call_expression', 'new_expression']),
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  bodyField: 'body',
  leftField: 'left',
  rightField: 'right',
  paramsField: 'parameters',
};

const PY_SPEC: CfgLangSpec = {
  ifTypes: new Set(['if_statement']),
  loopTypes: new Set(['while_statement', 'for_statement']),
  tryTypes: new Set(['try_statement']),
  switchTypes: new Set(['match_statement']),
  nestedFnTypes: new Set(['lambda', 'function_definition']),
  switchFallsThrough: false,
  returnTypes: new Set(['return_statement']),
  breakTypes: new Set(['break_statement']),
  continueTypes: new Set(['continue_statement']),
  throwTypes: new Set(['raise_statement']),
  blockTypes: new Set(['block']),
  assignTypes: new Set(['assignment']),
  augAssignTypes: new Set(['augmented_assignment']),
  declTypes: new Set([]),
  declContainerTypes: new Set([]),
  memberTypes: new Set(['attribute']),
  subscriptTypes: new Set(['subscript']),
  identTypes: new Set(['identifier']),
  callTypes: new Set(['call']),
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  bodyField: 'body',
  leftField: 'left',
  rightField: 'right',
  paramsField: 'parameters',
};

const GO_SPEC: CfgLangSpec = {
  ifTypes: new Set(['if_statement']),
  loopTypes: new Set(['for_statement']),
  tryTypes: new Set([]),
  switchTypes: new Set(['expression_switch_statement', 'type_switch_statement']),
  nestedFnTypes: new Set(['func_literal', 'function_declaration', 'method_declaration']),
  switchFallsThrough: false,
  returnTypes: new Set(['return_statement']),
  breakTypes: new Set(['break_statement']),
  continueTypes: new Set(['continue_statement']),
  throwTypes: new Set([]),
  blockTypes: new Set(['block']),
  assignTypes: new Set(['assignment_statement']),
  augAssignTypes: new Set([]),
  declTypes: new Set(['short_var_declaration', 'var_spec', 'const_spec']),
  declContainerTypes: new Set(['var_declaration', 'const_declaration']),
  memberTypes: new Set(['selector_expression']),
  subscriptTypes: new Set(['index_expression']),
  identTypes: new Set(['identifier', 'field_identifier']),
  callTypes: new Set(['call_expression']),
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  bodyField: 'body',
  leftField: 'left',
  rightField: 'right',
  paramsField: 'parameters',
};

const SPEC_BY_LANGUAGE: Record<string, CfgLangSpec> = {
  TypeScript: TS_SPEC,
  JavaScript: TS_SPEC,
  Python: PY_SPEC,
  Go: GO_SPEC,
};

/** Languages for which CFG construction is implemented (spec v1 scope). */
export function cfgSupportsLanguage(language: string): boolean {
  return language in SPEC_BY_LANGUAGE;
}

// ============================================================================
// BUILDER
// ============================================================================

interface InternalBlock extends CfgBlock {
  /** Defs/uses recorded in this block, in source order. */
  ops: Op[];
}

type Op =
  | { op: 'def'; variable: string; line: number; precision: DataFlowPrecision; seq?: number }
  | { op: 'use'; variable: string; line: number; precision: DataFlowPrecision };

interface LoopCtx {
  continueTarget: number;
  breakTarget: number;
}

class CfgBuilder {
  blocks: InternalBlock[] = [];
  edges: CfgEdge[] = [];
  readonly ENTRY: number;
  readonly EXIT: number;

  constructor(private readonly spec: CfgLangSpec) {
    this.ENTRY = this.newBlock('entry');
    this.EXIT = this.newBlock('exit');
  }

  /**
   * Build the CFG from a function body's statement list. Any path that falls
   * through the end of the body is wired to the exit block.
   */
  build(body: CfgNode): void {
    // Statements never land directly on ENTRY: a dedicated start block keeps the
    // entry node a stable, never-relabeled root (so it can be relabeled
    // 'branch'/'loop' when the first statement is a control-flow construct).
    const start = this.newBlock('normal');
    this.addEdge(this.ENTRY, start, 'normal');
    const exit = this.processSeq(this.stmtChildren(body), start, null);
    if (exit !== null) this.addEdge(exit, this.EXIT, 'normal');
  }

  private newBlock(kind: CfgBlockKind): number {
    const id = this.blocks.length;
    this.blocks.push({ id, kind, ops: [] });
    return id;
  }

  private addEdge(from: number, to: number, kind: CfgEdgeKind): void {
    this.edges.push({ from, to, kind });
  }

  private setKind(block: number, kind: CfgBlockKind): void {
    // Don't downgrade entry/exit.
    const b = this.blocks[block];
    if (b.kind === 'entry' || b.kind === 'exit') return;
    b.kind = kind;
  }

  /**
   * Process a statement list starting from `entry`. Returns the single block id
   * that "falls through" after the sequence, or null if every path diverted
   * (return/throw/break/continue) and nothing falls through.
   */
  private processSeq(stmts: CfgNode[], entry: number, loop: LoopCtx | null): number | null {
    let current: number | null = entry;
    for (const stmt of stmts) {
      if (current === null) break; // unreachable after a divert
      current = this.processStmt(stmt, current, loop);
    }
    return current;
  }

  private processStmt(stmt: CfgNode, current: number, loop: LoopCtx | null): number | null {
    const t = stmt.type;
    const { spec } = this;

    if (spec.ifTypes.has(t)) return this.processIf(stmt, current, loop);
    if (spec.loopTypes.has(t)) return this.processLoop(stmt, current, loop);
    if (spec.tryTypes.has(t)) return this.processTry(stmt, current, loop);
    if (spec.switchTypes.has(t)) return this.processSwitch(stmt, current, loop);

    // A nested function/closure declared as a statement: its body is a separate
    // scope, not part of this CFG. Record only its free-variable (closure) reads
    // as `may` captures of the enclosing scope.
    if (spec.nestedFnTypes.has(t)) {
      this.recordClosureCaptures(stmt, current);
      return current;
    }

    if (spec.returnTypes.has(t) || spec.throwTypes.has(t)) {
      this.recordExpr(stmt, current); // return/throw value is a use
      this.addEdge(current, this.EXIT, 'exit');
      return null;
    }
    if (spec.breakTypes.has(t)) {
      if (loop) this.addEdge(current, loop.breakTarget, 'normal');
      else this.addEdge(current, this.EXIT, 'exit');
      return null;
    }
    if (spec.continueTypes.has(t)) {
      if (loop) this.addEdge(current, loop.continueTarget, 'back');
      else this.addEdge(current, this.EXIT, 'exit');
      return null;
    }

    // Compound block (bare `{ ... }`) — recurse into its statements.
    if (spec.blockTypes.has(t)) {
      return this.processSeq(stmt.namedChildren, current, loop);
    }

    // Straight-line statement: record defs/uses into the current block.
    this.recordStmt(stmt, current);
    return current;
  }

  private processIf(stmt: CfgNode, current: number, loop: LoopCtx | null): number | null {
    const { spec } = this;
    this.setKind(current, 'branch');
    const cond = stmt.childForFieldName(spec.conditionField);
    if (cond) this.recordUses(cond, current);

    const consequence = stmt.childForFieldName(spec.consequenceField);
    const thenBlock = this.newBlock('normal');
    this.addEdge(current, thenBlock, 'true');
    const thenExit = consequence
      ? this.processSeq(this.stmtChildren(consequence), thenBlock, loop)
      : thenBlock;

    const merge = this.newBlock('merge');
    if (thenExit !== null) this.addEdge(thenExit, merge, 'normal');

    // Python `if/elif*/else?` exposes each alternative as a separate child
    // (elif_clause / else_clause); a single childForFieldName('alternative')
    // would drop all but the first, silently losing branches. Collect them all.
    const elifs = stmt.namedChildren.filter(c => c.type === 'elif_clause');
    if (elifs.length > 0) {
      const pyElse = stmt.namedChildren.find(c => c.type === 'else_clause');
      let falseSrc = current;
      for (const elif of elifs) {
        const elifBlock = this.newBlock('branch');
        this.addEdge(falseSrc, elifBlock, 'false');
        const ec = elif.childForFieldName(spec.conditionField);
        if (ec) this.recordUses(ec, elifBlock);
        const eb = elif.childForFieldName(spec.consequenceField) ?? elif.childForFieldName(spec.bodyField);
        const thenB = this.newBlock('normal');
        this.addEdge(elifBlock, thenB, 'true');
        const ex = eb ? this.processSeq(this.stmtChildren(eb), thenB, loop) : thenB;
        if (ex !== null) this.addEdge(ex, merge, 'normal');
        falseSrc = elifBlock;
      }
      if (pyElse) {
        const elseBlock = this.newBlock('normal');
        this.addEdge(falseSrc, elseBlock, 'false');
        const eb = pyElse.childForFieldName(spec.bodyField) ?? pyElse.namedChildren.find(c => spec.blockTypes.has(c.type));
        const ex = eb ? this.processSeq(this.stmtChildren(eb), elseBlock, loop) : elseBlock;
        if (ex !== null) this.addEdge(ex, merge, 'normal');
      } else {
        this.addEdge(falseSrc, merge, 'false');
      }
      return merge;
    }

    const alternative = stmt.childForFieldName(spec.alternativeField);
    if (alternative) {
      const elseBlock = this.newBlock('normal');
      this.addEdge(current, elseBlock, 'false');
      // `else if` chains: the alternative is itself an if (or an else_clause wrapping one).
      const elseExit = this.processSeq(this.elseChildren(alternative), elseBlock, loop);
      if (elseExit !== null) this.addEdge(elseExit, merge, 'normal');
    } else {
      // No else: the false edge skips straight to the merge.
      this.addEdge(current, merge, 'false');
    }
    return merge;
  }

  private processLoop(stmt: CfgNode, current: number, _loop: LoopCtx | null): number | null {
    const { spec } = this;
    // Loop init / range target: a `for (let i = 0; ...)` or `for x := range ...`
    // introduces a definition; record it into the pre-loop block.
    this.recordLoopHeader(stmt, current);

    const condBlock = this.newBlock('loop');
    this.addEdge(current, condBlock, 'normal');
    const cond = stmt.childForFieldName(spec.conditionField);
    if (cond) this.recordUses(cond, condBlock);

    const bodyBlock = this.newBlock('normal');
    this.addEdge(condBlock, bodyBlock, 'true');
    const afterBlock = this.newBlock('merge');
    this.addEdge(condBlock, afterBlock, 'false');

    const body = stmt.childForFieldName(spec.bodyField);
    const innerLoop: LoopCtx = { continueTarget: condBlock, breakTarget: afterBlock };
    const bodyExit = body
      ? this.processSeq(this.stmtChildren(body), bodyBlock, innerLoop)
      : bodyBlock;
    if (bodyExit !== null) this.addEdge(bodyExit, condBlock, 'back');

    return afterBlock;
  }

  /**
   * try / catch / finally. The catch body is modeled as an alternative path from
   * the same predecessor (an exception may occur anywhere in the try), so try-body
   * and catch-body definitions do NOT linearly kill each other — they both reach
   * the join. A `finally` runs on every path, so it is processed from the merge.
   */
  private processTry(stmt: CfgNode, current: number, loop: LoopCtx | null): number | null {
    const { spec } = this;
    this.setKind(current, 'branch');

    const tryBody = stmt.childForFieldName(spec.bodyField) ?? stmt.namedChildren.find(c => spec.blockTypes.has(c.type));
    const tryBlock = this.newBlock('normal');
    this.addEdge(current, tryBlock, 'true');
    const tryExit = tryBody ? this.processSeq(this.stmtChildren(tryBody), tryBlock, loop) : tryBlock;

    const merge = this.newBlock('merge');
    if (tryExit !== null) this.addEdge(tryExit, merge, 'normal');

    // Each catch/except clause is an alternative path from `current`.
    let sawCatch = false;
    for (const clause of stmt.namedChildren) {
      if (clause.type !== 'catch_clause' && clause.type !== 'except_clause') continue;
      sawCatch = true;
      const catchBlock = this.newBlock('normal');
      this.addEdge(current, catchBlock, 'false');
      // The bound exception variable is a definition (TS `catch (e)`, Py `except X as e`).
      const param = clause.childForFieldName('parameter');
      if (param && spec.identTypes.has(param.type)) {
        this.block(catchBlock).ops.push({ op: 'def', variable: param.text, line: param.startPosition.row + 1, precision: 'exact' });
      } else {
        const asName = clause.namedChildren.find(c => spec.identTypes.has(c.type));
        if (asName) this.block(catchBlock).ops.push({ op: 'def', variable: asName.text, line: asName.startPosition.row + 1, precision: 'may' });
      }
      const catchBody = clause.childForFieldName(spec.bodyField) ?? clause.namedChildren.find(c => spec.blockTypes.has(c.type));
      const catchExit = catchBody ? this.processSeq(this.stmtChildren(catchBody), catchBlock, loop) : catchBlock;
      if (catchExit !== null) this.addEdge(catchExit, merge, 'normal');
    }
    // No catch (try/finally only): the try body may still throw past the merge,
    // but the non-exceptional path reaches it — keep `current`→merge as that edge.
    if (!sawCatch) this.addEdge(current, merge, 'false');

    // finally runs on every path → process it sequentially from the join.
    const finallyClause = stmt.namedChildren.find(c => c.type === 'finally_clause');
    if (finallyClause) {
      const finBody = finallyClause.childForFieldName(spec.bodyField) ?? finallyClause.namedChildren.find(c => spec.blockTypes.has(c.type));
      const finExit = finBody ? this.processSeq(this.stmtChildren(finBody), merge, loop) : merge;
      return finExit;
    }
    return merge;
  }

  /**
   * switch / match. Each case body is an alternative path from the discriminant
   * block; cases that do not break/return fall through to the next case (sound
   * for reaching-definitions). `break` exits to the post-switch merge; `continue`
   * still targets an enclosing loop.
   */
  private processSwitch(stmt: CfgNode, current: number, loop: LoopCtx | null): number | null {
    const { spec } = this;
    this.setKind(current, 'branch');
    const value = stmt.childForFieldName('value') ?? stmt.childForFieldName('condition');
    if (value) this.recordUses(value, current);

    // The case clauses live under a `*_body` node (TS switch_body) or, in Go,
    // are direct children of the switch statement itself.
    const body = stmt.childForFieldName(spec.bodyField) ?? stmt.namedChildren.find(c => c.type.endsWith('_body'));
    const caseContainer = body ?? stmt;
    const merge = this.newBlock('merge');
    const caseCtx: LoopCtx = { breakTarget: merge, continueTarget: loop?.continueTarget ?? merge };

    const isCaseNode = (ty: string): boolean =>
      ty === 'switch_case' || ty === 'switch_default' ||      // TS
      ty === 'case_clause' || ty === 'case_block' ||           // Py match (case_clause)
      ty === 'expression_case' || ty === 'default_case' || ty === 'type_case'; // Go
    const cases = caseContainer.namedChildren.filter(c => isCaseNode(c.type));
    let sawDefault = false;
    let prevFallthrough: number | null = null;
    for (const cs of cases) {
      const isDefault = cs.type.includes('default');
      if (isDefault) sawDefault = true;
      const caseBlock = this.newBlock('normal');
      this.addEdge(current, caseBlock, isDefault ? 'false' : 'true');
      // C-style fall-through: a previous case that did not break/return flows in.
      if (spec.switchFallsThrough && prevFallthrough !== null) this.addEdge(prevFallthrough, caseBlock, 'normal');
      // The case label expression(s) are uses of the discriminant context.
      const caseValue = cs.childForFieldName('value');
      if (caseValue) this.recordUses(caseValue, current);
      // Statements = the clause's children minus its label value.
      const stmts = cs.namedChildren.filter(c => c !== caseValue);
      const caseExit = this.processSeq(stmts, caseBlock, caseCtx);
      if (spec.switchFallsThrough) {
        prevFallthrough = caseExit;
      } else if (caseExit !== null) {
        // Each case auto-breaks (Go/Python): its tail goes straight to the merge.
        this.addEdge(caseExit, merge, 'normal');
      }
    }
    if (spec.switchFallsThrough && prevFallthrough !== null) this.addEdge(prevFallthrough, merge, 'normal');
    // No default: the discriminant can match nothing and skip to the merge.
    if (!sawDefault) this.addEdge(current, merge, 'false');
    return merge;
  }

  /**
   * Record the free-variable reads of a nested function/closure as `may`
   * (closure-capture) uses of the enclosing scope. Names bound by the nested
   * function (its parameters) are excluded; an outer definition of any remaining
   * name forms a conservative `may` dependence. The nested body's own defs are
   * deliberately NOT recorded — they belong to a different scope.
   */
  private recordClosureCaptures(fnNode: CfgNode, block: number): void {
    const { spec } = this;
    const bound = new Set<string>(extractParamNames(fnNode, spec));
    const body = findBody(fnNode, spec);
    if (!body) return;
    const seen = new Set<string>();
    const visit = (n: CfgNode): void => {
      // Do not descend into a further-nested function — that is yet another scope.
      if (n !== fnNode && spec.nestedFnTypes.has(n.type)) { this.recordClosureCaptures(n, block); return; }
      if (spec.callTypes.has(n.type)) {
        const fn = n.childForFieldName('function') ?? n.namedChildren[0];
        for (const c of n.namedChildren) { if (c === fn && fn && spec.identTypes.has(fn.type)) continue; visit(c); }
        return;
      }
      if (spec.identTypes.has(n.type)) {
        if (!bound.has(n.text)) {
          const key = `${n.text}|${n.startPosition.row + 1}`;
          if (!seen.has(key)) {
            seen.add(key);
            this.block(block).ops.push({ op: 'use', variable: n.text, line: n.startPosition.row + 1, precision: 'may' });
          }
        }
        return;
      }
      for (const c of n.namedChildren) visit(c);
    };
    visit(body);
  }

  // ── Statement / expression def-use extraction ─────────────────────────────

  private recordStmt(stmt: CfgNode, block: number): void {
    // Unwrap expression_statement / simple_statement wrappers.
    for (const node of this.unwrap(stmt)) {
      if (this.spec.declContainerTypes.has(node.type)) {
        // e.g. `let a = 1, b = 2;` — descend into each declarator.
        for (const child of node.namedChildren) {
          if (this.spec.declTypes.has(child.type)) this.recordDeclaration(child, block);
          else this.recordStmt(child, block);
        }
      } else if (this.spec.assignTypes.has(node.type)) {
        this.recordAssignment(node, block, false);
      } else if (this.spec.augAssignTypes.has(node.type)) {
        this.recordAssignment(node, block, true);
      } else if (this.spec.declTypes.has(node.type)) {
        this.recordDeclaration(node, block);
      } else {
        // Any other statement: collect uses (call args, conditions, etc.).
        this.recordUses(node, block);
      }
    }
  }

  /** A return/throw value, or any embedded expression, contributes uses. */
  private recordExpr(stmt: CfgNode, block: number): void {
    this.recordUses(stmt, block);
  }

  private recordAssignment(node: CfgNode, block: number, augmented: boolean): void {
    const { spec } = this;
    const left = node.childForFieldName(spec.leftField) ?? node.namedChildren[0];
    const right = node.childForFieldName(spec.rightField) ?? node.namedChildren[node.namedChildren.length - 1];
    const line = node.startPosition.row + 1;

    if (right) this.recordUses(right, block);
    // Augmented assignment (x += 1) reads the target before writing it.
    if (augmented && left) this.recordUses(left, block);

    if (left) this.recordTarget(left, block, line);
  }

  private recordDeclaration(node: CfgNode, block: number): void {
    const { spec } = this;
    const line = node.startPosition.row + 1;
    // Go short_var_declaration / var_spec: left & right are expression_lists.
    const left = node.childForFieldName(spec.leftField) ?? node.childForFieldName('name');
    const right = node.childForFieldName(spec.rightField) ?? node.childForFieldName('value');
    if (right) this.recordUses(right, block);
    if (left) {
      this.recordTarget(left, block, line);
    } else {
      // tree-sitter shapes without named left/right fields (var_spec lists):
      // first identifier child is the def, remaining expressions are uses.
      const idents = node.namedChildren.filter(c => spec.identTypes.has(c.type));
      for (const id of idents) this.block(block).ops.push({ op: 'def', variable: id.text, line, precision: 'exact' });
    }
  }

  /** Record an assignment/declaration target as a definition (exact for scalars, may for member/subscript). */
  private recordTarget(target: CfgNode, block: number, line: number): void {
    const { spec } = this;
    // A destructuring binding leaf: `{ a, b }` exposes each name as a
    // `shorthand_property_identifier_pattern` (no children), which the generic
    // container recurse below would silently drop.
    if (target.type === 'shorthand_property_identifier_pattern' || target.type === 'shorthand_property_identifier') {
      this.block(block).ops.push({ op: 'def', variable: target.text, line, precision: 'exact' });
      return;
    }
    // `{ key: binding }` — the value is the binding; the key is a property name.
    if (target.type === 'pair_pattern') {
      const val = target.childForFieldName('value') ?? target.namedChildren[target.namedChildren.length - 1];
      if (val) this.recordTarget(val, block, line);
      return;
    }
    // `{ a = default }` / `[a = default]` — left is the binding, right is a use.
    if (target.type === 'object_assignment_pattern' || target.type === 'assignment_pattern') {
      const def = target.childForFieldName('right') ?? target.namedChildren[target.namedChildren.length - 1];
      const bind = target.childForFieldName('left') ?? target.namedChildren[0];
      if (def && def !== bind) this.recordUses(def, block);
      if (bind) this.recordTarget(bind, block, line);
      return;
    }
    // Destructuring / multiple targets: expression_list, array/object patterns.
    if (
      target.type === 'expression_list' ||
      target.type.endsWith('_pattern') ||
      target.type === 'tuple_pattern' ||
      target.type === 'array_pattern' ||
      target.type === 'object_pattern' ||
      target.type === 'pattern_list'
    ) {
      for (const child of target.namedChildren) this.recordTarget(child, block, line);
      return;
    }
    if (spec.identTypes.has(target.type)) {
      this.block(block).ops.push({ op: 'def', variable: target.text, line, precision: 'exact' });
      return;
    }
    if (spec.memberTypes.has(target.type) || spec.subscriptTypes.has(target.type)) {
      // obj.field = ... / arr[i] = ... — the base object is read, the whole
      // l-value is a conservatively over-approximated (`may`) definition keyed
      // by its source text (e.g. "obj.field").
      const base = target.namedChildren[0];
      if (base && spec.identTypes.has(base.type)) {
        this.block(block).ops.push({ op: 'use', variable: base.text, line, precision: 'exact' });
      }
      this.block(block).ops.push({ op: 'def', variable: normalizeLValue(target.text), line, precision: 'may' });
      return;
    }
    // Anything else (rare): collect identifier defs conservatively.
    for (const child of target.namedChildren) this.recordTarget(child, block, line);
  }

  /** Loop init / range header introduces loop-variable definitions. */
  private recordLoopHeader(stmt: CfgNode, block: number): void {
    const { spec } = this;
    const line = stmt.startPosition.row + 1;
    // C-style for: initializer field. for-of/for-in/range: left field.
    const init = stmt.childForFieldName('initializer') ?? stmt.childForFieldName('init');
    if (init) this.recordStmt(init, block);
    const update = stmt.childForFieldName('update') ?? stmt.childForFieldName('increment');
    if (update) this.recordUses(update, block);
    // for (const x of xs) / for x in xs / for i, v := range xs
    const left = stmt.childForFieldName('left');
    const right = stmt.childForFieldName('right');
    if (right) this.recordUses(right, block);
    if (left && (spec.identTypes.has(left.type) || left.type.includes('pattern') || left.type === 'expression_list')) {
      this.recordTarget(left, block, line);
    }
  }

  /**
   * Walk an expression subtree collecting variable reads. Skips the callee name
   * of a call, the property name of a member access, and identifiers in def
   * position. A member/subscript read of a variable contributes a `may` use of
   * the l-value plus an `exact` use of the base object.
   */
  private recordUses(node: CfgNode, block: number): void {
    const { spec } = this;
    const visit = (n: CfgNode): void => {
      const t = n.type;
      // A nested function/closure (callback, IIFE): its body is a separate scope.
      // Record its free-variable reads as `may` captures, do not descend further.
      if (spec.nestedFnTypes.has(t)) {
        this.recordClosureCaptures(n, block);
        return;
      }
      // Nested assignment/declaration inside an expression: handle as a statement.
      if (spec.assignTypes.has(t) || spec.augAssignTypes.has(t)) {
        this.recordAssignment(n, block, spec.augAssignTypes.has(t));
        return;
      }
      if (spec.memberTypes.has(t)) {
        // obj.field read: base obj is an exact use, the field path is a may use.
        const base = n.namedChildren[0];
        if (base) visit(base);
        this.block(block).ops.push({ op: 'use', variable: normalizeLValue(n.text), line: n.startPosition.row + 1, precision: 'may' });
        return;
      }
      if (spec.subscriptTypes.has(t)) {
        for (const c of n.namedChildren) visit(c);
        this.block(block).ops.push({ op: 'use', variable: normalizeLValue(n.text), line: n.startPosition.row + 1, precision: 'may' });
        return;
      }
      if (spec.callTypes.has(t)) {
        // Skip the callee identifier; collect uses from arguments and receiver.
        const fn = n.childForFieldName('function') ?? n.namedChildren[0];
        for (const c of n.namedChildren) {
          if (c === fn && fn && spec.identTypes.has(fn.type)) continue;
          visit(c);
        }
        return;
      }
      if (spec.identTypes.has(t)) {
        this.block(block).ops.push({ op: 'use', variable: n.text, line: n.startPosition.row + 1, precision: 'exact' });
        return;
      }
      for (const c of n.namedChildren) visit(c);
    };
    visit(node);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private block(id: number): InternalBlock {
    return this.blocks[id];
  }

  /** Children of a compound/block node, or the node itself wrapped as one statement. */
  private stmtChildren(node: CfgNode): CfgNode[] {
    if (this.spec.blockTypes.has(node.type)) return node.namedChildren;
    return [node];
  }

  /** Children of an else branch — unwrap else_clause / elif_clause wrappers. */
  private elseChildren(node: CfgNode): CfgNode[] {
    if (node.type === 'else_clause') {
      const body = node.childForFieldName(this.spec.bodyField) ?? node.namedChildren[0];
      return body ? this.stmtChildren(body) : [];
    }
    // `else if`: the alternative is the nested if_statement itself.
    return [node];
  }

  /** Unwrap expression_statement / simple_statement to its meaningful children. */
  private unwrap(stmt: CfgNode): CfgNode[] {
    if (stmt.type === 'expression_statement' || stmt.type === 'simple_statement') {
      return stmt.namedChildren.length > 0 ? stmt.namedChildren : [stmt];
    }
    return [stmt];
  }
}

/** Strip whitespace and array-index noise so an l-value is a stable key. */
function normalizeLValue(text: string): string {
  return text.replace(/\s+/g, '');
}

// ============================================================================
// REACHING DEFINITIONS
// ============================================================================

/** A definition site identity within one function: variable + line. */
interface DefSite {
  variable: string;
  line: number;
  precision: DataFlowPrecision;
  /** Block where the def lives (for GEN/KILL bookkeeping). */
  block: number;
  /** Sequence index for deterministic ordering. */
  seq: number;
}

/**
 * Compute the reaching-definitions def-use edges over a built CFG. Standard
 * iterative fixpoint: IN[b] = ∪ OUT[preds]; OUT[b] = GEN[b] ∪ (IN[b] − KILL[b]).
 * Then, walking each block's ops in order, every use is wired to the defs of the
 * same variable that reach it.
 */
function computeReachingDefs(builder: CfgBuilder, params: string[], paramLine: number): DefUseEdge[] {
  const blocks = builder.blocks;
  const n = blocks.length;

  // Predecessors per block.
  const preds: number[][] = Array.from({ length: n }, () => []);
  for (const e of builder.edges) preds[e.to].push(e.from);

  // Enumerate all def sites. Parameters are defs at the entry block.
  const allDefs: DefSite[] = [];
  let seq = 0;
  for (const p of params) {
    allDefs.push({ variable: p, line: paramLine, precision: 'exact', block: builder.ENTRY, seq: seq++ });
  }
  // Per-block ordered def sites (entry block also carries param defs first).
  const blockDefSites: DefSite[][] = Array.from({ length: n }, () => []);
  for (const pd of allDefs) blockDefSites[pd.block].push(pd);
  for (const b of blocks) {
    for (const op of b.ops) {
      if (op.op === 'def') {
        const site: DefSite = { variable: op.variable, line: op.line, precision: op.precision, block: b.id, seq: seq++ };
        op.seq = site.seq; // back-reference so the wiring pass can find this def's seq
        allDefs.push(site);
        blockDefSites[b.id].push(site);
      }
    }
  }

  // Index defs by variable for KILL.
  const defsByVar = new Map<string, DefSite[]>();
  for (const d of allDefs) {
    const arr = defsByVar.get(d.variable) ?? [];
    arr.push(d);
    defsByVar.set(d.variable, arr);
  }

  // GEN[b]: the last def of each variable within the block (it kills earlier
  // same-var defs from the block before it). KILL[b]: all defs of any variable
  // defined in b.
  const gen: Set<number>[] = Array.from({ length: n }, () => new Set());
  const kill: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let b = 0; b < n; b++) {
    const lastByVar = new Map<string, DefSite>();
    const varsDefinedHere = new Set<string>();
    for (const d of blockDefSites[b]) {
      lastByVar.set(d.variable, d);
      varsDefinedHere.add(d.variable);
    }
    for (const d of lastByVar.values()) gen[b].add(d.seq);
    for (const v of varsDefinedHere) {
      for (const killed of defsByVar.get(v) ?? []) kill[b].add(killed.seq);
    }
    // A def does not kill itself within its own GEN set.
    for (const g of gen[b]) kill[b].delete(g);
  }

  // Fixpoint over OUT sets (def seqs).
  const inSet: Set<number>[] = Array.from({ length: n }, () => new Set());
  const outSet: Set<number>[] = Array.from({ length: n }, (_, b) => new Set(gen[b]));

  let changed = true;
  let guard = 0;
  const maxIters = n * n + 16; // generous bound; structured CFGs converge fast
  while (changed && guard++ < maxIters) {
    changed = false;
    for (let b = 0; b < n; b++) {
      const nin = new Set<number>();
      for (const p of preds[b]) for (const s of outSet[p]) nin.add(s);
      // OUT = GEN ∪ (IN − KILL)
      const nout = new Set<number>(gen[b]);
      for (const s of nin) if (!kill[b].has(s)) nout.add(s);
      if (!setEq(nin, inSet[b])) { inSet[b] = nin; changed = true; }
      if (!setEq(nout, outSet[b])) { outSet[b] = nout; changed = true; }
    }
  }

  // Wire uses to reaching defs. Walk each block's ops in order, threading a
  // "currently reaching" map (variable → def seqs) seeded from IN[b].
  const defBySeq = new Map<number, DefSite>();
  for (const d of allDefs) defBySeq.set(d.seq, d);

  const edges: DefUseEdge[] = [];
  const emitted = new Set<string>();
  for (let b = 0; b < n; b++) {
    const reaching = new Map<string, Set<number>>();
    for (const s of inSet[b]) {
      const d = defBySeq.get(s)!;
      (reaching.get(d.variable) ?? reaching.set(d.variable, new Set()).get(d.variable)!).add(s);
    }
    for (const op of blocks[b].ops) {
      if (op.op === 'use') {
        const defs = reaching.get(op.variable);
        if (defs) {
          for (const s of defs) {
            const d = defBySeq.get(s)!;
            // Edge precision: `may` if either endpoint is conservative.
            const precision: DataFlowPrecision = (d.precision === 'may' || op.precision === 'may') ? 'may' : 'exact';
            const key = `${op.variable}|${d.line}|${op.line}|${precision}`;
            if (!emitted.has(key)) {
              emitted.add(key);
              edges.push({ variable: op.variable, defLine: d.line, useLine: op.line, precision });
            }
          }
        }
      } else if (op.seq !== undefined) {
        // A def replaces (kills) all prior reaching defs of that variable.
        reaching.set(op.variable, new Set([op.seq]));
      }
    }
  }

  // Deterministic ordering.
  edges.sort((a, b) =>
    a.defLine - b.defLine || a.useLine - b.useLine ||
    (a.variable < b.variable ? -1 : a.variable > b.variable ? 1 : 0) ||
    (a.precision < b.precision ? -1 : a.precision > b.precision ? 1 : 0)
  );
  return edges;
}

function setEq(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ============================================================================
// PUBLIC ENTRY POINT
// ============================================================================

/**
 * Build the per-function CFG + reaching-definitions overlay from a function's
 * AST node, while its parse tree is live. Returns undefined for an unsupported
 * language or a function with no usable body (fail-soft — never throws).
 *
 * @param fnNode    The function/method declaration node.
 * @param language  Source language (TypeScript/JavaScript/Python/Go in v1).
 */
export function buildFunctionCfg(fnNode: CfgNode, language: string): FunctionCfg | undefined {
  const spec = SPEC_BY_LANGUAGE[language];
  if (!spec) return undefined;
  try {
    const body = findBody(fnNode, spec);
    if (!body) return undefined;
    const params = extractParamNames(fnNode, spec);
    const paramLine = fnNode.startPosition.row + 1;

    const builder = new CfgBuilder(spec);
    builder.build(body);

    const defUse = computeReachingDefs(builder, params, paramLine);

    return {
      blocks: builder.blocks.map(b => ({ id: b.id, kind: b.kind })),
      edges: builder.edges,
      defUse,
      params,
      paramLine,
    };
  } catch {
    return undefined; // fail-soft: any visitor/grammar surprise yields no overlay
  }
}

/**
 * Forward data-flow slice: the set of source lines a value reaches through
 * def-use edges within one function (a Weiser forward slice = the value's impact
 * set). Seeds from `target` (a parameter or local variable name) or, when
 * omitted, from every parameter. Propagates through chained assignments: a line
 * that defines a variable from a tainted read becomes tainted itself.
 *
 * Used by the value-level opt-in on `analyze_impact`/`trace_execution_path` to
 * narrow downstream results to the calls whose arguments are data-dependent on
 * the targeted value. Over-approximating (line-granular for chained defs) and
 * therefore sound toward "may affect".
 */
export function valueReachableLines(cfg: FunctionCfg, target?: string): Set<number> {
  const seedVars = target ? [target] : cfg.params;
  const tainted = new Set<string>(); // "variable|defLine"
  for (const v of seedVars) tainted.add(`${v}|${cfg.paramLine}`);
  // A targeted local (non-parameter) is seeded from all of its definition sites.
  if (target && !cfg.params.includes(target)) {
    for (const e of cfg.defUse) if (e.variable === target) tainted.add(`${e.variable}|${e.defLine}`);
  }

  const defsAtLine = new Map<number, Set<string>>();
  for (const e of cfg.defUse) {
    (defsAtLine.get(e.defLine) ?? defsAtLine.set(e.defLine, new Set()).get(e.defLine)!).add(e.variable);
  }

  const reached = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of cfg.defUse) {
      if (!tainted.has(`${e.variable}|${e.defLine}`)) continue;
      if (!reached.has(e.useLine)) { reached.add(e.useLine); changed = true; }
      for (const w of defsAtLine.get(e.useLine) ?? []) {
        const key = `${w}|${e.useLine}`;
        if (!tainted.has(key)) { tainted.add(key); changed = true; }
      }
    }
  }
  return reached;
}

function findBody(fnNode: CfgNode, spec: CfgLangSpec): CfgNode | undefined {
  const direct = fnNode.childForFieldName(spec.bodyField);
  if (direct) return direct;
  // Fallback: first block-type child (arrow functions, lambdas with block bodies).
  for (const c of fnNode.namedChildren) if (spec.blockTypes.has(c.type)) return c;
  return undefined;
}

function extractParamNames(fnNode: CfgNode, spec: CfgLangSpec): string[] {
  const params = fnNode.childForFieldName(spec.paramsField)
    ?? fnNode.namedChildren.find(c => c.type === 'parameters' || c.type === 'parameter_list' || c.type === 'formal_parameters');
  if (!params) return [];
  const names: string[] = [];
  const visit = (n: CfgNode): void => {
    // A parameter's binding identifier: required_parameter/optional_parameter
    // (TS), typed_parameter/identifier (Python), parameter_declaration (Go).
    if (n.type === 'identifier') { names.push(n.text); return; }
    for (const c of n.namedChildren) {
      // Only descend into parameter wrappers, not default-value expressions.
      if (c.type === 'identifier') { names.push(c.text); return; }
      if (
        c.type.includes('parameter') || c.type === 'pattern' ||
        c.type === 'tuple_pattern' || c.type === 'object_pattern' || c.type === 'array_pattern'
      ) {
        visit(c);
      }
    }
  };
  for (const c of params.namedChildren) visit(c);
  // Dedup, preserve order.
  return [...new Set(names)];
}
