# Search, Research, and Reading

Use this reference when the work is mainly driven by large amounts of input material, such as:
- searching
- research
- web search
- browser-driven information gathering
- reading many files, logs, docs, webpages, or web results
- review-heavy reading
- comparison-heavy reading
- audit or inspection across many sources

This reference is for **input-heavy work where the process is much larger than the final conclusion**. It is especially relevant for web search and browser/page reading, where the information density is often low and the raw trail becomes stale quickly. If the main anchor is an explicit plan or todo list, use `planning-and-execution.md` instead.

## Working pattern

1. Create a checkpoint before a large search or reading loop.
2. Search, browse, read, inspect, and follow leads normally.
3. If you lose orientation, review the timeline.
4. Once the investigation yields a stable finding and there is another step to take, compact to the anchor that gives the next step a focused working set.
5. Continue with the conclusion, recommendation, or next action instead of carrying the entire raw exploration forward. If the finding is the final answer to the user's current request, answer first and wait; compact on the next user message if it starts new work.

Do not stop at "I already made a checkpoint" if the investigation phase is complete and the conversation is continuing. The cleanup move for completed research is usually a compact to the anchor that preserves only the raw context the next step still needs.

**Important:** “another step” includes the next phase of the same request. If you searched to find the right data source, previous task record, API shape, rule id, or query pattern, then the next execution step (running the real query/export, implementing, validating, etc.) is an immediate continuation. Compact before that execution step, not only before a future user message.

## When to checkpoint

Checkpoint:
- before the first big search pass
- before opening a browser-heavy or webpage-heavy reading pass
- before diving into a new evidence branch
- after a stable intermediate conclusion
- before changing investigation direction

Example checkpoint names:
- `incident-search-start`
- `vendor-review-evidence-branch`
- `api-timeout-investigation-midpoint`

## When to review timeline

Run `context_timeline` when:
- you have followed several leads
- you are no longer sure what the main anchor is
- the investigation has already produced multiple checkpoints
- you are deciding which path should be compacted

## When to compact

Compact after the investigation produces one of these and there is a continuation that benefits from cleanup:
- a stable root cause
- a stable comparison result
- a dead-end conclusion
- a shortlist of viable next actions
- a located data source, old conversation, schema, rule id, query/API pattern, or other fact that unlocks execution

If you already have one of these, the investigation phase is usually complete enough to compact. If the next step is to use the finding in another tool call, compact first. If there is no continuation yet because you are about to give the final answer, wait until the next user message before deciding.

Do not compact in the middle of a still-open search loop just because the thread feels busy.

## Message quality for research compactions

Research compactions are especially sensitive to summary quality. The raw exploration may contain details that become important later, but returning to the backup branch is a context switch. Preserve the state needed to use the finding, not the whole journey.

Include:
- **Current task/state:** what the research unlocked and how it will be used next
- **Finding:** what is now known
- **Source anchors:** key files, URLs, docs, sessions, commands, queries, or records used to reach the finding
- **Evidence:** important numbers, errors, examples, IDs, or constraints that support the finding
- **Rejected leads:** only expensive dead ends that future-you should not repeat
- **Open questions:** what is still uncertain
- **Next step:** what to do immediately after compact
- **Backup pointer:** if `backupCheckpoint` is set, when to return to it

Do not compress research to only “found the answer”. That forces future-you to either trust an unsupported conclusion or switch back to the backup for basic details.

## Typical rhythm

```javascript
context_checkpoint({ name: "timeout-investigation-start" });

// ... search logs, read code, compare docs, inspect outputs ...

// Stable finding found and the next action is execution/validation, so compact before continuing.
context_timeline();

context_compact({
  target: "timeout-investigation-start",
  backupCheckpoint: "timeout-investigation-raw-history",
  summary: "Current task: plan mitigation for API timeouts. State: DB connection pool exhaustion is the likely root cause. Evidence: logs show pool wait timeouts during peak traffic; config has pool size 10; no network errors found in the checked logs. Rejected lead: API gateway timeout was downstream of DB waits, not the origin. Backup: timeout-investigation-raw-history if exact log lines are needed. Next step: propose mitigation and validation steps."
});
```

## Good compact outcomes

After compacting, you should be able to continue with:
- the finding
- the recommendation
- the next verification step
- the next narrower investigation

You should not still need the whole raw trail in active context unless the investigation is still ongoing.
