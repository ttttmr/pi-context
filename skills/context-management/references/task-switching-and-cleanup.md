# Task Switching and Cleanup

Use this reference when the main problem is not the task domain itself, but a change in thread state, such as:
- the user inserts a temporary side task
- the user starts a new task after a completed noisy task
- you need to pause one line of work and resume it later
- several active fronts now exist
- the thread is already messy and needs cleanup before continuing
- a finished noisy phase should be summarized and left behind before new work starts

This reference is for **pause/resume, cleanup, and clean continuation**. It is not for repeated similar items or plan-driven execution.

## Three common variants

### Interruption / task switch
Use when you are actively switching away from one line of work and intend to come back.

### Completed-task handoff
Use when a previous task is complete, the user has now said something new, and the previous task's raw path is noisy enough that it should not be carried into the new work.

### Cleanup and continue
Use when the thread is already stale or messy and you want to compress it now, even though context management is being adopted late.

## Working pattern

1. Inspect timeline if anchor choice is unclear.
2. Before switching away or compacting a noisy path, preserve or choose the anchor that will give the resumed/new task a clean working set.
3. If needed, create a backup checkpoint for the current noisy branch.
4. If the user has just started a new task after a completed noisy task, compact before doing the new task so the completed task becomes a compact summary rather than active baggage.
5. If the user asks a concrete side question while noisy mainline work is active, pause or summarize the active work, compact if the raw mainline history is no longer needed for the side question, answer the side question, and preserve how to resume the paused work.
6. Handle the side task or cleanup move.
7. Compact away the stale path when the handoff summary is clear.
8. Resume from the paused anchor or continue from the compacted state.

## Useful anchors

Example checkpoint names:
- `primary-task-paused`
- `migration-mainline-paused`
- `release-investigation-paused`
- `cleanup-pre-noise-anchor`

## When to review timeline

Run `context_timeline` when:
- multiple interruptions happened
- the pause lasted many turns
- several side-task branches now exist
- you are unsure which anchor gives the resumed/new task the right working set
- the thread is already messy and you need to find the right pre-noise checkpoint

## When to compact

Compact when:
- the interruption created lots of noise
- the side task is done and should not stay active in full
- the user begins a new task after a completed noisy task and the previous raw path is no longer useful in full
- a stale path is making current reasoning worse
- the useful state is now much smaller than the accumulated process
- you can express the handoff clearly in a summary

Do not compact at the instant you finish a user-visible task if there is no known continuation. In that moment, deliver the answer and wait. If the next user message starts a new task, that is the right time to compact the completed task before proceeding. If the completed task changed files, browser state, tickets, or remote services, include those side effects in the handoff summary because the context move does not undo them. If the interruption was tiny and clean, a compact may be unnecessary. A checkpoint before switching away is still the key move.

## Common mistakes

Avoid:
- switching away without a pause checkpoint
- compacting immediately after a final answer just because the task completed
- starting a new, unrelated user task while still carrying the previous task's full raw path
- returning to the main line while still carrying the side task's full raw path
- trying to clean up without first checking timeline when anchor choice is unclear
- resetting past still-valid near-term context without carrying it in the summary
- forgetting that files and external systems remain in their latest state after context navigation
