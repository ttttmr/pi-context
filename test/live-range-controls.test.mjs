import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Native summaries do not use the ordinary request event: exercise the provider observer directly.
test("live native observer forwards the original provider context and options and restores the stream", { timeout: 10000 }, async (t) => {
    const source = await readFile(new URL("./live-range-controls-extension.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const fixtureUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
    const script = `
        import assert from 'node:assert/strict';
        const { default: register } = await import(${JSON.stringify(fixtureUrl)});
        const handlers = new Map();
        register({ on: (event, handler) => handlers.set(event, handler), registerCommand: () => {} });
        const model = { provider: 'probe', id: 'real-forwarding' };
        const context = { messages: [{ role: 'user', content: 'PROVIDER_INPUT', timestamp: 1 }] };
        const options = { signal: new AbortController().signal, marker: {} };
        const result = {};
        let calls = 0;
        const original = function (actualModel, actualContext, actualOptions) {
            assert.equal(this, provider);
            assert.equal(actualModel, model);
            assert.equal(actualContext, context);
            assert.equal(actualOptions, options);
            calls++;
            return result;
        };
        const provider = { streamSimple: original };
        const ctx = { modelRegistry: { getAll: () => [model], getProvider: () => provider } };
        handlers.get('session_before_compact')({ reason: 'manual', preparation: {
            messagesToSummarize: [], turnPrefixMessages: [], firstKeptEntryId: 'kept',
            isSplitTurn: false, fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        } }, ctx);
        assert.equal(provider.streamSimple(model, context, options), result);
        handlers.get('session_compact')({ reason: 'manual', compactionEntry: { fromHook: false } });
        assert.equal(provider.streamSimple(model, context, options), result);
        handlers.get('session_shutdown')();
        assert.equal(provider.streamSimple, original);
        assert.equal(calls, 2);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const captured = [];
    let stderr = "";
    child.on("message", (event) => captured.push(event));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    assert.deepEqual(captured.map((event) => event.type), [
        "range_test_native_input", "range_test_native_request", "range_test_native_done",
    ]);
    assert.equal(captured[1].context.messages[0].content, "PROVIDER_INPUT");
});
