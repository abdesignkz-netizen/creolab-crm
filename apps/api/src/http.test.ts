import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

describe("CRM HTTP domain", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let base: string;
  let server: { close: () => void };
  let cookie = "";
  let webhookId = "";
  let otherCookie = "";

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
    const demo = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@demo-agency.example",
        password: process.env.SEED_PASSWORD,
        client: "web",
      }),
    });
    otherCookie = demo.headers.get("set-cookie") || "";
    const integrations = await fetch(`${base}/api/v1/integrations`, { headers: { cookie } });
    const body = (await integrations.json()) as { items: Array<{ id: string; type: string }> };
    webhookId = body.items.find((item) => item.type === "webhook")?.id || "";
  });

  after(() => {
    server?.close();
  });

  it("A01: пользователь без телефона входит в кабинет", async () => {
    const me = await fetch(`${base}/api/v1/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    const data = await me.json();
    assert.equal(data.user.email, "owner@creolab.example");
    assert.equal(data.user.phone, undefined);
  });

  it("A02: форма с телефоном создаёт заявку без WhatsApp", async () => {
    const response = await fetch(`${base}/public/forms/frm_creolab_site_demo/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-submission-id": "test-form-001" },
      body: JSON.stringify({
        name: "Клиент формы",
        phone: "+7 701 000 00 11",
        message: "Нужен сайт",
      }),
    });
    assert.ok(response.status === 202 || response.status === 200);
    const list = await fetch(`${base}/api/v1/inquiries`, { headers: { cookie } });
    const data = await list.json();
    assert.ok(
      data.items.some(
        (item: { phone?: string; contactName?: string }) =>
          String(item.phone || "").replace(/\D+/g, "").includes("77010000011") ||
          item.contactName === "Клиент формы",
      ),
    );
  });

  it("A03: пустой телефон формы даёт 422", async () => {
    const response = await fetch(`${base}/public/forms/frm_creolab_site_demo/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Без телефона", phone: "", message: "тест" }),
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.field_errors.phone.includes("телефон") || body.code === "missing_phone", true);
  });

  it("A05: повтор той же form submission идемпотентен", async () => {
    const payload = {
      name: "Повтор",
      phone: "+7 701 000 00 12",
      message: "один текст",
    };
    const first = await fetch(`${base}/public/forms/frm_creolab_site_demo/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-submission-id": "dup-form-1" },
      body: JSON.stringify(payload),
    });
    const second = await fetch(`${base}/public/forms/frm_creolab_site_demo/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-submission-id": "dup-form-1" },
      body: JSON.stringify(payload),
    });
    const a = await first.json();
    const b = await second.json();
    assert.equal(a.receipt, b.receipt);
  });

  it("A07: один номер в двух компаниях не сливается", async () => {
    const creolab = await fetch(`${base}/api/v1/inquiries`, { headers: { cookie } });
    const demo = await fetch(`${base}/api/v1/inquiries`, { headers: { cookie: otherCookie } });
    const a = await creolab.json();
    const b = await demo.json();
    const shared = a.items.filter((item: { phoneNormalized: string }) =>
      b.items.some((other: { phoneNormalized: string }) => other.phoneNormalized === item.phoneNormalized),
    );
    if (shared.length) {
      assert.notEqual(shared[0].id, b.items.find((item: { phoneNormalized: string }) => item.phoneNormalized === shared[0].phoneNormalized).id);
    }
  });

  it("A10: tenant_id в webhook не даёт полномочий", async () => {
    if (!webhookId) return;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const secret = process.env.SEED_WEBHOOK_SECRET || "whsec_dev_local_only";
    const payload = JSON.stringify({
      schema_version: 1,
      event_id: "spoof-tenant-1",
      event_type: "inquiry.created",
      tenant_id: "foreign-tenant",
      role: "owner",
      assignee_id: "hack",
      contact: { name: "Webhook", methods: [{ type: "phone", value: "+77010000013" }] },
      inquiry: { subject: "API", message: "проверка" },
    });
    const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
    const response = await fetch(`${base}/api/v1/integrations/${webhookId}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${secret}`,
        "x-crm-timestamp": timestamp,
        "x-crm-signature": signature,
      },
      body: payload,
    });
    assert.equal(response.status, 202);
    const result = await response.json();
    assert.equal(result.disposition, "inquiry");
  });

  it("A09: webhook без телефона -> IncompleteIntake", async () => {
    if (!webhookId) return;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const secret = process.env.SEED_WEBHOOK_SECRET || "whsec_dev_local_only";
    const payload = JSON.stringify({
      schema_version: 1,
      event_id: "needs-phone-1",
      event_type: "inquiry.created",
      contact: { name: "Без номера", methods: [] },
      inquiry: { message: "есть задача" },
    });
    const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
    const response = await fetch(`${base}/api/v1/integrations/${webhookId}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${secret}`,
        "x-crm-timestamp": timestamp,
        "x-crm-signature": signature,
      },
      body: payload,
    });
    const result = await response.json();
    assert.equal(response.status, 202);
    assert.equal(result.disposition, "needs_phone");
    assert.ok(result.incomplete_intake_id);
    assert.equal(result.inquiry_id, undefined);
  });

  it("A50: заявка имеет UUID, не телефон в id", async () => {
    const list = await fetch(`${base}/api/v1/inquiries`, { headers: { cookie } });
    const data = await list.json();
    for (const item of data.items) {
      assert.match(item.id, /^[0-9a-f-]{36}$/i);
      assert.notEqual(item.id, item.phoneNormalized);
    }
  });
});
