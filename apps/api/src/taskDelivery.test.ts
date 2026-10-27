import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { WhatsAppSellerBridge } from "@creolab/integrations";
import { ApiError } from "./errors.ts";
import type { AuthContext } from "./lib/types.ts";
import { encryptSecret } from "./lib/secretBox.ts";
import { resolveUploadPath } from "./lib/storage.ts";
import { addTaskAttachment, completeTaskWithResult, confirmTaskExecution, executeTask, prepareTaskExecution, removeTaskAttachment, updateTaskDraft } from "./services/taskExecutionService.ts";
import { cancelTask, getTask, listTasks } from "./services/domainService.ts";
import { executeTaskBatch } from "./services/aiCommandExecutionService.ts";
import { reconcileTaskDelivery } from "./services/taskDeliveryService.ts";
import { readTaskDelivery, saveTaskDelivery, taskDeliveryKey } from "./services/taskDeliveryState.ts";

describe("Task delivery evidence and retries", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  let auth: AuthContext, tid: string;
  const originalFetch = globalThis.fetch;
  let textCalls = 0, fileCalls = 0;
  let textSend: () => Promise<unknown>, fileSend: () => Promise<{ ok: boolean; idMessage: string }>;
  before(async () => {
    db = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts"); await seedDatabase();
    const membership = await db.membership.findFirstOrThrow({ where: { role: "owner", tenant: { slug: "creolab" } }, include: { user: true, tenant: true } });
    auth = { user: membership.user, activeMembership: membership, memberships: [membership] } as AuthContext; tid = membership.tenantId;
    const existing = await db.integration.findFirst({ where: { tenantId: tid, type: "whatsapp_seller" } });
    const data = { status: "active", connectionStatus: "CONNECTED", schemaJson: { sellerUrl: "https://seller.invalid", secretEnc: encryptSecret("synthetic-only") } };
    if (existing) await db.integration.update({ where: { id: existing.id }, data });
    else await db.integration.create({ data: { tenantId: tid, type: "whatsapp_seller", name: "Synthetic bridge", ...data } });
    globalThis.fetch = async () => { throw new Error("Unexpected external request in isolated test"); };
  });
  after(async () => { globalThis.fetch = originalFetch; await db.$disconnect(); });
  beforeEach(() => {
    textCalls = 0; fileCalls = 0;
    textSend = async () => ({ ok: true, idMessage: "text-provider-id" });
    fileSend = async () => ({ ok: true, idMessage: `file-${fileCalls}` });
    mock.method(WhatsAppSellerBridge.prototype, "setMode", async () => ({ ok: true }));
    mock.method(WhatsAppSellerBridge.prototype, "sendText", async () => { textCalls++; return textSend(); });
    mock.method(WhatsAppSellerBridge.prototype, "sendFile", async () => { fileCalls++; return fileSend(); });
  });
  afterEach(() => mock.restoreAll());
  async function fixture(files = 0) {
    const contact = await db.contact.create({ data: { tenantId: tid, name: "Тестовая отправка", ownerMembershipId: auth.activeMembership!.id } });
    const conversation = await db.conversation.create({ data: { tenantId: tid, contactId: contact.id, sellerLeadId: randomUUID(), mode: "ai" } });
    const task = await db.task.create({ data: { tenantId: tid, type: "message", title: "Отправить материалы", contactId: contact.id,
      conversationId: conversation.id, ownerMembershipId: auth.activeMembership!.id, messageDraft: "Здравствуйте! Направляю материалы." } });
    const attachments = [];
    for (let i = 0; i < files; i++) attachments.push(await addTaskAttachment(db, auth, task.id, {
      fileName: `${i}.pdf`, mimeType: "application/pdf", contentBase64: Buffer.from(`%PDF-test-${i}`).toString("base64"),
    }));
    const confirmation = (await confirmTaskExecution(db, auth, task.id)).confirmation;
    return { contact, conversation, task, attachments, confirmation,
      run: (retry = false) => executeTask(db, auth, task.id, { retryFailedFilesOnly: retry }),
      current: () => db.task.findUniqueOrThrow({ where: { id: task.id } }) };
  }
  const code = (value: string) => (error: unknown) => error instanceof ApiError && error.code === value;

  it("records accepted text and every file in the dialogue, completes once and replays without sending", async () => {
    const f = await fixture(2); const first = await f.run();
    assert.equal(first.success, true, JSON.stringify(first)); assert.equal((await f.current()).status, "done");
    const again = await f.run(); assert.equal(again.success, true);
    assert.equal(textCalls, 1); assert.equal(fileCalls, 2);
    const messages = await db.message.findMany({ where: { conversationId: f.conversation.id }, include: { attachments: true } });
    assert.equal(messages.length, 3); assert.ok(messages.every(m => m.operationState === "accepted"));
    assert.equal(messages.filter(m => m.attachments.length).length, 2);
    assert.equal(messages.find(m => m.type === "text")?.providerMessageId, "text-provider-id");
    assert.equal(await db.activity.count({ where: { contactId: f.contact.id, type: "task.sent" } }), 1);
    assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } })).controlVersion, f.conversation.controlVersion + 1);
  });
  it("does not treat retry-files as evidence that text was sent", async () => {
    for (const count of [0, 1]) { const f = await fixture(count); await assert.rejects(f.run(true), code("text_not_sent")); assert.equal((await f.current()).status, "open"); }
    assert.equal(textCalls + fileCalls, 0);
  });
  it("retains the confirmation and never resends accepted parts when retrying a missing local file", async () => {
    const f = await fixture(2);
    const last = await db.attachment.findFirstOrThrow({ where: { parentId: f.task.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    await unlink(resolveUploadPath(last.storageKey));
    const first = await f.run(); assert.equal(first.partial, true); assert.equal(first.retryFilesAvailable, true);
    assert.equal(textCalls, 1); assert.equal(fileCalls, 1); assert.equal((await f.current()).status, "open");
    const confirm = await confirmTaskExecution(db, auth, f.task.id); assert.equal(confirm.confirmation.id, f.confirmation.id);
    await writeFile(resolveUploadPath(last.storageKey), "%PDF-test-1");
    const retry = await f.run(true); assert.equal(retry.success, true);
    assert.equal(textCalls, 1); assert.equal(fileCalls, 2); assert.equal(retry.files.length, 2);
    assert.equal(await db.message.count({ where: { conversationId: f.conversation.id } }), 3);
  });
  it("does not send files after a text timeout, cannot re-confirm or edit around the unknown outcome", async () => {
    const f = await fixture(1); textSend = async () => { throw new DOMException("timeout", "TimeoutError"); };
    const result = await f.run(); assert.equal(result.needsCheck, true); assert.equal(result.textState, "unknown");
    assert.equal(result.retryFilesAvailable, false); assert.equal(fileCalls, 0); assert.equal((await f.current()).executionStatus, "unknown");
    await f.run(); assert.equal(textCalls, 1);
    await assert.rejects(confirmTaskExecution(db, auth, f.task.id), code("task_delivery_unknown"));
    await assert.rejects(updateTaskDraft(db, auth, f.task.id, { messageDraft: "Новый текст" }), code("task_delivery_unknown"));
    await assert.rejects(removeTaskAttachment(db, auth, f.task.id, f.attachments[0].id), code("task_delivery_unknown"));
    assert.equal(await db.attachment.count({ where: { parentId: f.task.id } }), 1);
  });
  it("preserves partial acceptance on a file timeout and disables blind retry", async () => {
    const f = await fixture(2); fileSend = async () => { throw new Error("fetch failed"); };
    const result = await f.run(); assert.equal(result.textOk, true); assert.equal(result.needsCheck, true);
    assert.equal(result.partial, true); assert.equal(result.retryFilesAvailable, false);
    await f.run(true); assert.equal(fileCalls, 1); assert.equal(textCalls, 1);
    assert.equal((await f.current()).status, "open");
  });
  it("does not accept empty or negative provider responses as successful sends", async () => {
    for (const reply of [{}, { ok: false }, { ok: true, error: "failed" }, { idMessage: 123 }, { idMessage: "   " }, null]) {
      const f = await fixture(); textSend = async () => reply; const result = await f.run();
      assert.equal(result.success, false); assert.equal(result.needsCheck, true); assert.equal((await f.current()).status, "open");
    }
  });
  it("serializes double clicks and blocks edits and attachment changes while a send is in flight", async () => {
    const f = await fixture(1); let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
    textSend = async () => { started(); await gate; return { ok: true }; };
    const run = f.run(); await Promise.race([entered, run.then(r => { throw new Error(`Send did not start: ${JSON.stringify(r)}`); })]);
    const scheduled = await db.scheduledAction.create({ data: { tenantId: tid, type: "task_run", parentType: "task", parentId: f.task.id, dueAt: new Date(Date.now() + 3600_000) } });
    try {
      await assert.rejects(f.run(), code("task_sending"));
      await assert.rejects(cancelTask(db, auth, f.task.id), code("task_sending"));
      await assert.rejects(completeTaskWithResult(db, auth, f.task.id, { resultCode: "sent" }), code("task_sending"));
      assert.equal((await db.scheduledAction.findUniqueOrThrow({ where: { id: scheduled.id } })).state, "scheduled");
      const visible = await getTask(db, auth, f.task.id);
      assert.equal(visible.delivery?.sending, true); assert.equal(visible.delivery?.textState, "sending");
      await assert.rejects(prepareTaskExecution(db, auth, f.task.id), code("task_sending"));
      await assert.rejects(updateTaskDraft(db, auth, f.task.id, { contactId: null }), code("task_sending"));
      await assert.rejects(removeTaskAttachment(db, auth, f.task.id, f.attachments[0].id), code("task_sending"));
      await assert.rejects(addTaskAttachment(db, auth, f.task.id, { fileName: "race.pdf", mimeType: "application/pdf", contentBase64: "dGVzdA==" }), code("task_sending"));
    } finally { release(); }
    assert.equal((await run).success, true); assert.equal(textCalls, 1); assert.equal(fileCalls, 1);
    assert.equal(await db.attachment.count({ where: { parentId: f.task.id } }), 1);
  });
  it("blocks canceled tasks and completed manual tasks without sending", async () => {
    for (const status of ["done", "canceled"]) { const f = await fixture(); await db.task.update({ where: { id: f.task.id }, data: { status } });
      await assert.rejects(f.run(), code("invalid_state")); }
    assert.equal(textCalls, 0);
  });
  it("verifies current content and the provider recipient, even when a legacy writer did not invalidate confirmation", async () => {
    const f = await fixture(); await db.task.update({ where: { id: f.task.id }, data: { messageDraft: "Changed directly" } });
    await assert.rejects(f.run(), code("stale_confirmation"));
    const other = await fixture(); await db.conversation.update({ where: { id: other.conversation.id }, data: { sellerLeadId: "different-recipient" } });
    await assert.rejects(other.run(), code("stale_confirmation")); assert.equal(textCalls, 0);
  });
  it("prevents changing an accepted recipient or content before retrying files", async () => {
    const f = await fixture(1); const file = await db.attachment.findUniqueOrThrow({ where: { id: f.attachments[0].id } }); await unlink(resolveUploadPath(file.storageKey));
    await f.run(); await assert.rejects(updateTaskDraft(db, auth, f.task.id, { messageDraft: "different" }), code("task_delivery_started"));
    await assert.rejects(removeTaskAttachment(db, auth, f.task.id, file.id), code("task_delivery_started"));
    assert.equal(textCalls, 1);
  });
  it("keeps a crashed provider call unknown across recovery without repeating it", async () => {
    const f = await fixture(); let entered!: () => void, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    textSend = async () => { entered(); await gate; return { ok: true }; };
    const first = f.run(); await Promise.race([started, first.then(r => { throw new Error(`Send did not start: ${JSON.stringify(r)}`); })]);
    const delivery = (await readTaskDelivery(db, tid, f.task.id))!; delivery.leaseUntil = new Date(0).toISOString();
    await saveTaskDelivery(db, tid, f.task.id, delivery);
    const recovered = await f.run(); assert.equal(recovered.needsCheck, true); assert.equal(recovered.success, false);
    release(); await assert.rejects(first, code("task_sending")); await f.run(); assert.equal(textCalls, 1);
    const saved = await db.idempotencyRecord.findUniqueOrThrow({ where: { scope_actorKey_key: taskDeliveryKey(tid, f.task.id) } });
    assert.ok(saved.expiresAt.getUTCFullYear() > 9000);
  });
  it("stops the remaining files if the conversation mode changes during a send", async () => {
    const f = await fixture(1); textSend = async () => {
      await db.conversation.update({ where: { id: f.conversation.id }, data: { mode: "ai", controlVersion: { increment: 1 } } }); return { ok: true };
    };
    const result = await f.run(); assert.equal(result.success, false); assert.equal(result.textOk, true); assert.equal(fileCalls, 0);
  });
  it("does not complete a parent while another child is in progress", async () => {
    const f = await fixture(); const parent = await db.task.create({ data: { tenantId: tid, type: "message", title: "Группа", targetType: "group" } });
    await db.task.update({ where: { id: f.task.id }, data: { parentTaskId: parent.id } });
    await db.task.create({ data: { tenantId: tid, type: "message", title: "Ещё один", parentTaskId: parent.id, status: "in_progress" } });
    assert.equal((await f.run()).success, true); assert.equal((await db.task.findUniqueOrThrow({ where: { id: parent.id } })).status, "open");
  });
  it("does not overwrite the result of a concurrent cancellation by a background process", async () => {
    const f = await fixture(1); textSend = async () => {
      await db.task.update({ where: { id: f.task.id }, data: { status: "canceled" } }); return { ok: true };
    };
    await f.run(); assert.equal((await f.current()).status, "canceled"); assert.equal(fileCalls, 0);
  });
  it("does not turn an old untracked attempt or reopened sent task into a fresh confirmed send", async () => {
    for (const executionStatus of ["failed", "partial", "sending", "unknown", "sent"]) {
      const f = await fixture(); await db.task.update({ where: { id: f.task.id }, data: { executionStatus } });
      await assert.rejects(confirmTaskExecution(db, auth, f.task.id), code("task_delivery_unknown"));
      await assert.rejects(f.run(), code("task_delivery_unknown"));
    }
    assert.equal(textCalls + fileCalls, 0);
  });
  it("keeps confirmation id stable across repeated confirmations", async () => {
    const f = await fixture(); const again = await confirmTaskExecution(db, auth, f.task.id);
    assert.equal(again.confirmation.id, f.confirmation.id); assert.equal(await db.executionConfirmation.count({ where: { taskId: f.task.id } }), 1);
  });
  it("keeps one confirmation across concurrent confirmations", async () => {
    const f = await fixture();
    const confirmations = await Promise.all([confirmTaskExecution(db, auth, f.task.id), confirmTaskExecution(db, auth, f.task.id)]);
    assert.equal(new Set(confirmations.map(c => c.confirmation.id)).size, 1);
    await f.run(); assert.equal(textCalls, 1);
  });
  it("can safely retry after a handover failure before any message was dispatched", async () => {
    const f = await fixture(1);
    const mode = mock.method(WhatsAppSellerBridge.prototype, "setMode", async () => { throw new Error("mode unavailable"); });
    const first = await f.run(); assert.equal(first.success, false); assert.equal(textCalls + fileCalls, 0);
    assert.equal(first.needsCheck, false);
    await assert.rejects(f.run(true), code("text_not_sent"));
    mode.mock.restore(); assert.equal((await f.run()).success, true);
    assert.equal(textCalls, 1); assert.equal(fileCalls, 1);
  });
  it("does not send a different file when the storage content changes after confirmation", async () => {
    const f = await fixture(1); const file = await db.attachment.findUniqueOrThrow({ where: { id: f.attachments[0].id } });
    await writeFile(resolveUploadPath(file.storageKey), "different-content");
    const result = await f.run(); assert.equal(result.success, false); assert.equal(result.partial, true);
    assert.match(result.files[0].error!, /Файл изменился/); assert.equal(fileCalls, 0);
  });
  it("does not adopt an unrelated client's explicit conversation", async () => {
    const f = await fixture(); const other = await fixture();
    await updateTaskDraft(db, auth, f.task.id, { conversationId: other.conversation.id });
    const preview = await prepareTaskExecution(db, auth, f.task.id);
    assert.equal(preview.conversationId, f.conversation.id);
  });
  it("does not dispatch or reveal a task to a different tenant", async () => {
    const f = await fixture(); const other = await db.membership.findFirstOrThrow({ where: { tenantId: { not: tid } }, include: { tenant: true, user: true } });
    const outsider = { user: other.user, activeMembership: other, memberships: [other] } as AuthContext;
    await assert.rejects(executeTask(db, outsider, f.task.id), code("not_found")); assert.equal(textCalls, 0);
  });
  it("recovers final bookkeeping after all provider acknowledgements without re-sending", async () => {
    const f = await fixture(1); await f.run();
    // Model a restart after per-part acceptance but before the final task/activity commit.
    await db.task.update({ where: { id: f.task.id }, data: { status: "open", executionStatus: "sending", completedAt: null } });
    await db.activity.deleteMany({ where: { contactId: f.contact.id, type: "task.sent" } });
    const delivery = (await readTaskDelivery(db, tid, f.task.id))!;
    delivery.claim = "interrupted-worker"; delivery.leaseUntil = new Date(0).toISOString();
    await saveTaskDelivery(db, tid, f.task.id, delivery);
    assert.equal((await f.run()).success, true); assert.equal(textCalls, 1); assert.equal(fileCalls, 1);
    assert.equal((await f.current()).status, "done"); assert.equal(await db.activity.count({ where: { contactId: f.contact.id, type: "task.sent" } }), 1);
  });
  it("preserves delivery evidence after reload and does not offer file retry for unknown outcomes", async () => {
    const f = await fixture(1); fileSend = async () => { throw new Error("connection reset"); }; await f.run();
    const detail = await getTask(db, auth, f.task.id); assert.equal(detail.delivery?.needsCheck, true);
    assert.equal(detail.delivery?.retryFilesAvailable, false);
    const board = await listTasks(db, auth);
    const row = board.find(t => t.id === f.task.id); assert.ok(row); assert.equal(row.needsDeliveryCheck, true); assert.equal(row.needsFileRetry, false);
  });
  it("does not send remaining files after the executing employee loses access", async () => {
    const f = await fixture(1);
    textSend = async () => { await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { active: false } }); return { ok: true }; };
    try { const result = await f.run(); assert.equal(result.success, false); assert.equal(fileCalls, 0); }
    finally { await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { active: true } }); }
  });
  it("serializes a batch and rejects cancellation while its child sends", async () => {
    const f = await fixture(); const parent = await db.task.create({ data: { tenantId: tid, type: "message", title: "Групповая отправка", targetType: "group" } });
    await db.task.update({ where: { id: f.task.id }, data: { parentTaskId: parent.id } });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    textSend = async () => { entered(); await gate; return { ok: true }; };
    const first = executeTaskBatch(db, auth, parent.id);
    await Promise.race([started, first.then(r => { throw new Error(`Batch did not start: ${JSON.stringify(r)}`); })]);
    try {
      await assert.rejects(executeTaskBatch(db, auth, parent.id), code("task_sending"));
      await assert.rejects(cancelTask(db, auth, parent.id), code("task_sending"));
    } finally { release(); }
    assert.equal((await first).success, 1); assert.equal(textCalls, 1);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: parent.id } })).status, "done");
  });
  it("records a manually checked absence without dispatch, then explicitly retries only that file", async () => {
    const f = await fixture(1); fileSend = async () => { throw new Error("timeout"); };
    await f.run(); const partId = f.attachments[0].id;
    const check = await reconcileTaskDelivery(db, auth, f.task.id, { partId, outcome: "not_sent", note: "Проверил WhatsApp компании: файла в переписке нет." });
    assert.equal(check.needsCheck, false); assert.equal(check.retryFilesAvailable, true);
    assert.equal(fileCalls, 1); assert.equal(textCalls, 1);
    assert.equal(await db.auditEvent.count({ where: { entityId: f.task.id, action: "task.delivery_reconciled", actorUserId: auth.user.id } }), 1);
    fileSend = async () => ({ ok: true, idMessage: "file-after-check" });
    assert.equal((await f.run(true)).success, true); assert.equal(fileCalls, 2); assert.equal(textCalls, 1);
  });
  it("records a manually checked delivery and completes without sending a duplicate", async () => {
    const f = await fixture(); textSend = async () => { throw new Error("timeout"); }; await f.run();
    const check = await reconcileTaskDelivery(db, auth, f.task.id, { partId: "text", outcome: "sent", note: "Проверил исходящее сообщение в WhatsApp компании." });
    assert.equal(check.success, true); assert.equal(check.textReconciled, true); assert.equal((await f.current()).status, "done");
    await f.run(); assert.equal(textCalls, 1);
    assert.equal(await db.activity.count({ where: { contactId: f.contact.id, type: "task.delivery_reconciled", actorId: auth.user.id } }), 1);
  });
  it("does not let arbitrary users or blind acknowledgements resolve an unknown send", async () => {
    const f = await fixture(); textSend = async () => { throw new Error("timeout"); }; await f.run();
    const input = { partId: "text", outcome: "not_sent" as const, note: "Проверил WhatsApp компании, сообщения нет." };
    const manager = { ...auth, activeMembership: { ...auth.activeMembership!, role: "manager" } } as AuthContext;
    await assert.rejects(reconcileTaskDelivery(db, manager, f.task.id, input), code("forbidden"));
    await assert.rejects(reconcileTaskDelivery(db, auth, f.task.id, { ...input, note: "да" }), code("invalid"));
    await assert.rejects(reconcileTaskDelivery(db, auth, f.task.id, { ...input, partId: "not-a-part" }), code("not_found"));
    const other = await db.membership.findFirstOrThrow({ where: { tenantId: { not: tid }, role: "owner" }, include: { user: true, tenant: true } });
    await assert.rejects(reconcileTaskDelivery(db, { ...auth, user: other.user, activeMembership: other }, f.task.id, input), code("not_found"));
    const results = await Promise.allSettled([reconcileTaskDelivery(db, auth, f.task.id, input), reconcileTaskDelivery(db, auth, f.task.id, input)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(await db.auditEvent.count({ where: { entityId: f.task.id, action: "task.delivery_reconciled" } }), 1);
    assert.equal(textCalls, 1);
  });
});
