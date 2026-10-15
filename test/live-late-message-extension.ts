import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Queue contextual input while the compact step ends; it must survive after the summary. */
export default function registerLateMessageProbe(pi: ExtensionAPI) {
    let injected = false;
    pi.on("turn_end", (event) => {
        if (injected || !event.message.content.some((block) =>
            block.type === "toolCall" && block.name === "context_compact")) return;
        injected = true;
        pi.sendMessage({
            customType: "live-late-canary",
            content: "LATE_CANARY: this message arrived while compaction was finishing. It needs no action.",
            display: false,
        }, { deliverAs: "steer" });
    });
}
