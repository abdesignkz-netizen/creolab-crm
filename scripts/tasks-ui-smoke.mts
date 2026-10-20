// Disposable local fixture. No customer data, providers or background sends.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const scratch = mkdtempSync(path.join(tmpdir(), "basqar-tasks-ui-"));
Object.assign(process.env, {
  NODE_ENV: "test", CRM_USE_PGLITE: "1", CRM_PGLITE_DIR: path.join(scratch, "db"), STORAGE_DIR: path.join(scratch, "uploads"),
  SEED_PASSWORD: "TasksPreviewOnly1!", PLATFORM_ADMIN_EMAIL: "", PLATFORM_ADMIN_PASSWORD: "", ENCRYPTION_KEY: "tasks-local-preview",
  OPENAI_API_KEY: "", ANYMODEL_API_KEY: "", TRANSCRIPTION_API_KEY: "", WHATSAPP_SELLER_URL: "", WHATSAPP_SELLER_SECRET: "",
  VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", TELEGRAM_BOT_TOKEN: "", BILLING_PROVIDER: "none",
  FREEDOM_PAY_MERCHANT_ID: "", FREEDOM_PAY_SECRET_KEY: "", ESF_PROVIDER: "mock", ESF_ENV: "off", ESF_ALLOW_LIVE_SEND: "0",
  CRM_INLINE_AUTOMATION: "0", ALLOWED_ORIGINS: "http://127.0.0.1:4491", APP_BASE_URL: "http://127.0.0.1:4491",
});
globalThis.fetch = async () => { throw new Error("External network disabled in task UI fixture"); };
const { createPrismaClient } = await import("@creolab/db");
const prisma = await createPrismaClient();
await (await import("../packages/db/src/seed.ts")).seedDatabase();
const owner = await prisma.membership.findFirstOrThrow({ where: { tenant: { slug: "creolab" }, role: "owner" } });
const contact = await prisma.contact.create({ data: { tenantId: owner.tenantId, name: "Алия · тестовый клиент",
  methods: { create: { type: "whatsapp", rawValue: "+77015556677", normalizedValue: "77015556677", primary: true, source: "test" } } } });
for (const [type, title] of [["process_inquiry", "Связаться с клиентом: Заявка из WhatsApp"], ["proposal", "Подготовить предложение"], ["payment", "Проверить оплату"], ["note", "Подготовить отчёт за неделю"]]) {
  await prisma.task.create({ data: { tenantId: owner.tenantId, ownerMembershipId: owner.id, type, title,
    contactId: type === "note" ? null : contact.id, targetType: type === "note" ? "none" : "client",
    source: type === "process_inquiry" ? "rule" : "manual",
    dedupeKey: type === "process_inquiry" ? "inquiry-process:ui-preview" : null,
  } });
}
await prisma.campaign.create({ data: { tenantId: owner.tenantId, title: "Тест истории рассылок", status: "failed",
  recipients: { create: [{ tenantId: owner.tenantId, displayName: "Алия", phoneRaw: "+77015556677", status: "failed", error: "WhatsApp временно недоступен" }] } } });
const { createApp } = await import("../apps/api/src/app.ts");
const server = createApp(prisma).listen(4492, "127.0.0.1");
const { createServer } = await import("vite");
const web = await createServer({ root: path.resolve("apps/web"), configFile: path.resolve("apps/web/vite.config.ts"), server: {
  host: "127.0.0.1", port: 4491, strictPort: true, proxy: { "/api": "http://127.0.0.1:4492", "/public": "http://127.0.0.1:4492" },
} });
await web.listen();
console.log("TASKS_UI_READY http://127.0.0.1:4491/tasks");
process.on("SIGTERM", async () => { await web.close(); server.close(); await prisma.$disconnect(); process.exit(0); });
