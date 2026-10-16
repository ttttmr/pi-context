import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Exercise the actual capture fixture under Pi's RPC stdout guard without a paid model call.
test("live context capture uses IPC while Pi redirects extension stdout to stderr", { timeout: 10000 }, async (t) => {
    const source = await readFile(new URL("./live-context-capture-extension.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
    const fixtureUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
    const guardUrl = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/output-guard.js", import.meta.url).href;
    const messages = [{ role: "user", content: "CAPTURE_CANARY", timestamp: 1 }];
    const script = `
        import { takeOverStdout } from ${JSON.stringify(guardUrl)};
        takeOverStdout();
        const { default: register } = await import(${JSON.stringify(fixtureUrl)});
        let capture;
        register({ on: (event, handler) => {
            if (event !== "context") throw new Error("Unexpected capture event");
            capture = handler;
        } });
        capture({ messages: ${JSON.stringify(messages)} });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const captured = [];
    let stdout = "", stderr = "";
    child.on("message", (event) => captured.push(event));
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    assert.deepEqual(captured, [{ type: "context_test_request", messages }]);
    assert.equal(stdout, "", "capture must not mix with the RPC protocol");
    assert.equal(stderr, "", "capture must not be redirected into diagnostics");
});
