# Retry, Branch, and Pivot

Use this reference when multiple approaches are being tried and abandoned cleanly, such as:
- trying A / B / C approaches
- failed branches that should not pollute the main line
- compare-and-choose work
- strategy pivots or goal shifts
- restarting from a focused working set after a dead end

This is a **cross-cutting pattern reference**. Read it alongside a primary reference such as search/research, development/troubleshooting, or planning/execution when branch behavior becomes central.

## Working pattern

1. Checkpoint before opening a risky branch or alternative path.
2. Explore or implement that branch.
3. If anchor choice becomes unclear, inspect timeline.
4. Once the branch produces a stable lesson, decision, or dead-end, compact to the anchor that removes branch noise while preserving the state needed for the next attempt.
5. Continue with the next branch or the chosen direction from that focused state.

## When to review timeline

Run `context_timeline` when:
- multiple branches now exist
- you are unsure which branch actually stayed useful
- you need to choose which pre-branch or older anchor gives the next attempt the best working set
- the next direction is clear but the old branch still clutters active context

## When to compact

Compact when:
- a branch clearly failed
- a comparison is complete and one option won
- the direction changed enough that the old path is now baggage
- the next attempt should start from a focused state rather than the raw failed branch

When compacting after an abandoned branch, preserve:

- what was tried
- why it failed or was rejected
- what should not be repeated
- what remains valid
- the chosen next approach

## Strategy pivot

Use this pattern when the old direction no longer makes sense even though the task is still continuing.

Examples:
- the original approach is no longer viable
- the user's priority changed
- the scope narrowed or widened enough that old execution noise is now baggage

In these cases:
- summarize what still matters
- compact to the anchor that removes the stale branch while preserving current task state
- continue under the new direction

## Example rhythm

```javascript
context_checkpoint({ name: "oauth-fix-start" });

// ... try cookie-based approach ...

context_compact({
  target: "oauth-fix-start",
  summary: "Current task: continue the OAuth fix with a new approach. State: cookie-based approach is not viable because the callback flow loses session continuity. Rejected path: do not repeat cookie-based continuity for this flow. Still valid: callback validation and provider config findings. Decision: switch to signed state tokens. Next step: implement the signed-state approach.",
  backupCheckpoint: "oauth-cookie-approach-history"
});
context_checkpoint({ name: "oauth-signed-state-start" });
```

## Common mistakes

Avoid:
- opening alternative branches without a clean checkpoint first
- dragging failed branches forward after their lesson is already clear
- omitting the rejected path, failure reason, or chosen replacement from the compact summary
- compacting to a point that still includes the branch you meant to abandon
- treating every branch as equally worth preserving
