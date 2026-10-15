# Session behavior analysis

Repository-local, dependency-free Node CLI for inspecting a Pi session without changing it. The primary view is **tool behavior**, with context usage as supporting evidence. It does not load extensions, navigate the live session, or send data anywhere. Requires Node 20+.

```bash
npm run analyze:session -- /path/to/session.jsonl

# Freeze a growing session and choose a fresh report directory.
npm run analyze:session -- /path/to/session.jsonl \
  --max-lines 500 --out /path/to/report-v2 --timezone Asia/Shanghai
```

Open `session-token-chart.html` directly in a browser. The filename is retained for compatibility. No server, CDN, font download, or network access is needed.

## Read the report

1. **Overview:** see tool activity density and compact attempts across the whole session. Drag to select a range, click a dense region, or enter physical source-line bounds. The range controls also support keyboard navigation.
2. **Tool timeline:** separate context, read, edit/write, bash, agent, and other tools. The original tool name remains available in filters and the paginated call list. Dense marks aggregate nearby calls; click to zoom, then select a call. Structural markers identify user-message records, checkpoints, native compactions and summary branches, not inferred task phases.
3. **Context curve:** shares the timeline axis and selected range. Hover for input/cumulative values; do not assign an input increase to one preceding tool.
4. **Event detail:** inspect call/result evidence, safe file target, source lines, output size and adjacent actions. Ordinary-call neighbors follow file order and may cross branches. The resource hash distinguishes same-basename files outside the session cwd.
5. **Compaction detail:** distinguishes request, tool return, actual summary branch, and observed model continuation. Select a compact to locate its target and highlight historical calls excluded from the resulting ancestry. This is not a raw-token removal estimate. The recovery list shows up to ten subsequent tools on a continuation path, stopping at another compact.
6. **No-compact work:** use the same timeline and call list to inspect direct reads, edits, validation commands, and checkpoint/timeline use. There is no automatic score or presumption that compacting more is better.

The default axis is **record order**, not elapsed time. Actual-time mode preserves waits. Fold-idle mode removes gaps longer than 30 minutes between recorded activity; `//` marks the joins. Activity-period selection uses these gaps, not task semantics. All views analyze physical file order across all recorded branches; they are not a replay of only the final active branch.

Auxiliary cumulative-token and threshold-simulation charts are collapsed by default. They use the same selected range.

## Tool and Skill evidence

Calls join results by `toolCallId` on parent ancestry, not by proximity alone. Ambiguous IDs, missing results, orphan results and unknown result status remain explicit. A successful tool result is not proof of successful business work. Bash commands are not automatically classified as tests, builds or deployments because that would require interpreting their contents.

Tool times are record timestamps. They are not precise execution start/end instrumentation; execution duration is unknown. Output size is the joined text's JavaScript string length (UTF-16 code units), including any tool-added notices, not tokens or original file size. Images are not counted as text. Truncation is based on recorded indicators; absence of an indicator is not a completeness guarantee. An explicitly paged read is not by itself an output-truncation error.

A `context_compact` result such as `compact start` or `context_compact scheduled` only acknowledges the call. Pi-context <= 2.3 confirms a compaction with an attributable `branch_summary`; later versions fold history in place and confirm it with a `pi-context-compaction` summary message whose `context_edit` omissions identify removed history. An attempt with neither remains unconfirmed, even if the process exits successfully. A non-error, positive-input assistant descendant is evidence of model continuation, not task completion. Pending or cut-off snapshots cannot prove an attempt permanently failed.

Recovery read overlaps are evidence only:

- **exact-output:** returned text matches, not necessarily the complete file;
- **same-range:** normalized file identity and requested range match, but returned text differs;
- **same-resource:** same file identity, with other differences.

Each match identifies whether the earlier read was excluded from the resulting ancestry or retained. Returning to a file can be legitimate validation or required work, not waste. Reads across native compaction visibility boundaries are handled conservatively; absence of a match does not establish zero recovery cost. The first ordinary tool action excludes context tools and identified Skill reads, but is not automatically “effective business progress.”

A successful `read` of `context-management/SKILL.md` records a returned-text SHA-256 and conservative completeness evidence. Partial reads do not establish the whole Skill version. The report does not inspect today's installed Skill to infer a historical version. Context-tool usage without a Skill read is not proof of Skill influence.

## Options and outputs

