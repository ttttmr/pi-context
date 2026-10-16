import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";

/** Observe native summarization after pi-context filters it, and exercise real tree navigation. */
export default function registerLiveRangeControls(pi: ExtensionAPI) {
    let summarizing = false;
    const report = (event: Record<string, unknown>) => {
        if (!process.send) throw new Error("Live range controls require the harness IPC channel");
        process.send(event);
    };
    const streams = new Map<Provider, Provider["streamSimple"]>();
    pi.on("session_before_compact", (event, ctx) => {
        summarizing = true;
        // Native summaries bypass the agent loop's before_provider_request callback.
        // Observe the actual provider call while forwarding its context/options untouched.
        for (const id of new Set(ctx.modelRegistry.getAll().map((model) => model.provider))) {
            const provider = ctx.modelRegistry.getProvider(id);
            if (!provider || streams.has(provider)) continue;
            const stream = provider.streamSimple;
            streams.set(provider, stream);
            provider.streamSimple = function (model, context, options) {
                if (summarizing) report({ type: "range_test_native_request", model: `${model.provider}/${model.id}`, context });
                return stream.call(this, model, context, options);
            };
        }
        const { preparation } = event;
        report({
            type: "range_test_native_input", reason: event.reason,
            messages: preparation.messagesToSummarize,
            prefix: preparation.turnPrefixMessages,
            previousSummary: preparation.previousSummary,
            firstKeptEntryId: preparation.firstKeptEntryId,
            split: preparation.isSplitTurn,
            files: {
                read: [...preparation.fileOps.read], written: [...preparation.fileOps.written],
                edited: [...preparation.fileOps.edited],
            },
        });
    });
    pi.on("session_shutdown", () => {
        for (const [provider, stream] of streams) provider.streamSimple = stream;
        streams.clear();
    });
    pi.on("session_compact", (event) => {
        summarizing = false;
        report({ type: "range_test_native_done", reason: event.reason, entry: event.compactionEntry });
    });
    pi.on("session_compact_failed", () => { summarizing = false; });
    pi.registerCommand("range-test-navigate", {
        description: "Test-only navigation without a branch summary",
        handler: async (targetId, ctx) => {
            const result = await ctx.navigateTree(targetId, { summarize: false });
            report({ type: "range_test_navigated", targetId, ...result });
        },
    });
}
