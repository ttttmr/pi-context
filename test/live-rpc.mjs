import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Shared harness for opt-in live tests: real models, existing Pi auth, costs tokens.
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Machine-specific settings stay in the gitignored .pi/live-test.json:
 * { "model": "provider/id", "extensions": ["~/path/to/provider-extension.ts"] }.
 * Environment variables override it.
 */
export async function loadLiveConfig() {
    const path = resolve(root, ".pi/live-test.json");
    const local = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
    const model = process.env.PI_CONTEXT_TEST_MODEL || local.model || "codex/gpt-5.6-luna";
    // Extra extensions that only register the model provider.
    const extensions = (process.env.PI_CONTEXT_TEST_EXTENSIONS?.split(delimiter) ?? local.extensions ?? [])
        .filter(Boolean).map((entry) => entry.replace(/^~(?=\/|$)/, homedir()));
    return { model, extensions };
}

export function text(message) {
    return typeof message.content === "string" ? message.content :
        (message.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

/**
 * Start an isolated Pi RPC process. `settings` creates a private agent dir (for
 * example codemode.mode) that links the user's auth and model files.
 */
export async function startPi({ name, artifacts, model, extensions = [], sessionFile, tools, settings,
    extraArgs = [], systemPrompt }) {
    const args = [
        resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
        "--offline", "--mode", "rpc", "--model", model, "--thinking", "low",
        "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
        ...(tools ? ["--tools", tools.join(",")] : ["--no-builtin-tools"]),
        ...extensions.flatMap((path) => ["-e", path]), "-e", resolve(root, "src/index.ts"), ...extraArgs,
        "--system-prompt", systemPrompt ?? "Execute the requested integration test exactly. Keep output minimal. After compaction obey the summary's next step; never repeat completed tool calls.",
        ...(sessionFile ? ["--session", sessionFile] : ["--session-dir", resolve(artifacts, name)]),
    ];
    const env = { ...process.env };
    if (settings) {
        const agentDir = resolve(artifacts, `${name}-agent`);
        await mkdir(agentDir, { recursive: true });
        await writeFile(resolve(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
        const userDir = process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi/agent");
        for (const file of ["auth.json", "models.json", "models-store.json"]) {
            if (existsSync(resolve(userDir, file))) await symlink(resolve(userDir, file), resolve(agentDir, file));
        }
        env.PI_CODING_AGENT_DIR = agentDir;
    }
    const events = [];
    const pending = new Map();
    let sequence = 0, stderr = "", buffer = "";
    const child = spawn(process.execPath, args, { cwd: artifacts, stdio: ["pipe", "pipe", "pipe"], env });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const event = JSON.parse(line);
            events.push(event);
            if (event.type === "response" && pending.has(event.id)) {
                const { resolve, reject } = pending.get(event.id);
                pending.delete(event.id);
                if (event.success) resolve(event.data);
                else reject(new Error(event.error));
            }
        }
    });
    const exited = once(child, "exit");
    child.on("exit", (code, signal) => {
        for (const { reject } of pending.values()) reject(new Error(`Pi exited: ${code}/${signal}; ${stderr}`));
        pending.clear();
    });
    const pi = {
        events,
        get stderr() { return stderr; },
        async request(type, fields = {}, timeoutMs = 30000) {
            assert.equal(child.exitCode, null, stderr);
            const id = String(++sequence);
            let timeout;
            try {
                return await new Promise((resolve, reject) => {
                    pending.set(id, { resolve, reject });
                    timeout = setTimeout(() => {
                        pending.delete(id);
                        reject(new Error(`RPC ${type} timed out; ${stderr}`));
                    }, timeoutMs);
                    child.stdin.write(JSON.stringify({ type, id, ...fields }) + "\n");
                });
            } finally { clearTimeout(timeout); }
        },
        /** Wait until the run settles: no stream, no queued input. */
        async waitIdle(offset, timeoutMs = 180000) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                await delay(500);
                if (!events.slice(offset).some((event) => event.type === "agent_end")) continue;
                const state = await pi.request("get_state");
                if (!state.isStreaming && state.pendingMessageCount === 0) return;
            }
            throw new Error(`run did not settle within ${timeoutMs}ms`);
        },
        async waitFor(offset, predicate, timeoutMs = 120000) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const found = events.slice(offset).find(predicate);
                if (found) return found;
                await delay(100);
            }
            throw new Error("expected event did not arrive");
        },
        /**
         * Send a prompt and wait for the run to settle; returns the events of that run.
         * A model that degenerates into an endless stream is aborted and the prompt retried once.
         */
        async prompt(message, { retries = 1, timeoutMs = 180000 } = {}) {
            for (let attempt = 0; ; attempt++) {
                const offset = events.length;
                await pi.request("prompt", { message });
                try {
                    await pi.waitIdle(offset, timeoutMs);
                    return events.slice(offset);
                } catch (error) {
                    if (attempt >= retries) throw error;
                    console.error(`${name}: run stalled, aborting and retrying the prompt`);
                    const abortOffset = events.length;
                    await pi.request("abort");
                    await pi.waitIdle(abortOffset > offset ? offset : abortOffset, 30000).catch(() => {});
                }
            }
        },
        async close(artifacts) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            const killTimeout = setTimeout(() => child.kill("SIGKILL"), 5000);
            try { await exited; } finally { clearTimeout(killTimeout); }
            if (artifacts) {
                await writeFile(resolve(artifacts, `${name}.events.jsonl`), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
                await writeFile(resolve(artifacts, `${name}.stderr.log`), stderr);
            }
        },
    };
    return pi;
}
