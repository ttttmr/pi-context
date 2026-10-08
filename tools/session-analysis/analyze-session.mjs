import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

const inputFields = ['input', 'cacheRead', 'cacheWrite'];
const usageFields = [...inputFields, 'output'];

/** Parse a read-only JSONL snapshot; only an incomplete final physical line is recoverable. */
export function parseSessionSnapshot(buffer, maxLines = Infinity) {
    if (!(maxLines === Infinity || (Number.isSafeInteger(maxLines) && maxLines > 0))) {
        throw new Error('Session snapshot max-lines must be a positive integer');
    }
    const lines = buffer.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const selected = lines.slice(0, maxLines);
    const entries = [];
    const warnings = [];
    selected.forEach((line, index) => {
        if (!line.trim()) return;
        try {
            const entry = JSON.parse(line);
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Expected an object');
            entries.push({ ...entry, line: index + 1 });
        } catch (error) {
            if (index === lines.length - 1 && !line.endsWith('\n')) {
                warnings.push(`Ignored incomplete final line ${index + 1}: invalid JSON object`);
            } else {
                throw new Error(`Session JSONL invalid at line ${index + 1}: expected a JSON object`);
            }
        }
    });
    return {
        entries, warnings, snapshotLines: selected.length,
        snapshotSha256: createHash('sha256').update(selected.join('')).digest('hex'),
    };
}

function readSessionUsage(usage, line, warnings) {
    if (!usage || typeof usage !== 'object') return null;
    if (!usageFields.some(field => Object.hasOwn(usage, field))) {
        warnings.push(`Line ${line}: usage has no recognized token breakdown; excluded`);
        return null;
    }
    if (usageFields.some(field => !Number.isFinite(usage[field] ?? 0) || (usage[field] ?? 0) < 0)) {
        warnings.push(`Line ${line}: invalid token counts; excluded`);
        return null;
    }
    const counts = Object.fromEntries(usageFields.map(field => [field, usage[field] ?? 0]));
    const context = inputFields.reduce((sum, field) => sum + counts[field], 0);
    const total = context + counts.output;
    if (usage.totalTokens !== undefined && usage.totalTokens !== total) {
        warnings.push(`Line ${line}: totalTokens differs from token breakdown; using breakdown`);
    }
    return { ...counts, context, total };
}

function toolCalls(entry) {
    const content = entry?.message?.content;
    return Array.isArray(content) ? content.filter(block => block?.type === 'toolCall') : [];
}

// A successful branch must originate beside the call, not merely follow a stale call in the file.
function findOriginCall(startId, entriesById, predicate) {
    const seen = new Set();
    let entry = entriesById.get(startId);
    while (entry && !seen.has(entry.id)) {
        seen.add(entry.id);
        if (entry.message?.role === 'toolResult' && entry.message.isError) return null;
        const call = toolCalls(entry).find(predicate);
        if (call) return call;
        if (entry.message?.role === 'assistant' && inputFields.some(field => entry.message.usage?.[field] > 0)) return null;
        if (entry.type === 'branch_summary' || entry.type === 'compaction') return null;
        entry = entriesById.get(entry.parentId);
    }
    return null;
}

// Keep raw arguments and returned text inside this analyzer; reports contain evidence, not bodies.
function sessionTextHash(text) {
    return createHash('sha256').update(text).digest('hex');
}

function sessionToolFamily(name) {
    if (name.startsWith('context_')) return 'context';
    if (name === 'read' || name === 'functions.read') return 'read';
    if (['edit', 'write', 'functions.edit', 'functions.write'].includes(name)) return 'change';
    if (name === 'bash' || name === 'functions.bash') return 'bash';
    if (/^(?:functions\.)?agent_/.test(name)) return 'agent';
    return 'other';
}

