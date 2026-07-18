# Tasks — add symbol span locator (read-only)

## Implementation
- [ ] `locate_symbol_span(symbol)` handler resolving via the `find_clones` `name::path` addressing
      (unknown → `not-found` + candidates; ambiguous bare name → `ambiguous` + `name::path`
      candidates; never a fuzzy guess)
- [ ] Content-hash freshness verdict (`hashSpan` over the indexed span vs. current file bytes):
      match → `fresh` with the byte + line span; mismatch → `stale` with a re-analyze hint and no
      usable offset
- [ ] Register the tool: `TOOL_CAPABILITY_FAMILY` = `navigate`; `tool-contract.ts` class =
      `conclusion`; `readOnlyHint: true`; place in `--preset full` (evaluate `substrate` fit)
- [ ] NO write path, NO `edit` preset, NO mcp-security write-confinement change — the tool only
      reads

## Verification
- [ ] Fixture: a fresh, unambiguous `name::path` symbol returns the byte-exact span + `fresh`
- [ ] Verdicts: ambiguous bare name → `ambiguous`+candidates; unknown → `not-found`+candidates;
      hash-mismatched span → `stale`+re-analyze hint — and no file is ever modified
- [ ] Read-only guard: the handler performs no write (annotation + behavior asserted)
- [ ] tools/list payload budget assertions updated; default-surface presets byte-identical
- [ ] Full suite green

## Spec
- [x] `mcp-handlers` delta: ADD SymbolSpanLocatorReportsFreshnessVerdict (replaces the withdrawn
      SymbolAnchoredEditsRefuseStaleSpans)
- [x] `mcp-security` delta withdrawn — no write face, so no write-confinement extension
