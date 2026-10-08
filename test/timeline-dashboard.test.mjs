import assert from "node:assert/strict";
import test from "node:test";

import registerContext from "../dist/index.js";
import registerDashboard from "../dist/context.js";

for (const params of [{}, { verbose: true }, { limit: 1 }]) {
    test(`timeline displays or estimates retained codemode output (${JSON.stringify(params)})`, async () => {
        const tools = new Map();
        registerContext({ registerTool: tool => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {} });
        const entries = [
            { id: "prefix", type: "message", message: { role: "user", content: "keep" } },
            { id: "internal", type: "custom_message", customType: "pi-context", content: "INTERNAL_CANARY" },
            { id: "retained", type: "custom_message", customType: "pi-context-codemode-output",
                content: [{ type: "text", text: "OUTPUT_CANARY " + "x".repeat(40000) }] },
            { id: "summary", type: "branch_summary", summary: "Earlier state", fromId: "old-path" },
        ];
        const result = await tools.get("context_timeline").execute("timeline", params, undefined, undefined, {
            sessionManager: {
                getBranch: () => entries, getLeafId: () => "summary", getChildren: () => [], getLabel: () => undefined,
            },
            getContextUsage: () => undefined,
        });
        const text = result.content[0].text;
        assert.match(text, /~10k tokens/);
        assert.doesNotMatch(text, /INTERNAL_CANARY/);
        if (params.limit) assert.doesNotMatch(text, /OUTPUT_CANARY/);
        else {
            assert.match(text, /retained.*\[TOOL\].*codemode output.*OUTPUT_CANARY/);
            assert.ok(text.indexOf("retained") < text.indexOf("summary"));
        }
    });
}

for (const retained of [false, true]) {
    test(`dashboard counts ${retained ? "retained codemode" : "native tool"} output in Tool Call category`, async () => {
        const commands = new Map();
        registerDashboard({
            registerCommand: (name, definition) => commands.set(name, definition),
            getActiveTools: () => [], getAllTools: () => [],
        });
        const content = [{ type: "text", text: "x".repeat(40000) }];
        const entry = retained ? { type: "custom_message", customType: "pi-context-codemode-output", content }
            : { type: "message", message: { role: "toolResult", toolName: "read", content } };
        let rendered;
        await commands.get("context").handler("", {
            sessionManager: { getBranch: () => [entry] }, getSystemPrompt: () => "",
            getContextUsage: () => ({ tokens: 10000, contextWindow: 20000, percent: 50 }),
            ui: {
                notify: () => assert.fail("usage is available"),
                custom: async factory => {
                    const theme = { fg: (_color, value) => value, bold: value => value };
                    const component = factory({}, theme, {}, () => {});
                    rendered = component.render(120).join("\n");
                },
            },
        });
        assert.ok(rendered);
        assert.match(rendered, /Tool Call\s+10k/);
        assert.doesNotMatch(rendered, /System Tools\s+10k/);
    });
}

for (const checkpoint of [undefined, "review-start"]) {
    test(`timeline reports structure without compact advice (${checkpoint ?? "no checkpoint"})`, async () => {
        const tools = new Map();
        registerContext({
            registerTool: (tool) => tools.set(tool.name, tool),
            registerCommand: () => {},
            on: () => {},
        });
        const entries = [
            { id: "aaaaaaaa", type: "message", message: { role: "user", content: "Review the patch" } },
            { id: "bbbbbbbb", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Tests passed" }] } },
        ];
        const result = await tools.get("context_timeline").execute("timeline", {}, undefined, undefined, {
            sessionManager: {
                getBranch: () => entries,
                getLeafId: () => "bbbbbbbb",
                getChildren: () => [],
                getLabel: (id) => id === "aaaaaaaa" ? checkpoint : undefined,
            },
            getContextUsage: () => undefined,
        });
        const text = result.content[0].text;
        assert.match(text, /^Context: Unknown$/m);
        assert.match(text, /aaaaaaaa.*ROOT.*Review the patch/);
        assert.match(text, /bbbbbbbb.*HEAD.*Tests passed/);
        if (checkpoint) assert.match(text, /aaaaaaaa.*checkpoint: review-start.*phase: start/);
        assert.doesNotMatch(text, /compact/i);
    });
}