function sessionResourceEvidence(path, cwd) {
    if (typeof path !== 'string' || !path || /[\x00-\x1f]/.test(path)) return { resource: null, resourceId: null };
    const paths = /^[a-z]:[\\/]/i.test(cwd ?? '') || /^[a-z]:[\\/]/i.test(path) ? win32 : posix;
    // Resolve lexically only: never inspect the filesystem or the analyst's current directory.
    const base = typeof cwd === 'string' && paths.isAbsolute(cwd) ? cwd : null;
    const normalized = paths.isAbsolute(path) ? paths.normalize(path) : base ? paths.resolve(base, path) : paths.normalize(path);
    const relative = base ? paths.relative(base, normalized) : normalized;
    const inside = !paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`);
    return { resource: (inside ? relative : paths.basename(normalized)).replaceAll('\\', '/'),
        resourceId: sessionTextHash(normalized) };
}

function sessionResultText(message) {
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) return null;
    return message.content.filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text).join('');
}

function sessionResultTruncated(message, text) {
    return message.details?.truncation?.truncated === true || message.details?.truncated === true
        || message.details?.truncation?.firstLineExceedsLimit === true
        || /\[(?:Showing (?:lines|first|last)|Output truncated)|\[Line \d+ .*exceeds .* limit|\[.*(?:output truncated|truncated to)/i.test(text ?? '');
}

// Parent traversal is the identity boundary: equal toolCallId values on sibling branches never join.
function sessionAncestry(startId, entriesById) {
    const path = [], seen = new Set();
    let entry = entriesById.get(startId);
    while (entry && !seen.has(entry.id)) {
        seen.add(entry.id);
        path.push(entry);
        entry = entriesById.get(entry.parentId);
    }
    return path;
}

function analyzeSessionTools(entries, entriesById, checkpoints, warnings) {
    const cwd = entries.find(entry => entry.type === 'session')?.cwd;
    const tools = [], milestones = [], skillReads = [], compactAttempts = [];
    const privateTools = new Map(), toolsByEntry = new Map();
    let orphanResults = 0;
    for (const entry of entries) {
        const base = { line: entry.line, time: Date.parse(entry.timestamp), entryId: entry.id ?? null };
        const kind = entry.message?.role === 'user' ? 'user' : entry.type === 'branch_summary' ? 'branch'
            : entry.type === 'compaction' ? 'native-compaction' : null;
        if (kind) milestones.push({ ...base, kind, label: kind === 'user' ? 'User turn'
            : kind === 'branch' ? 'Branch summary' : 'Native compaction',
            ...(kind === 'branch' ? { fromId: entry.fromId ?? null, targetId: entry.parentId ?? null,
                fromLine: entriesById.get(entry.fromId)?.line ?? null,
                targetLine: entriesById.get(entry.parentId)?.line ?? null } : {}) });
        if (entry.message?.role !== 'assistant') continue;
        const entryTools = toolCalls(entry).map((call, index) => {
            const name = typeof call.name === 'string' ? call.name : 'unknown';
            const family = sessionToolFamily(name);
            const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
            const resource = ['read', 'change'].includes(family) ? sessionResourceEvidence(args.path, cwd)
                : { resource: null, resourceId: null };
            const tool = { ...base, key: `tool-${entry.line}-${index}`, timestamp: entry.timestamp,
                callId: typeof call.id === 'string' ? call.id : null, name, family,
                requestLine: entry.line, resultLine: null, resultTime: null, status: 'no-result',
                outputChars: null, truncated: false, ...resource,
                readOffset: family === 'read' && Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : null,
                readLimit: family === 'read' && Number.isSafeInteger(args.limit) && args.limit > 0 ? args.limit : null };
            privateTools.set(tool.key, { call, entry, text: null, contentHash: null });
            tools.push(tool);
            return tool;
        });
        toolsByEntry.set(entry.id, entryTools);
    }
    for (const entry of entries) {
        const message = entry.message;
        if (message?.role !== 'toolResult') continue;
        let tool;
        if (typeof message.toolCallId === 'string') {
            for (const ancestor of sessionAncestry(entry.parentId, entriesById)) {
                const matches = (toolsByEntry.get(ancestor.id) ?? []).filter(candidate => candidate.callId === message.toolCallId);
                if (matches.length) {
                    // Ambiguous duplicate IDs within one assistant message cannot be resolved honestly.
                    if (matches.length === 1 && matches[0].resultLine === null && matches[0].line < entry.line) tool = matches[0];
                    break;
                }
            }
        }
        if (!tool) { orphanResults++; continue; }
        const text = sessionResultText(message);
        Object.assign(tool, { resultLine: entry.line, resultTime: Date.parse(entry.timestamp),
            status: message.isError === true ? 'error' : message.isError === false ? 'success' : 'unknown',
            outputChars: text?.length ?? null, truncated: sessionResultTruncated(message, text) });
        Object.assign(privateTools.get(tool.key), { text, resultEntryId: entry.id ?? null,
            contentHash: text === null ? null : sessionTextHash(text) });
        if (tool.family === 'read' && tool.status === 'success' && text !== null && text.length > 0
            && /(?:^|[\\/])context-management[\\/]SKILL\.md$/.test(privateTools.get(tool.key).call.arguments?.path ?? '')) {
            skillReads.push({ toolKey: tool.key, line: tool.line, time: tool.time, resource: tool.resource,
                contentHash: text === null ? null : sessionTextHash(text),
                complete: text !== null && text.length > 0 && !tool.truncated && (tool.readOffset ?? 1) === 1
                    && tool.readLimit === null && !/\[(?:\d+ more lines|Showing )/i.test(text) });
        }
    }
    for (const tool of tools.filter(tool => tool.name === 'context_compact')) {
        const { call, entry } = privateTools.get(tool.key);
        const args = call.arguments ?? {};
        const branch = entries.find(candidate => candidate.type === 'branch_summary' && candidate.line > tool.line
            && tool.status !== 'error' && findOriginCall(candidate.fromId, entriesById, origin => origin.name === 'context_compact') === call);
        const oldPath = sessionAncestry(branch?.fromId ?? entry.id, entriesById);
        const oldIds = new Set(oldPath.map(ancestor => ancestor.id));
        const nativeBoundary = oldPath.find(ancestor => ancestor.type === 'compaction');
        if (branch && nativeBoundary) warnings.push(`Line ${tool.line}: prior native compaction makes raw visibility uncertain; removed tools describe historical ancestry, and pre-compaction reads are excluded from reread evidence`);
        // Only the actual branch parent proves what was retained. Pending targets are intentions only.
        let targetId = branch ? branch.parentId ?? null : null;
        if (!branch && typeof args.target === 'string') {
            const named = checkpoints.findLast(checkpoint => checkpoint.line <= tool.line && checkpoint.name === args.target);
            targetId = args.target.toLowerCase() === 'root' ? oldPath.findLast(ancestor => ancestor.type !== 'session')?.id ?? null
                : named?.targetId ?? (entriesById.has(args.target) ? args.target : null);
        }
        const retainedIds = new Set(branch ? sessionAncestry(branch.parentId, entriesById).map(ancestor => ancestor.id) : []);
        const removedTools = branch ? tools.filter(candidate => oldIds.has(candidate.entryId) && !retainedIds.has(candidate.entryId)) : [];
        const target = entriesById.get(targetId);
        const descendants = [], branchPathIds = new Set(branch ? [branch.id] : []);
        // Session parents precede their children, so descendant membership needs only one file-order pass.
        for (const candidate of entries) {
            if (branch && candidate.line > branch.line && branchPathIds.has(candidate.parentId)) {
                descendants.push(candidate);
                branchPathIds.add(candidate.id);
            }
        }
        const continuation = descendants.find(candidate => candidate.message?.role === 'assistant'
            && !['error', 'aborted'].includes(candidate.message.stopReason) && candidate.message.isError !== true
            && inputFields.some(field => candidate.message.usage?.[field] > 0));
        const descendantIds = new Set(descendants.map(candidate => candidate.id));
        const following = [];
        for (const candidate of tools) {
            if (!descendantIds.has(candidate.entryId)) continue;
            const previous = following.at(-1);
            // Once recovery takes a path, sibling histories are not subsequent actions on that path.
            if (previous && candidate.entryId !== previous.entryId
                && !sessionAncestry(candidate.entryId, entriesById).some(ancestor => ancestor.id === previous.entryId)) continue;
            if (candidate.name === 'context_compact' || following.length >= 10) break;
            following.push(candidate);
        }
        const rereads = [];
        for (const current of following.filter(candidate => candidate.family === 'read' && candidate.status === 'success' && candidate.resourceId)) {
            const previous = tools.filter(candidate => oldIds.has(candidate.entryId) && candidate.family === 'read'
                && candidate.status === 'success' && candidate.resourceId === current.resourceId
                && oldIds.has(privateTools.get(candidate.key).resultEntryId)
                && candidate.resultLine < branch.line
                // Native retained-tail formats vary; never infer pre-compaction raw visibility from ancestry alone.
                && (!nativeBoundary || candidate.line > nativeBoundary.line));
            const currentPrivate = privateTools.get(current.key);
            const matchRank = candidate => currentPrivate.contentHash !== null
                && currentPrivate.contentHash === privateTools.get(candidate.key).contentHash ? 3
                : (candidate.readOffset ?? 1) === (current.readOffset ?? 1) && candidate.readLimit === current.readLimit ? 2 : 1;
            // Prefer replaced evidence, then the strongest match, then the most recent observation.
            previous.sort((a, b) => Number(!retainedIds.has(b.entryId)) - Number(!retainedIds.has(a.entryId))
                || matchRank(b) - matchRank(a) || b.line - a.line);
            if (previous.length) {
                const prior = previous[0];
                rereads.push({ toolKey: current.key, previousToolKey: prior.key,
                    match: ['same-resource', 'same-range', 'exact-output'][matchRank(prior) - 1], removed: !retainedIds.has(prior.entryId) });
            }
        }
        const status = tool.status === 'error' ? 'error' : continuation ? 'resumed' : branch ? 'branched'
            : tool.status === 'success' ? 'accepted' : 'requested';
        compactAttempts.push({ key: tool.key, line: tool.line, time: tool.time, callId: tool.callId, status,
            resultLine: tool.resultLine, branchLine: branch?.line ?? null, continuationLine: continuation?.line ?? null,
            targetId, targetLine: target?.line ?? null,
            targetName: checkpoints.findLast(checkpoint => checkpoint.targetId === targetId && checkpoint.line <= (branch?.line ?? tool.line))?.name ?? null,
            summaryChars: branch && typeof branch.summary === 'string' ? branch.summary.length
                : typeof args.summary === 'string' ? args.summary.length : null,
            removedToolKeys: removedTools.map(candidate => candidate.key),
            retainedToolCount: branch ? tools.filter(candidate => retainedIds.has(candidate.entryId)).length : null,
            followingToolKeys: following.map(candidate => candidate.key), rereads,
            firstWorkToolKey: following.find(candidate => candidate.family !== 'context' && !skillReads.some(read => read.toolKey === candidate.key))?.key ?? null });
        if (status === 'accepted') warnings.push(`Line ${tool.line}: compact accepted but no branch is recorded; lifecycle is unconfirmed in this snapshot`);
    }
    const unmatched = tools.filter(tool => tool.status === 'no-result');
    // Legacy records without call IDs are counted, but cannot produce actionable join warnings.
    const identifiedUnmatched = unmatched.filter(tool => tool.callId !== null);
    if (identifiedUnmatched.length) warnings.push(`${identifiedUnmatched.length} unmatched tool calls have no result in this snapshot`);
    if (orphanResults) warnings.push(`${orphanResults} orphan or ambiguous tool results could not be joined by call ID and ancestry`);
    return { data: { tools, milestones, compactAttempts, skillReads }, metadata: { toolCalls: tools.length,
        toolErrors: tools.filter(tool => tool.status === 'error').length, unmatchedToolCalls: unmatched.length,
        compactRequests: compactAttempts.length, confirmedSkillReads: skillReads.length } };
}

/** Analyze all recorded branches in file order; auxiliary usage contributes only to cumulative tokens. */
export function analyzeSessionSnapshot(snapshot) {
    const { entries } = snapshot;
    const warnings = [...snapshot.warnings];
    const entriesById = new Map(entries.filter(entry => entry.id).map(entry => [entry.id, entry]));
    const points = [], usageRows = [], checkpoints = [], events = [];
    const totals = Object.fromEntries([...usageFields, 'total'].map(field => [field, 0]));
    let cumulative = 0, excludedZeroContext = 0, missingAssistantUsage = 0, lastTime = -Infinity;
    let warnedNestedCalls = false;
    for (const entry of entries) {
        const time = Date.parse(entry.timestamp);
        if (!Number.isFinite(time)) throw new Error(`Session timestamp invalid at line ${entry.line}`);
        if (time < lastTime) throw new Error(`Session timestamps out of order at line ${entry.line}`);
        lastTime = time;
        const base = { line: entry.line, entryId: entry.id ?? null, timestamp: entry.timestamp, time };
        const message = entry.message;
        // Only direct transcript calls have standalone result evidence here.
        // Warn even when codemode's nested recorder is missing or incomplete.
        if (!warnedNestedCalls && (message?.nestedCalls !== undefined ||
            (message?.role === 'toolResult' && ['codemode', 'functions.codemode'].includes(message.toolName)) ||
            toolCalls(entry).some(call => ['codemode', 'functions.codemode'].includes(call.name)))) {
            warnings.push('Codemode nested tool calls are not analyzed: tool/compact counts cover only direct calls, so zero counts do not prove absence. Codemode compaction attribution, recovery, and threshold simulation are incomplete.');
            warnedNestedCalls = true;
        }
        const isAssistant = entry.type === 'message' && message?.role === 'assistant';
        const usage = isAssistant || message?.role === 'toolResult' ? message?.usage
            : ['compaction', 'branch_summary'].includes(entry.type) ? entry.usage : null;
        const counts = readSessionUsage(usage, entry.line, warnings);
        if (isAssistant && !counts) missingAssistantUsage++;
        if (counts) {
            cumulative += counts.total;
            for (const field of Object.keys(totals)) totals[field] += counts[field];
            const row = { ...base, kind: isAssistant ? 'assistant' : 'auxiliary',
                model: message?.model ?? null, ...counts, cumulative };
            usageRows.push(row);
            if (isAssistant && counts.context > 0) points.push(row);
            else if (isAssistant) excludedZeroContext++;
        }
        if (entry.type === 'label' && typeof entry.label === 'string' && entry.label) {
            const call = findOriginCall(entry.parentId, entriesById, candidate =>
                (candidate.name === 'context_checkpoint' && candidate.arguments?.name === entry.label)
                || (candidate.name === 'context_compact' && candidate.arguments?.backupCheckpoint === entry.label));
            checkpoints.push({ ...base, name: entry.label, targetId: entry.targetId,
                targetTime: entriesById.get(entry.targetId)?.timestamp ?? null,
                kind: call?.name === 'context_checkpoint' ? 'checkpoint'
                    : call?.name === 'context_compact' ? 'backup' : 'label' });
        }
        if (entry.type === 'branch_summary' || entry.type === 'compaction') {
            const call = entry.type === 'branch_summary' && findOriginCall(entry.fromId, entriesById,
                candidate => candidate.name === 'context_compact');
            const kind = entry.type === 'compaction' ? 'native-compaction' : call ? 'pi-context' : 'branch-summary';
            events.push({ ...base, number: events.length + 1, kind });
            if (kind === 'branch-summary') warnings.push(`Line ${entry.line}: unattributed branch summary; not counted as pi-context compaction`);
        }
    }
    for (const event of events) {
        const before = points.findLast(point => point.line < event.line);
        const after = points.find(point => point.line > event.line);
        Object.assign(event, {
            before: before?.context ?? null, after: after?.context ?? null,
            beforeLine: before?.line ?? null, afterLine: after?.line ?? null,
            beforeTime: before?.time ?? null, afterTime: after?.time ?? null,
            reduction: before && after ? before.context - after.context : null,
            percent: before && after ? 100 * (1 - after.context / before.context) : null,
        });
    }
    if (missingAssistantUsage) warnings.push(`${missingAssistantUsage} assistant records without usable usage; cumulative totals may be incomplete`);
    const models = [...new Set(points.map(point => point.model).filter(Boolean))];
    if (models.length > 1) warnings.push('Multiple models: token counts may use different tokenizers; simulation is approximate');
    const toolAnalysis = analyzeSessionTools(entries, entriesById, checkpoints, warnings);
    return {
        ...toolAnalysis.data,
        metadata: {
            ...toolAnalysis.metadata,
            sessionId: entries.find(entry => entry.type === 'session')?.id ?? null,
            snapshotLines: snapshot.snapshotLines, snapshotSha256: snapshot.snapshotSha256,
            cutoff: entries.at(-1)?.timestamp ?? null, validRequests: points.length,
            excludedZeroContext, missingAssistantUsage, models, totals,
            cumulativeTokens: cumulative, peakContext: points.reduce((peak, point) => Math.max(peak, point.context), 0),
            finalContext: points.at(-1)?.context ?? null,
        }, points, usageRows, events, checkpoints, warnings,
    };
}

/** Simulate threshold-only compaction from observed input deltas, not cumulative request usage or cost. */
export function simulateSessionThreshold(points, events, options = {}) {
    const window = options.window ?? 272000;
    const threshold = options.threshold ?? 0.9;
    const reset = options.reset ?? 39000;
    if (!Number.isFinite(window) || window <= 0 || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1
        || !Number.isFinite(reset) || reset < 0 || reset >= window * threshold) {
        throw new Error('Session simulation requires window > 0, 0 < threshold <= 1, and 0 <= reset < threshold tokens');
    }
    const limit = window * threshold;
    const neutralizedLines = new Set(events.filter(event => event.kind !== 'branch-summary'
        && event.before !== null && event.after !== null && event.after < event.before).map(event => event.afterLine));
    const trace = [], samples = [], resets = [];
    let value = 0;
    for (let index = 0; index < points.length; index++) {
        const point = points[index];
        const delta = index === 0 ? point.context : neutralizedLines.has(point.line) ? 0 : point.context - points[index - 1].context;
        value = Math.max(0, value + delta);
        // Crossings are placed at observation time; overflow is retained, not silently discarded.
        while (value >= limit) {
            trace.push({ time: point.time, value: limit });
            resets.push({ time: point.time, line: point.line, before: limit, after: reset });
            trace.push({ time: point.time, value: reset });
            value -= limit - reset;
        }
        const sample = { time: point.time, line: point.line, value };
        samples.push(sample);
        trace.push(sample);
    }
    return { window, threshold, reset, limit, neutralizedLines: [...neutralizedLines], trace, samples, resets };
}
