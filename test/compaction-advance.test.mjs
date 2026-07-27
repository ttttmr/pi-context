import assert from "node:assert/strict";
import test from "node:test";

import { didConversationAdvance } from "../dist/index.js";

const anchor = { id: "compact-turn", type: "message", message: { role: "assistant" } };

function branchWith(...tail) {
    return [{ id: "root", type: "message", message: { role: "user" } }, anchor, ...tail];
}

test("allows non-contextual session entries", () => {
    const branch = branchWith(
        { id: "extension-state", type: "custom" },
        { id: "checkpoint", type: "label" },
        { id: "session-name", type: "session_info" },
        { id: "model", type: "model_change" },
        { id: "thinking", type: "thinking_level_change" },
    );

    assert.equal(didConversationAdvance(branch, anchor.id), false);
});

test("cancels when any message or contextual custom message arrives", () => {
    for (const role of ["user", "assistant", "toolResult", "bashExecution"]) {
        assert.equal(
            didConversationAdvance(
                branchWith({ id: `message-${role}`, type: "message", message: { role } }),
                anchor.id,
            ),
            true,
            role,
        );
    }
    assert.equal(
        didConversationAdvance(
            branchWith({ id: "custom-message", type: "custom_message" }),
            anchor.id,
        ),
        true,
    );
});

test("cancels for contextual entries, unknown types, or a missing compact anchor", () => {
    assert.equal(
        didConversationAdvance(branchWith({ id: "branch-summary", type: "branch_summary" }), anchor.id),
        true,
    );
    assert.equal(
        didConversationAdvance(branchWith({ id: "compaction", type: "compaction" }), anchor.id),
        true,
    );
    assert.equal(
        didConversationAdvance(branchWith({ id: "future", type: "future_context" }), anchor.id),
        true,
    );
    assert.equal(didConversationAdvance(branchWith(), "missing"), true);
    assert.equal(didConversationAdvance(branchWith(), null), true);
});
