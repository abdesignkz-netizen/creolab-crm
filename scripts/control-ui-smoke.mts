// Isolated BasQar Control fixture. External providers and background sends are disabled.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const scratch = mkdtempSync(path.join(tmpdir(), "basqar-control-ui-"));
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
const { authForUserInTenant } = await import("../apps/api/src/services/authService.ts");
const { updateControlCompany, upsertControlAccess, createControlIdentity } = await import("../apps/api/src/services/aiControlService.ts");
const { saveControlChatSettings } = await import("../apps/api/src/services/controlChatSettings.ts");
const auth = await authForUserInTenant(prisma, owner.userId, tenantId, "local-control-preview");
await updateControlCompany(prisma, auth, { enabled: true });
await upsertControlAccess(prisma, auth, owner.userId, { enabled: true, canReadFinancialData: true, canReadTeamData: true, canCreateTasks: true, canModifyDeals: true });
const integration = await prisma.integration.create({ data: { tenantId, type: "whatsapp_qr", name: "WhatsApp компании · тест", status: "active", connectionStatus: "CONNECTED", schemaJson: { phone: "77010001122" } } });
const identity = await createControlIdentity(prisma, auth, { userId: owner.userId, phone: "+77015556677", verifyNow: true });
await saveControlChatSettings(prisma, auth, identity.identity.id, { integrationId: integration.id, enabled: true, language: "ru", morningEnabled: true, morningTime: "09:00", eveningEnabled: false, eveningTime: "18:00", weekdaysOnly: true });
const { createApp } = await import("../apps/api/src/app.ts");
const server = createApp(prisma).listen(4488, "127.0.0.1");
const { createServer } = await import("vite");
const web = await createServer({ root: path.resolve("apps/web"), configFile: path.resolve("apps/web/vite.config.ts"), server: {
  host: "127.0.0.1", port: 4487, strictPort: true, proxy: { "/api": "http://127.0.0.1:4488", "/public": "http://127.0.0.1:4488" },
} });
await web.listen();
console.log("CONTROL_UI_READY http://127.0.0.1:4487/settings?section=control");
process.on("SIGTERM", async () => { await web.close(); server.close(); await prisma.$disconnect(); process.exit(0); });
