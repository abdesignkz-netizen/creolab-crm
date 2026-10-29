// Full local app plus a separate sample site. Disposable database; no provider traffic.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createHttpServer } from "node:http";
const scratch = mkdtempSync(path.join(tmpdir(), "basqar-website-forms-ui-"));
Object.assign(process.env, {
  NODE_ENV: "test", CRM_USE_PGLITE: "1", CRM_PGLITE_DIR: path.join(scratch, "db"), STORAGE_DIR: path.join(scratch, "uploads"),
  SEED_PASSWORD: "FormsPreviewOnly1!", PLATFORM_ADMIN_EMAIL: "", PLATFORM_ADMIN_PASSWORD: "", ENCRYPTION_KEY: "forms-local-preview",
  OPENAI_API_KEY: "", ANYMODEL_API_KEY: "", TRANSCRIPTION_API_KEY: "", WHATSAPP_SELLER_URL: "", WHATSAPP_SELLER_SECRET: "",
  VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", TELEGRAM_BOT_TOKEN: "", BILLING_PROVIDER: "none",
  FREEDOM_PAY_MERCHANT_ID: "", FREEDOM_PAY_SECRET_KEY: "", ESF_PROVIDER: "mock", ESF_ENV: "off", ESF_ALLOW_LIVE_SEND: "0",
  CRM_INLINE_AUTOMATION: "0", WHATSAPP_QR_ENABLED: "0", ALLOWED_ORIGINS: "http://127.0.0.1:4520",
  APP_BASE_URL: "http://127.0.0.1:4520", API_BASE_URL: "http://127.0.0.1:4520",
});
globalThis.fetch = async () => { throw new Error("External network disabled in website form UI fixture"); };
const { createPrismaClient } = await import("@creolab/db");
const prisma = await createPrismaClient();
await (await import("../packages/db/src/seed.ts")).seedDatabase();
const { provisionOrganization } = await import("../apps/api/src/services/organizationProvisioning.ts");
const tenant = await provisionOrganization(prisma, { name: "Новая компания · проверка формы", source: "platform_admin", subscriptionStatus: "active", aiEnabled: false });
const original = await prisma.user.findUniqueOrThrow({ where: { email: "owner@creolab.example" } });
const user = await prisma.user.create({ data: { email: "forms-owner@example.test", name: "Владелец новой компании", passwordHash: original.passwordHash } });
const owner = await prisma.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
await prisma.tenant.update({ where: { id: tenant.id }, data: { settingsJson: { onboarding: { status: "not_started", deferred: false } } } });
const { createApp } = await import("../apps/api/src/app.ts");
const api = createApp(prisma).listen(4521, "127.0.0.1");
const { createServer } = await import("vite");
const web = await createServer({ root: path.resolve("apps/web"), configFile: path.resolve("apps/web/vite.config.ts"), server: {
  host: "127.0.0.1", port: 4520, strictPort: true, proxy: { "/api": "http://127.0.0.1:4521", "/public": "http://127.0.0.1:4521" },
} });
await web.listen();
const { websiteFormSnippet } = await import("../apps/web/src/lib/websiteFormSnippet.ts");
const site = createHttpServer(async (_req, res) => {
  const form = await prisma.formDefinition.findFirst({ where: { tenantId: owner.tenantId } });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Проверочный сайт формы BasQar</title><body style="font:18px system-ui;padding:32px"><h1>Тестовая консультация</h1><p>Отдельный локальный сайт. Рабочие данные и сообщения не используются.</p>${form ? websiteFormSnippet(`http://127.0.0.1:4520/public/forms/${form.publicKey}/submissions`) : "Сначала создайте форму в тестовом BasQar и обновите страницу."}</body></html>`);
}).listen(4522, "127.0.0.1");
console.log("WEBSITE_FORMS_UI_READY http://127.0.0.1:4520/integrations#integration-website; sample site http://127.0.0.1:4522");
process.on("SIGTERM", async () => { await web.close(); api.close(); site.close(); await prisma.$disconnect(); process.exit(0); });
