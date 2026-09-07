import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Task targeting", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let contactId = "";

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = (server as { address: () => { port: number } }).address();
    base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@creolab.example",
        password: process.env.SEED_PASSWORD,
        client: "web",
      }),
    });
    cookie = login.headers.get("set-cookie") || "";
    assert.ok(cookie);

    const contacts = await fetch(`${base}/api/v1/contacts?limit=5`, { headers: { cookie } });
    const board = await contacts.json();
    contactId = board.items?.[0]?.id;
    assert.ok(contactId);
  });

  after(() => {
    server?.close();
  });

  it("поиск клиентов для picker", async () => {
    const response = await fetch(`${base}/api/v1/contacts/search?q=7701`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(Array.isArray(data.clients));
    assert.ok(data.clients.length >= 1);
    assert.ok(data.clients[0].name);
  });

  it("создаёт задачу на конкретного клиента без ручных id", async () => {
    const response = await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        type: "meeting",
        title: "Встреча с тестовым клиентом",
        targetType: "client",
        contactId,
        priority: "normal",
      }),
    });
    assert.equal(response.status, 201);
    const task = await response.json();
    assert.equal(task.contactId, contactId);
    assert.equal(task.targetType, "client");
  });

  it("preview сегмента и групповая задача с дочерними", async () => {
    const preview = await fetch(`${base}/api/v1/contacts/segment-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ datePreset: "last_30_days", limit: 10 }),
    });
    assert.equal(preview.status, 200);
    const segment = await preview.json();
    assert.ok(segment.total >= 1);
    const ids = (segment.clients as Array<{ id: string }>).slice(0, 2).map((item) => item.id);
    assert.ok(ids.length >= 1);

    const created = await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        type: "proposal",
        title: "Отправить предложение — группа",
        targetType: "group",
        clientIds: ids,
        segmentSnapshot: { label: "Тест сегмент", datePreset: "last_30_days" },
      }),
    });
    assert.equal(created.status, 201);
    const parent = await created.json();
    assert.equal(parent.targetType, "group");
    assert.equal(parent.childTasks.length, ids.length);

    const list = await fetch(`${base}/api/v1/tasks`, { headers: { cookie } });
    const body = await list.json();
    const found = body.items.find((item: { id: string }) => item.id === parent.id);
    assert.ok(found);
    assert.equal(found.progress.total, ids.length);
    assert.ok(String(found.contextLabel).includes("/"));

    const tinyPdf = Buffer.from(
      "%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
      "utf8",
    ).toString("base64");
    const attach = await fetch(`${base}/api/v1/tasks/${parent.id}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        fileName: "KP_group.pdf",
        mimeType: "application/pdf",
        contentBase64: tinyPdf,
        documentType: "proposal",
      }),
    });
    assert.equal(attach.status, 201);

    for (const child of parent.childTasks) {
      const detail = await fetch(`${base}/api/v1/tasks/${child.id}`, { headers: { cookie } });
      assert.equal(detail.status, 200);
      const body = await detail.json();
      assert.ok(
        (body.attachments || []).some((a: { fileName: string }) => a.fileName.includes("KP_group")),
        `child ${child.id} missing copied attachment`,
      );
    }
  });

  it("members endpoint для ответственного", async () => {
    const response = await fetch(`${base}/api/v1/workspace/members`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.items.some((item: { isMe: boolean }) => item.isMe));
  });
});
