import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";

export default function registerPassiveCustomEntry(pi: ExtensionAPI) {
    pi.on("agent_end", async (_event, ctx) => {
        const sessionManager = ctx.sessionManager as SessionManager;
        sessionManager.appendCustomEntry("pi-context-passive-canary", { passive: true });
    });
}
