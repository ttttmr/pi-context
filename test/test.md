```bash
pi --no-skills --no-extensions --skill ./skills -e ./src/index.ts -e ./src/context.ts
```

```md
Context Tool Test Task
Strictly follow the steps below.
1. Create a checkpoint for the starting point from here.
2. Generate a random number, write it to the file /tmp/pi-context-random, and display it using cat.
3. Compact to the start. The compact summary must not include the value of the random number but must state what the next step is.
4. Find a way to guess the value of the random number without reading the file.
5. Read the file to compare and see if the guess was correct.
6. Output "Success" if the guess is correct; otherwise, output "Failure".
```

## Compaction advancement regression

Launch Pi with the passive-entry fixture:

```bash
pi --no-skills --no-extensions -e ./src/index.ts -e ./src/context.ts -e ./test/passive-custom-extension.ts
```

1. Enable ACM with `/acm` and ask the agent to checkpoint, inspect the timeline, and call `context_compact`.
2. Confirm that label, session-info, and non-contextual custom entries appended while `waitForIdle()` settles do not cancel compaction.
3. Repeat while submitting a real user steering message before compaction settles; confirm that any message entry cancels compaction exactly once and creates no summary branch.
4. Confirm that the next model request contains no orphaned tool result.