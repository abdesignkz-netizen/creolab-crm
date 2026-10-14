// Isolated long-message/LID fixture. External providers and background sends are disabled.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const scratch = mkdtempSync(path.join(tmpdir(), "basqar-chat-ui-"));
Object.assign(process.env, {
  NODE_ENV: "test", CRM_USE_PGLITE: "1", CRM_PGLITE_DIR: path.join(scratch, "db"), STORAGE_DIR: path.join(scratch, "uploads"),
  SEED_PASSWORD: "ChatPreviewOnly1!", PLATFORM_ADMIN_EMAIL: "", PLATFORM_ADMIN_PASSWORD: "", ENCRYPTION_KEY: "local-chat-preview-only",
  OPENAI_API_KEY: "", ANYMODEL_API_KEY: "", TRANSCRIPTION_API_KEY: "", WHATSAPP_SELLER_URL: "", WHATSAPP_SELLER_SECRET: "",
  VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", TELEGRAM_BOT_TOKEN: "", BILLING_PROVIDER: "none",
  FREEDOM_PAY_MERCHANT_ID: "", FREEDOM_PAY_SECRET_KEY: "", ESF_PROVIDER: "mock", ESF_ENV: "off", ESF_ALLOW_LIVE_SEND: "0",
  CRM_INLINE_AUTOMATION: "0", ALLOWED_ORIGINS: "http://127.0.0.1:4487", APP_BASE_URL: "http://127.0.0.1:4487",
});
globalThis.fetch = async () => { throw new Error("External network disabled in chat UI fixture"); };
const { createPrismaClient } = await import("@creolab/db");
const prisma = await createPrismaClient();
await (await import("../packages/db/src/seed.ts")).seedDatabase();
const owner = await prisma.membership.findFirstOrThrow({ where: { tenant: { slug: "creolab" }, role: "owner" } });
const tenantId = owner.tenantId;
const integration = await prisma.integration.create({ data: { tenantId, type: "whatsapp_qr", name: "WhatsApp · локальная проверка", status: "active", connectionStatus: "CONNECTED" } });
await prisma.$executeRaw`INSERT INTO "WhatsAppQrSession" ("integrationId") VALUES (${integration.id})`;
const connection = await prisma.channelConnection.create({ data: { tenantId, integrationId: integration.id, channelType: "whatsapp", status: "active", autoReply: false } });
const contact = await prisma.contact.create({ data: { tenantId, name: "Тестовый клиент" } });
const longText = "Здравствуйте! Хотим обсудить разработку презентации. Перед отправкой материалов нужно согласовать условия конфиденциальности.\n\n".repeat(10) + "КОНЕЦ СООБЩЕНИЯ. Можно отправить документ?";
const conversation = await prisma.conversation.create({ data: {
  tenantId, connectionId: connection.id, contactId: contact.id, externalThreadId: "36322639085811@lid", mode: "human", assigneeMembershipId: owner.id,
  waitingFor: "MANAGER", controlVersion: 1, aiHandoffSummaryJson: { controlVersion: 1, request: longText, collected: ["Клиенту нужна презентация.", "До передачи материалов нужен документ."], nextStep: "Ознакомиться с документом и ответить клиенту." },
} });
await prisma.message.create({ data: { tenantId, conversationId: conversation.id, senderKind: "client", direction: "inbound", text: longText } });
const { createApp } = await import("../apps/api/src/app.ts");
const server = createApp(prisma).listen(4488, "127.0.0.1");
const { createServer } = await import("vite");
const web = await createServer({ root: path.resolve("apps/web"), configFile: path.resolve("apps/web/vite.config.ts"), server: {
  host: "127.0.0.1", port: 4487, strictPort: true, proxy: { "/api": "http://127.0.0.1:4488", "/public": "http://127.0.0.1:4488" },
} });
await web.listen();
console.log(`CHAT_UI_READY http://127.0.0.1:4487/conversations/${conversation.id}`);
process.on("SIGTERM", async () => { await web.close(); server.close(); await prisma.$disconnect(); process.exit(0); });