| Option | Default | Meaning |
| --- | --- | --- |
| `--out` | `.pi/session-analysis/<source-basename>` | Output directory; existing report files are never overwritten |
| `--max-lines` | Entire file snapshot | Positive physical line cutoff, including blank lines |
| `--timezone` | `Asia/Shanghai` | IANA display timezone; raw timestamps unchanged |
| `--window` | `272000` | Assumed simulation window, not inferred from the model |
| `--threshold` | `0.9` | Simulated trigger fraction, greater than 0 and at most 1 |
| `--reset` | `39000` | Simulated post-compaction context, below the trigger |

Outputs:

- `session-token-chart.html`: self-contained interactive behavior report with embedded data.
- `session-token-data.json`: metadata, `tools`, `compactAttempts`, `milestones`, `skillReads`, token observations, historical events, checkpoints, warnings and simulation.
- `session-tool-calls.csv`: all calls, result status and safe file/read evidence.
- `session-compact-attempts.csv`: lifecycle evidence for every context-compaction request, including unfinished ones.
- `session-rereads.csv`: recovery read-overlap pairs keyed to compact and tool records.
- `session-token-usage.csv`: assistant and auxiliary usage, including cumulative totals.
- `session-compactions.csv`: confirmed summary/native events and adjacent valid pre/post input observations, not attempted calls.
- `session-checkpoints.csv`: labels, classification, creation time and target-node time.
- `session-simulation.csv`: modeled context at each actual observation; `time` is Unix milliseconds.

Reports work even without positive assistant usage, including a tool-only or zero-activity snapshot. The JSON includes a SHA-256 of selected source bytes, physical line numbers and cutoff timestamp. A malformed unterminated final line is skipped with a warning; malformed complete/interior lines and invalid or decreasing timestamps fail. No live tailing. Without ancestry IDs, calls can be counted but result/branch attribution is limited.

## Token measurement and simulation limits

**Actual input context** is `input + cacheRead + cacheWrite` for assistant usage records with positive input. Missing usage is not zero. Zero-context error/aborted records do not create false drops, but any recorded output still contributes to cumulative totals.

**Cumulative processing** sums `input + cacheRead + cacheWrite + output` for assistant, tool-result auxiliary and top-level summary/compaction usage. Cached input is counted every time. Reasoning and retained-tail usage are not counted again. Only recorded work is measured; unrecorded summarizers or external agents cannot be reconstructed. A mismatching `totalTokens` generates a warning; the breakdown is authoritative. This is neither unique content size nor billable uncached tokens, cost, or hypothetical uncompressed context.

Compaction before/after values use nearest valid assistant input observations and include intervening changes. Checkpoint markers use label creation time, not target-node time. Ordinary branch summaries remain distinct from attributed context compaction. Failed requests alone never count as confirmed compactions.

The threshold simulation is an analyst-chosen sensitivity scenario, **not Pi's default configuration or a control experiment**:

1. Start with the first observed input.
2. Add each subsequent actual input delta. For a confirmed context/native compaction with decreased adjacent inputs, replace that transition's delta with zero; preserve other positive and negative changes, clamping at zero.
3. At the threshold, subtract `thresholdTokens - reset`, preserving overflow; repeat for large increments. A 100-token observation at threshold 90/reset 30 finishes at 40, not 30.
4. Reset times are observation timestamps, not actual inferred trigger instants.

This cannot reconstruct summary-replaced growth or predict changes in tool calls, model output, cache reuse or cost. Multiple models and unattributed branches further weaken comparisons. Never present the difference as measured savings.

## Privacy and verification

No message bodies, raw commands, argument bodies, result bodies, summary bodies or thinking are exported. File identity is normalized lexically without filesystem access: targets inside the initial session cwd are relative, outside targets use basenames, and a hash supports matching. This is **not automatic anonymization**: filenames, checkpoint names, tool names, session/entry IDs, model names and timestamps may still be sensitive. Inspect before sharing. Do not commit personal sessions or reports; the default output directory is ignored.

`npm test` covers parsing, usage, tool-result ancestry, compact lifecycle, recovery matches, Skill evidence, privacy, simulation and CLI behavior. Browser acceptance additionally checks a long session, an acknowledged-but-unbranched compact, and a direct hot-patch continuation; verify filtering, range selection, lifecycle detail, both themes and desktop/mobile widths. These visual checks do not require new dependencies in this package.
