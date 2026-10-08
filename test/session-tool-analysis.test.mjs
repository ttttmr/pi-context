import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { analyzeSessionSnapshot, parseSessionSnapshot } from '../tools/session-analysis/analyze-session.mjs';

function fixture() {
    const entries = [];
    const add = (id, parentId, extra) => {
        entries.push({ id, parentId, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, entries.length)).toISOString(), ...extra });
        return id;
    };
    const session = add('s', null, { type: 'session', cwd: '/work' });
    const assistant = (id, parent, calls = [], extra = {}) => add(id, parent, { type: 'message',
        message: { role: 'assistant', content: calls, ...extra } });
    const result = (id, parent, callId, text = 'ok', isError = false, extra = {}) => add(id, parent, { type: 'message',
        message: { role: 'toolResult', toolCallId: callId, isError, content: [{ type: 'text', text }], ...extra } });
    return { entries, add, assistant, result, session, analyze: () => analyzeSessionSnapshot(parseSessionSnapshot(
        Buffer.from(entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'))) };
}
const call = (id, name, args = {}) => ({ type: 'toolCall', id, name, arguments: args });
const read = (id, path, extra = {}) => call(id, 'read', { path, ...extra });
const hash = text => createHash('sha256').update(text).digest('hex');

test('empty tool and usage sessions retain the complete report array schema', () => {
    const data = fixture().analyze();
    for (const field of ['tools', 'milestones', 'compactAttempts', 'skillReads', 'points', 'usageRows']) {
        assert.deepEqual(data[field], []);
    }
    for (const field of ['toolCalls', 'toolErrors', 'unmatchedToolCalls', 'compactRequests', 'confirmedSkillReads']) {
        assert.equal(data.metadata[field], 0);
    }
});

for (const nestedCalls of [undefined, { complete: true, calls: [
    { id: 'outer/1', name: 'context_compact', status: 'ok', arguments: { summary: 'PRIVATE_NESTED_BODY' } },
] }, { complete: false, calls: [] }]) {
    test(`codemode metrics explicitly warn of partial coverage (${JSON.stringify(nestedCalls)})`, () => {
        const f = fixture();
        f.assistant('a', 's', [call('outer', 'codemode')]);
        f.result('r', 'a', 'outer', 'Script completed', false, {
            toolName: 'codemode', ...(nestedCalls ? { nestedCalls } : {}),
        });
        const data = f.analyze();
        const warnings = data.warnings.filter(warning => /Codemode nested tool calls are not analyzed/.test(warning));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /zero counts do not prove absence/);
        assert.match(warnings[0], /attribution, recovery, and threshold simulation are incomplete/);
        assert.deepEqual(data.tools.map(tool => tool.name), ['codemode']);
        assert.equal(JSON.stringify(data).includes('PRIVATE_NESTED_BODY'), false);
    });
}

test('tool results join interleaved calls by ID, with privacy-safe text counts and statuses', () => {
    const f = fixture();
    f.assistant('a', 's', [read('r', '/work/src/a.ts'), call('b', 'bash', { command: 'SECRET_COMMAND' }),
        call('pending', 'agent_send', { text: 'SECRET_AGENT_MESSAGE' }), call('unknown', 'extension_tool')]);
    f.result('br', 'a', 'b', 'SECRET_ERROR', true);
    f.result('rr', 'br', 'r', 'abc', false, { details: { truncation: { truncated: true } } });
    f.result('ur', 'rr', 'unknown', 'unknown', undefined, { isError: undefined });
    f.result('orphan', 'ur', 'absent', 'SECRET_ORPHAN');
    const data = f.analyze();
    assert.deepEqual(data.tools.map(tool => tool.status), ['success', 'error', 'no-result', 'unknown']);
    assert.deepEqual(data.tools.map(tool => tool.family), ['read', 'bash', 'agent', 'other']);
    assert.equal(data.tools[0].resultLine, 4);
    assert.equal(data.tools[0].outputChars, 3);
    assert.equal(data.tools[0].truncated, true);
    assert.equal(data.tools[0].resource, 'src/a.ts');
    assert.equal(data.tools[0].resourceId, hash('/work/src/a.ts'));
    assert.equal(data.metadata.toolErrors, 1);
    assert.equal(data.metadata.unmatchedToolCalls, 1);
    assert.ok(data.warnings.some(warning => /orphan/.test(warning)));
    assert.ok(data.warnings.some(warning => /unmatched tool/.test(warning)));
    assert.ok(!JSON.stringify(data).includes('SECRET_'));
    assert.equal(data.points.length, 0);
});

test('duplicate call IDs remain separate on sibling branches and nearest ancestor wins', () => {
    const f = fixture();
    f.assistant('a', 's', [read('dup', 'a')]);
    f.assistant('b', 's', [read('dup', 'b')]);
    f.result('ar', 'a', 'dup', 'first');
    f.result('br', 'b', 'dup', 'second');
    f.assistant('c', 'ar', [read('dup', 'c')]);
    f.result('cr', 'c', 'dup', 'third');
    f.result('wrong-branch', 's', 'dup', 'not matched');
    const data = f.analyze();
    assert.equal(new Set(data.tools.map(tool => tool.key)).size, 3);
    assert.deepEqual(data.tools.map(tool => tool.outputChars), [5, 6, 5]);
    assert.deepEqual(data.tools.map(tool => tool.resultLine), [4, 5, 7]);
    assert.ok(data.warnings.some(warning => /1 orphan/.test(warning)));
});

test('accepted interrupted compact without a branch is unconfirmed, not resumed', () => {
    const f = fixture();
    f.add('u', 's', { type: 'message', message: { role: 'user', content: 'PRIVATE_USER' } });
    f.assistant('c', 'u', [call('compact', 'context_compact', { target: 'u', summary: 'PRIVATE_SUMMARY' })]);
    f.result('r', 'c', 'compact', 'accepted');
    f.assistant('aborted', 'r', [], { usage: { input: 0, output: 0 }, stopReason: 'aborted' });
    const data = f.analyze();
    const attempt = data.compactAttempts[0];
    assert.equal(attempt.status, 'accepted');
    assert.equal(attempt.branchLine, null);
    assert.equal(attempt.continuationLine, null);
    assert.equal(attempt.targetId, 'u');
    assert.deepEqual(attempt.removedToolKeys, []);
    assert.equal(attempt.retainedToolCount, null);
    assert.match(data.warnings.join('\n'), /no branch.*unconfirmed/);
    assert.deepEqual(data.milestones.map(event => event.label), ['User turn']);
    assert.ok(!JSON.stringify(data).includes('PRIVATE_'));
});

function recoveryFixture() {
    const f = fixture();
    f.assistant('kept', 's', [read('k', 'kept.ts')]);
    f.result('kr', 'kept', 'k', 'retained');
    f.assistant('removed', 'kr', [read('d', 'removed.ts', { offset: 3, limit: 4 })]);
    f.result('dr', 'removed', 'd', 'removed evidence');
    f.assistant('compact', 'dr', [call('compact-call', 'context_compact', { target: 's', summary: 'SECRET_HANDOFF' })]);
    f.result('compact-result', 'compact', 'compact-call');
    f.assistant('interrupted', 'compact-result', [], { usage: { input: 0, output: 0 }, stopReason: 'aborted' });
    // Actual parent overrides the misleading argument: kept read really is retained.
    f.add('branch', 'kr', { type: 'branch_summary', fromId: 'interrupted', summary: 'SECRET_BRANCH_BODY' });
    f.assistant('resume', 'branch', [read('again', './removed.ts', { offset: 3, limit: 4 })], { usage: { input: 20, output: 1 } });
    f.result('again-result', 'resume', 'again', 'removed evidence');
    f.assistant('kept-again', 'again-result', [read('ka', 'kept.ts')]);
    f.result('ka-result', 'kept-again', 'ka', 'retained');
    return f;
}

test('actual compact branch ancestry identifies resumed, removed and retained evidence honestly', () => {
    const data = recoveryFixture().analyze();
    const attempt = data.compactAttempts[0];
    assert.equal(attempt.status, 'resumed');
    assert.equal(attempt.targetId, 'kr');
    assert.equal(attempt.targetLine, 3);
    assert.equal(attempt.branchLine, 9);
    assert.equal(attempt.continuationLine, 10);
    assert.deepEqual(attempt.removedToolKeys, [data.tools[1].key, data.tools[2].key]);
    assert.equal(attempt.retainedToolCount, 1);
    assert.deepEqual(attempt.followingToolKeys, [data.tools[3].key, data.tools[4].key]);
    assert.deepEqual(attempt.rereads, [
        { toolKey: data.tools[3].key, previousToolKey: data.tools[1].key, match: 'exact-output', removed: true },
        { toolKey: data.tools[4].key, previousToolKey: data.tools[0].key, match: 'exact-output', removed: false },
    ]);
    assert.equal(attempt.firstWorkToolKey, data.tools[3].key);
    assert.equal(data.milestones[0].fromId, 'interrupted');
    assert.equal(data.milestones[0].targetId, 'kr');
    assert.equal(data.milestones[0].fromLine, 8);
    assert.equal(data.milestones[0].targetLine, 3);
    assert.ok(!JSON.stringify(data).includes('SECRET_'));
});

test('rereads distinguish changed output, changed ranges, and failed reads; recovery stops at next compact', () => {
    const f = recoveryFixture();
    f.entries.find(entry => entry.id === 'again-result').message.content[0].text = 'new evidence';
    f.assistant('range', 'ka-result', [read('range', 'removed.ts', { offset: 20, limit: 1 })]);
    f.result('range-result', 'range', 'range', 'different range');
    f.assistant('failure', 'range-result', [read('fail', 'removed.ts')]);
    f.result('fail-result', 'failure', 'fail', 'secret error', true);
    f.assistant('next', 'fail-result', [call('next-compact', 'context_compact')]);
    f.assistant('late', 'next', [read('late-read', 'removed.ts')]);
    f.result('late-result', 'late', 'late-read', 'later');
    const data = f.analyze();
    const attempt = data.compactAttempts[0];
    assert.deepEqual(attempt.rereads.map(item => item.match), ['same-range', 'exact-output', 'same-resource']);
    assert.equal(attempt.followingToolKeys.length, 4);
});

test('recovery does not mix later sibling histories into the resulting action path', () => {
    const f = recoveryFixture();
    f.assistant('sibling', 'branch', [read('sibling-read', 'removed.ts')], { usage: { input: 10 } });
    f.result('sibling-result', 'sibling', 'sibling-read', 'removed evidence');
    const data = f.analyze();
    assert.equal(data.compactAttempts[0].followingToolKeys.length, 2);
    assert.ok(!data.compactAttempts[0].followingToolKeys.includes(data.tools.at(-1).key));
});

test('native compaction boundaries exclude uncertain earlier raw reads from reread evidence', () => {
    const f = fixture();
    f.assistant('old-read', 's', [read('old', 'a.ts')]);
    f.result('old-result', 'old-read', 'old', 'same evidence');
    f.add('native', 'old-result', { type: 'compaction', firstKeptEntryId: 'old-read', summary: 'private native body' });
    f.assistant('compact', 'native', [call('compact', 'context_compact', { target: 's' })]);
    f.result('compact-result', 'compact', 'compact');
    f.add('branch', 's', { type: 'branch_summary', fromId: 'compact-result', summary: 'private branch body' });
    f.assistant('new-read', 'branch', [read('new', 'a.ts')]);
    f.result('new-result', 'new-read', 'new', 'same evidence');
    const data = f.analyze();
    assert.ok(data.compactAttempts[0].removedToolKeys.includes(data.tools[0].key));
    assert.deepEqual(data.compactAttempts[0].rereads, []);
    assert.match(data.warnings.join('\n'), /native compaction.*raw visibility uncertain/);
});

test('prior read results must actually occur on replaced ancestry, not a sibling or later snapshot record', () => {
    for (const late of [false, true]) {
        const f = fixture();
        f.assistant('old-read', 's', [read('old', 'a.ts')]);
        if (!late) f.result('sibling-result', 'old-read', 'old', 'same evidence');
        f.assistant('compact', 'old-read', [call('compact', 'context_compact', { target: 's' })]);
        f.result('compact-result', 'compact', 'compact');
        f.add('branch', 's', { type: 'branch_summary', fromId: 'compact-result', summary: 'private branch body' });
        f.assistant('new-read', 'branch', [read('new', 'a.ts')]);
        f.result('new-result', 'new-read', 'new', 'same evidence');
        if (late) f.result('late-result', 'old-read', 'old', 'same evidence');
        const data = f.analyze();
        assert.equal(data.tools[0].status, 'success');
        assert.deepEqual(data.compactAttempts[0].rereads, []);
    }
});

test('intentional read pagination is partial file evidence, not output truncation', () => {
    const f = fixture();
    f.assistant('page', 's', [read('page', 'skills/context-management/SKILL.md', { offset: 1, limit: 200 })]);
    f.result('page-result', 'page', 'page', 'page content\n\n[100 more lines in file. Use offset=201 to continue.]');
    // Also test the returned marker independently of argument metadata.
    f.assistant('marker', 'page-result', [read('marker', 'skills/context-management/SKILL.md')]);
    f.result('marker-result', 'marker', 'marker', 'page content\n\n[100 more lines in file. Use offset=201 to continue.]');
    const data = f.analyze();
    assert.deepEqual(data.tools.map(tool => tool.truncated), [false, false]);
    assert.deepEqual(data.skillReads.map(skill => skill.complete), [false, false]);
});

test('skill read evidence is successful returned text, partial reads are not canonical content', () => {
    const f = fixture();
    f.assistant('a', 's', [read('partial', '/private/skills/context-management/SKILL.md', { offset: 3, limit: 2 }),
        read('full', 'skills/context-management/SKILL.md'), read('failed', 'skills/context-management/SKILL.md'),
        read('truncated', 'skills/context-management/SKILL.md')]);
    f.result('p', 'a', 'partial', 'SECRET_PARTIAL');
    f.result('full-result', 'p', 'full', 'SECRET_FULL');
    f.result('failed-result', 'full-result', 'failed', 'SECRET_ERROR', true);
    f.result('t', 'failed-result', 'truncated', '[Showing lines 1-2000 of 3000. Use offset=2001 to continue.]');
    const data = f.analyze();
    assert.equal(data.tools[0].resource, 'SKILL.md');
    assert.equal(data.metadata.confirmedSkillReads, 3);
    assert.deepEqual(data.skillReads.map(item => item.complete), [false, true, false]);
    assert.equal(data.skillReads[0].contentHash, hash('SECRET_PARTIAL'));
    assert.ok(!JSON.stringify(data).includes('SECRET_'));
    assert.ok(!JSON.stringify(data).includes('/private/'));
});

test('compact errors and positive aborted assistants never imply resumed work', () => {
    const f = recoveryFixture();
    const resume = f.entries.find(entry => entry.id === 'resume');
    resume.message.stopReason = 'aborted';
    assert.equal(f.analyze().compactAttempts[0].status, 'branched');
    f.entries.find(entry => entry.id === 'compact-result').message.isError = true;
    assert.equal(f.analyze().compactAttempts[0].status, 'error');
    assert.equal(f.analyze().compactAttempts[0].branchLine, null);
});

test('recovery is bounded to ten tools and sessions without usage still expose tools and milestones', () => {
    const f = recoveryFixture();
    let parent = 'ka-result';
    for (let i = 0; i < 12; i++) {
        parent = f.assistant(`work-${i}`, parent, [call(`call-${i}`, 'bash', { command: 'PRIVATE_COMMAND' })]);
        parent = f.result(`result-${i}`, parent, `call-${i}`);
    }
    for (const entry of f.entries) if (entry.message) delete entry.message.usage;
    f.add('native', parent, { type: 'compaction', summary: 'PRIVATE_NATIVE_SUMMARY' });
    const data = f.analyze();
    assert.equal(data.points.length, 0);
    assert.equal(data.metadata.cumulativeTokens, 0);
    assert.equal(data.compactAttempts[0].followingToolKeys.length, 10);
    assert.equal(data.compactAttempts[0].status, 'branched');
    assert.deepEqual(data.milestones.map(item => item.kind), ['branch', 'native-compaction']);
    assert.ok(!JSON.stringify(data).includes('PRIVATE_'));
});
