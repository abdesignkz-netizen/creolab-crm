import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  displayTaskStatus,
  isAiAssignableTaskType,
  taskAssigneeKind,
  taskBoardLane,
  taskCreatedByKind,
  taskCreatedByLabel,
} from "@creolab/contracts";

describe("task origin helpers", () => {
  it("keeps existing board lanes for old records", () => {
    assert.equal(taskBoardLane({ source: "ai_command", type: "message" }), "ai");
    assert.equal(taskBoardLane({ source: "manual", type: "note" }), "notes");
    assert.equal(taskBoardLane({ source: "manual", type: "call", contactId: "x" }), "managers");
  });

  it("infers creator from source without a new column", () => {
    assert.equal(taskCreatedByKind({ source: "ai_automation", type: "follow_up" }), "ai");
    assert.equal(taskCreatedByKind({ source: "rule", type: "process_inquiry" }), "ai");
    assert.equal(taskCreatedByKind({ source: "campaign", type: "message" }), "system");
    assert.equal(taskCreatedByKind({ source: "manual", type: "other", contextSnapshotJson: { createdByKind: "user" } }), "user");
    assert.equal(
      taskCreatedByKind({
        source: "ai_command",
        type: "message",
        contextSnapshotJson: { createdByKind: "user" },
      }),
      "user",
    );
    assert.equal(taskCreatedByKind({ source: "ai_command", type: "message" }), "ai");
    assert.equal(taskCreatedByLabel("ai"), "AI Manager");
    assert.equal(taskCreatedByLabel("system"), "Автоматизация");
  });

  it("treats AI executor as assignee only when owner is empty", () => {
    assert.equal(taskAssigneeKind({ ownerMembershipId: null, contextSnapshotJson: { executorType: "AI" } }), "ai");
    assert.equal(taskAssigneeKind({ ownerMembershipId: "mem-1", contextSnapshotJson: { executorType: "AI" } }), "user");
    assert.equal(taskAssigneeKind({ ownerMembershipId: null, contextSnapshotJson: {} }), "unassigned");
  });

  it("allows AI only for existing sendable types", () => {
    assert.equal(isAiAssignableTaskType("message"), true);
    assert.equal(isAiAssignableTaskType("call"), false);
    assert.equal(isAiAssignableTaskType("meeting"), false);
    assert.equal(isAiAssignableTaskType("note"), false);
  });

  it("maps lifecycle statuses for UI without renaming backend values", () => {
    assert.equal(displayTaskStatus("open"), "К выполнению");
    assert.equal(displayTaskStatus("waiting"), "Жду");
    assert.equal(displayTaskStatus("done"), "Завершено");
  });
});
