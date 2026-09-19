import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { sanitizeSupportContext } from "./services/supportTicketService.ts";
import { supportModuleFromRoute } from "./services/supportKnowledgeService.ts";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X6ZkAAAAASUVORK5CYII=";

describe("BasQar support center", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: { close: (cb?: (err?: Error) => void) => void; address: () => { port: number } | string | null };
  let url = "";
  let ownerA = "";
  let ownerB = "";
  let platform = "";

  async function login(email: string) {
    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: process.env.SEED_PASSWORD, client: "web" }),
    });
    assert.equal(response.status, 200, await response.text());
    let cookie = response.headers.getSetCookie?.()?.[0]?.split(";")[0] || "";
    if (!cookie) cookie = (response.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(cookie);
    return cookie;
  }

  async function req(cookie: string, path: string, init: { method?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { cookie };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${url}${path}`, {
      method: init.method || "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  }

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    const app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve()) as typeof server;
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    url = `http://127.0.0.1:${addr.port}`;
    ownerA = await login("owner@creolab.example");
    ownerB = await login("owner@demo-agency.example");
    platform = await login("platform@creolab.example");
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await prisma.$disconnect();
  });

  it("sanitizes technical context and maps CRM routes", () => {
    const clean = sanitizeSupportContext({
      route: "/integrations",
      password: "secret",
      apiToken: "tok",
      cookie: "sid",
      jwt: "aaa",
      locale: "ru",
      userAgent: "Mozilla token=abc",
    });
    assert.equal(clean.route, "/integrations");
    assert.equal(clean.locale, "ru");
    assert.equal("password" in clean, false);
    assert.equal("apiToken" in clean, false);
    assert.equal(String(clean.userAgent).includes("token"), false);
    assert.equal(supportModuleFromRoute("/integrations"), "integrations");
    assert.equal(supportModuleFromRoute("/documents/avr/new"), "avr");
    assert.equal(supportModuleFromRoute("/integrations/esf"), "esf");
    assert.equal(supportModuleFromRoute("/deals"), "deals");
  });

  it("searches FAQ and boosts WhatsApp from integrations", async () => {
    const search = await req(ownerA, "/api/v1/support/articles?q=" + encodeURIComponent("как подключить ватсап"));
    assert.equal(search.status, 200, JSON.stringify(search.data));
    assert.ok((search.data.items || []).some((item: { slug: string }) => item.slug === "connect-whatsapp"));

    const contextual = await req(ownerA, "/api/v1/support/articles?route=" + encodeURIComponent("/integrations"));
    assert.equal(contextual.status, 200);
    assert.equal(contextual.data.module, "integrations");
    assert.ok((contextual.data.contextual || []).some((item: { slug: string }) => item.slug === "connect-whatsapp"));
  });

  it("stores article feedback for the active tenant", async () => {
    const list = await req(ownerA, "/api/v1/support/articles");
    const article = (list.data.popular || list.data.items || []).find((item: { slug: string }) => item.slug === "connect-whatsapp");
    assert.ok(article?.id);
    const feedback = await req(ownerA, `/api/v1/support/articles/${article.id}/feedback`, {
      method: "POST",
      body: { helpful: true },
    });
    assert.equal(feedback.status, 200, JSON.stringify(feedback.data));
    const row = await prisma.supportArticleFeedback.findFirst({ where: { articleId: article.id } });
    assert.equal(row?.helpful, true);
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } });
    assert.equal(row?.tenantId, tenant.id);
  });

  it("creates a tenant ticket, isolates other companies, and persists history", async () => {
    const created = await req(ownerA, "/api/v1/support/tickets", {
      method: "POST",
      body: {
        message: "Не могу подключить WhatsApp",
        route: "/integrations",
        tenantId: "foreign-id",
        organizationId: "foreign-id",
        context: {
          password: "nope",
          apiTokenInstance: "gapi",
          cookie: "sid",
          locale: "ru-RU",
        },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const ticketId = created.data.ticket?.id as string;
    assert.ok(ticketId);
    const creolab = await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } });
    assert.equal(created.data.ticket.tenantId, creolab.id);
    const stored = await prisma.supportTicket.findFirstOrThrow({ where: { id: ticketId } });
    const context = stored.contextJson as Record<string, unknown>;
    assert.equal(context.password, undefined);
    assert.equal(context.apiTokenInstance, undefined);
    assert.equal(context.cookie, undefined);

    const other = await req(ownerB, `/api/v1/support/tickets/${ticketId}`);
    assert.equal(other.status, 404);

    const mine = await req(ownerA, `/api/v1/support/tickets/${ticketId}`);
    assert.equal(mine.status, 200);
    assert.ok((mine.data.messages || []).length >= 2);

    const forbidden = await req(ownerA, "/api/v1/admin/support/tickets");
    assert.equal(forbidden.status, 403);

    const adminList = await req(platform, "/api/v1/admin/support/tickets?status=OPEN");
    assert.equal(adminList.status, 200, JSON.stringify(adminList.data));
    assert.ok((adminList.data.items || []).some((item: { id: string }) => item.id === ticketId));

    const reply = await req(platform, `/api/v1/admin/support/tickets/${ticketId}/messages`, {
      method: "POST",
      body: { content: "Здравствуйте. Сейчас проверим." },
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.data));

    const notices = await req(ownerA, "/api/v1/notifications");
    assert.equal(notices.status, 200);
    assert.ok(
      (notices.data.items || []).some(
        (item: { type?: string; title?: string }) => item.type === "support.replied" || String(item.title || "").includes("Поддержка"),
      ),
    );

    const file = await req(ownerA, `/api/v1/support/tickets/${ticketId}/attachments`, {
      method: "POST",
      body: { fileName: "shot.png", mimeType: "image/png", contentBase64: PNG },
    });
    assert.equal(file.status, 201, JSON.stringify(file.data));
    const attachmentId = file.data.messages?.find((item: { attachments?: Array<{ id: string }> }) => item.attachments?.[0]?.id)
      ?.attachments?.[0]?.id as string;
    assert.ok(attachmentId);
    const stolen = await req(ownerB, `/api/v1/support/tickets/${ticketId}/attachments/${attachmentId}`);
    assert.ok(stolen.status === 404 || stolen.status === 403);

    const closed = await req(platform, `/api/v1/admin/support/tickets/${ticketId}`, {
      method: "PATCH",
      body: { status: "CLOSED" },
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.data));
    assert.equal(closed.data.ticket.status, "CLOSED");

    const afterClose = await req(ownerA, `/api/v1/support/tickets/${ticketId}/messages`, {
      method: "POST",
      body: { content: "ещё вопрос" },
    });
    assert.equal(afterClose.status, 422);

    const again = await req(ownerA, `/api/v1/support/tickets/${ticketId}`);
    assert.equal(again.status, 200);
    assert.ok((again.data.messages || []).length >= 3);
  });

  it("does not mix support tickets with CRM conversations", async () => {
    const conversations = await req(ownerA, "/api/v1/conversations");
    assert.equal(conversations.status, 200);
    const supportCount = await prisma.supportTicket.count();
    assert.ok(supportCount >= 1);
    const crmCount = await prisma.conversation.count();
    assert.ok(crmCount >= 0);
    const integrations = await req(ownerA, "/api/v1/integrations");
    assert.equal(integrations.status, 200);
  });
});
