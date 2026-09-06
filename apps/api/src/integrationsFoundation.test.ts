import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("integrations foundation", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: { close: (cb?: (err?: Error) => void) => void; address: () => { port: number } | string | null };
  let cookie = "";
  let url = "";
  let formKey = "";

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    const form = await prisma.formDefinition.findFirst({ where: { active: true } });
    formKey = form?.publicKey || "";
    assert.ok(formKey);

    const app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve()) as typeof server;
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    url = `http://127.0.0.1:${addr.port}`;

    const login = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD }),
    });
    assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie?.()?.[0]?.split(";")[0] || "";
    if (!cookie) cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await prisma.$disconnect();
  });

  it("catalog returns lead cards and event log shape", async () => {
    const res = await fetch(`${url}/api/v1/integrations/catalog`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.leads));
    assert.ok(body.leads.some((i: { catalogType: string }) => i.catalogType === "WEBSITE_FORM"));
    assert.ok(body.leads.some((i: { catalogType: string }) => i.catalogType === "WEBHOOK_API"));
    assert.ok(body.notifications?.employeeTelegram);
    assert.ok(Array.isArray(body.eventLog));
  });

  it("form submission creates LEAD_SUBMISSION event and is idempotent", async () => {
    const submissionId = `test-lead-${Date.now()}`;
    const payload = {
      name: "Интеграция Тест",
      phone: "+7 701 300 00 01",
      message: "Нужен сайт",
      company: "Test Co",
      utm_source: "google",
      pageUrl: "https://creolab.kz/web",
      submission_id: submissionId,
    };
    const first = await fetch(`${url}/public/forms/${formKey}/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-submission-id": submissionId },
      body: JSON.stringify(payload),
    });
    assert.ok([200, 202].includes(first.status));
    const firstBody = await first.json();
    assert.equal(firstBody.ok, true);

    const second = await fetch(`${url}/public/forms/${formKey}/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-submission-id": submissionId },
      body: JSON.stringify(payload),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.duplicate, true);

    const events = await prisma.inboundEvent.findMany({
      where: { externalEventKey: submissionId },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "LEAD_SUBMISSION");
    assert.equal(events[0].status, "PROCESSED");

    const inquiries = await prisma.inquiry.findMany({
      where: { phoneNormalized: { contains: "7013000001" } },
    });
    assert.equal(inquiries.length, 1);
    assert.equal(inquiries[0].utmSource, "google");
  });

  it("urlencoded form submission works", async () => {
    const submissionId = `urlencoded-${Date.now()}`;
    const body = new URLSearchParams({
      name: "Form Urlencoded",
      phone: "+77013000002",
      message: "hello",
      submission_id: submissionId,
    });
    const res = await fetch(`${url}/public/forms/${formKey}/submissions`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-submission-id": submissionId,
      },
      body: body.toString(),
    });
    assert.ok([200, 202].includes(res.status));
    const event = await prisma.inboundEvent.findFirst({ where: { externalEventKey: submissionId } });
    assert.ok(event);
    assert.equal(event?.eventType, "LEAD_SUBMISSION");
  });

  it("health-check returns checklist", async () => {
    const form = await prisma.integration.findFirst({ where: { type: "form" } });
    assert.ok(form);
    const res = await fetch(`${url}/api/v1/integrations/${form!.id}/health-check`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.checks));
    assert.ok(body.checks.length >= 3);
  });
});
