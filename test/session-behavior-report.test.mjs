import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Script } from 'node:vm';

const cli = 'tools/session-analysis/session-analysis-cli.mjs';

test('behavior report renders calls without positive usage and exports only safe evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-behavior-test-'));
    try {
        const secret = 'private-command-and-error-body-do-not-export';
        const entries = [
            { type: 'session', id: 'session', cwd: '/workspace', timestamp: '2026-01-01T00:00:00Z' },
            { type: 'message', id: 'a', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [
                { type: 'toolCall', id: 'shell', name: 'bash', arguments: { command: secret } },
            ] } },
            { type: 'message', id: 'b', parentId: 'a', timestamp: '2026-01-01T00:00:02Z', message: {
                role: 'toolResult', toolCallId: 'shell', toolName: 'bash', isError: true, content: [{ type: 'text', text: secret }],
            } },
        ];
        const input = join(directory, 'session.jsonl'), output = join(directory, 'report');
        await writeFile(input, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
        const result = JSON.parse(execFileSync(process.execPath, [cli, input, '--out', output], { encoding: 'utf8' }));
        assert.equal(result.validRequests, 0);
        assert.equal(result.toolCalls, 1);
        assert.equal(result.toolErrors, 1);
        const html = await readFile(join(output, 'session-token-chart.html'), 'utf8');
        const data = JSON.parse(await readFile(join(output, 'session-token-data.json'), 'utf8'));
        assert.equal(data.tools[0].status, 'error');
        assert.equal(data.tools[0].outputChars, secret.length);
        assert.ok(!JSON.stringify(data).includes(secret));
        assert.ok(!html.includes(secret));
        for (const id of ['overview', 'tool-chart', 'context-chart', 'tool-rows', 'compact-list', 'detail']) {
            assert.ok(html.includes(`id="${id}"`));
        }
        for (const match of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)) {
            if (!match[0].includes('application/json')) assert.doesNotThrow(() => new Script(match[1]));
        }
        const tools = await readFile(join(output, 'session-tool-calls.csv'), 'utf8');
        assert.match(tools, /"bash"/);
        assert.match(tools, /"error"/);
        assert.ok(!tools.includes(secret));
        for (const name of ['session-compact-attempts.csv', 'session-rereads.csv']) {
            assert.equal((await readFile(join(output, name), 'utf8')).trim().split('\n').length, 1);
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI, JSON and HTML retain the codemode partial-analysis warning', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-codemode-warning-'));
    try {
        const entries = [
            { type: 'session', id: 's', timestamp: '2026-01-01T00:00:00Z' },
            { type: 'message', id: 'a', parentId: 's', timestamp: '2026-01-01T00:00:01Z', message: {
                role: 'assistant', content: [{ type: 'toolCall', id: 'outer', name: 'codemode', arguments: {} }],
            } },
            { type: 'message', id: 'r', parentId: 'a', timestamp: '2026-01-01T00:00:02Z', message: {
                role: 'toolResult', toolName: 'codemode', toolCallId: 'outer', isError: false,
                content: [{ type: 'text', text: 'Script completed' }], nestedCalls: { complete: false, calls: [] },
            } },
        ];
        const input = join(directory, 'session.jsonl'), output = join(directory, 'report');
        await writeFile(input, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
        const result = JSON.parse(execFileSync(process.execPath, [cli, input, '--out', output], { encoding: 'utf8' }));
        const data = JSON.parse(await readFile(join(output, 'session-token-data.json'), 'utf8'));
        assert.equal(result.toolCalls, 1);
        assert.deepEqual(data.tools.map(tool => tool.name), ['codemode']);
        const warning = data.warnings.find(value => /Codemode nested tool calls are not analyzed/.test(value));
        assert.ok(warning);
        assert.ok(result.warnings.includes(warning));
        assert.ok((await readFile(join(output, 'session-token-chart.html'), 'utf8')).includes(warning));
    } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const header of [true, false]) test(`empty ${header ? 'session' : 'file'} creates a zero-activity report without inventing observations`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-empty-test-'));
    try {
        const input = join(directory, 'empty.jsonl'), output = join(directory, 'report');
        await writeFile(input, header ? JSON.stringify({ type: 'session', id: 'empty', timestamp: '2026-01-01T00:00:00Z' }) + '\n' : '');
        const result = JSON.parse(execFileSync(process.execPath, [cli, input, '--out', output], { encoding: 'utf8' }));
        assert.equal(result.toolCalls, 0);
        assert.equal(result.validRequests, 0);
        const data = JSON.parse(await readFile(join(output, 'session-token-data.json'), 'utf8'));
        assert.deepEqual(data.tools, []);
        assert.deepEqual(data.compactAttempts, []);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
