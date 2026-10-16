import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Capture model context after pi-context has applied its hidden ranges; load this fixture last. */
export default function registerLiveContextCapture(pi: ExtensionAPI) {
    pi.on("context", (event) => {
        if (!process.send) throw new Error("Live context capture requires the harness IPC channel");
        process.send({ type: "context_test_request", messages: event.messages });
    });
}
