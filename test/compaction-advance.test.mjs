import assert from "node:assert/strict";
import test from "node:test";

import { didConversationAdvance } from "../dist/compaction-advance.js";

const anchor = { id: "compact-turn", type: "message", message: { role: "assistant" } };

function branchWith(...tail) {
    return [{ id: "root", type: "message", message: { role: "user" } }, anchor, ...tail];
}

test("allows only passive extension metadata", () => {
    const branch = branchWith(
        { id: "extension-state", type: "custom" },
        { id: "checkpoint", type: "label" },
        { id: "session-name", type: "session_info" },
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

test("cancels for other state-changing entries or a missing compact anchor", () => {
    assert.equal(
        didConversationAdvance(branchWith({ id: "model", type: "model_change" }), anchor.id),
        true,
    );
    assert.equal(didConversationAdvance(branchWith(), "missing"), true);
    assert.equal(didConversationAdvance(branchWith(), null), true);
});
