// Disposable full-app fixture. No real customers, messages, payments or providers.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const scratch = mkdtempSync(path.join(tmpdir(), "basqar-forecast-ui-"));
Object.assign(process.env, {
  NODE_ENV: "test", CRM_USE_PGLITE: "1", CRM_PGLITE_DIR: path.join(scratch, "db"), STORAGE_DIR: path.join(scratch, "uploads"),
  SEED_PASSWORD: "ForecastPreviewOnly1!", PLATFORM_ADMIN_EMAIL: "", PLATFORM_ADMIN_PASSWORD: "", ENCRYPTION_KEY: "forecast-local-preview",
  OPENAI_API_KEY: "", ANYMODEL_API_KEY: "", TRANSCRIPTION_API_KEY: "", WHATSAPP_SELLER_URL: "", WHATSAPP_SELLER_SECRET: "",
  VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", TELEGRAM_BOT_TOKEN: "", BILLING_PROVIDER: "none",
  FREEDOM_PAY_MERCHANT_ID: "", FREEDOM_PAY_SECRET_KEY: "", ESF_PROVIDER: "mock", ESF_ENV: "off", ESF_ALLOW_LIVE_SEND: "0",
  CRM_INLINE_AUTOMATION: "0", WHATSAPP_QR_ENABLED: "0", ALLOWED_ORIGINS: "http://127.0.0.1:4524",
  APP_BASE_URL: "http://127.0.0.1:4524", API_BASE_URL: "http://127.0.0.1:4524",
});
globalThis.fetch = async () => { throw new Error("External network disabled in forecast UI fixture"); };
const { createPrismaClient } = await import("@creolab/db");
const prisma = await createPrismaClient();
await (await import("../packages/db/src/seed.ts")).seedDatabase();
const { provisionOrganization } = await import("../apps/api/src/services/organizationProvisioning.ts");
const tenant = await provisionOrganization(prisma, { name: "Демо · прогноз продаж", source: "platform_admin", subscriptionStatus: "active", aiEnabled: false });
const original = await prisma.user.findUniqueOrThrow({ where: { email: "owner@creolab.example" } });
const user = await prisma.user.create({ data: { email: "forecast-owner@example.test", name: "Владелец демо", passwordHash: original.passwordHash } });
const owner = await prisma.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
const { forecastMonth } = await import("../apps/api/src/services/salesForecastPolicy.ts");
const { zonedYmd } = await import("../apps/api/src/services/periodRange.ts");
const today = zonedYmd(new Date(), tenant.timezone);
const current = forecastMonth(tenant.timezone, today.year, today.month);
const start = forecastMonth(tenant.timezone, today.year, today.month - 7).from;
const { authForUserInTenant } = await import("../apps/api/src/services/authService.ts");
const auth = await authForUserInTenant(prisma, user.id, tenant.id, "forecast-ui");
const { updateControlCompany, upsertControlAccess } = await import("../apps/api/src/services/aiControlService.ts");
await updateControlCompany(prisma, auth, { enabled: true });
await upsertControlAccess(prisma, auth, user.id, { enabled: true, allowedSources: ["CRM_CHAT"], canReadFinancialData: true });
const { getTenantOps, updateTenantOps } = await import("../apps/api/src/services/dealService.ts");
const ops = await getTenantOps(prisma, auth);
await updateTenantOps(prisma, auth, { revision: ops.revision, salesPlans: [{ month: current.month, amount: 600000, currency: "KZT" }] });
const stageId = ops.stages.find(s => s.systemKey === "won")?.id || ops.stages[0].id;
const contact = await prisma.contact.create({ data: { tenantId: tenant.id, name: "Демонстрационный клиент", firstSeenAt: start } });
for (let i = 0; i < 6; i++) {
  const month = forecastMonth(tenant.timezone, today.year, today.month - 6 + i);
  for (let k = 0; k < 5; k++) await prisma.deal.create({ data: { tenantId: tenant.id, contactId: contact.id, stageId,
    title: `Пример продажи ${month.month} / ${k + 1}`, outcome: "won", currency: "KZT", wonAmountMinor: month.days * [10000, 15000, 12000, 11000, 9000, 13000][i] / 5,
    createdAt: start, closedAt: new Date(month.from.getTime() + (k + 1) * 86400000), assigneeMembershipId: owner.id } });
}
await prisma.deal.create({ data: { tenantId: tenant.id, contactId: contact.id, stageId, title: "Продажа текущего месяца", outcome: "won", currency: "KZT", wonAmountMinor: 170000,
  createdAt: start, closedAt: current.from, assigneeMembershipId: owner.id } });
const { createApp } = await import("../apps/api/src/app.ts");
const server = createApp(prisma).listen(4525, "127.0.0.1");
const { createServer } = await import("vite");
const web = await createServer({ root: path.resolve("apps/web"), configFile: path.resolve("apps/web/vite.config.ts"), server: {
  host: "127.0.0.1", port: 4524, strictPort: true, proxy: { "/api": "http://127.0.0.1:4525", "/public": "http://127.0.0.1:4525" },
} });
await web.listen();
console.log("FORECAST_UI_READY http://127.0.0.1:4524/stats?tab=sales; local account forecast-owner@example.test");
process.on("SIGTERM", async () => { await web.close(); server.close(); await prisma.$disconnect(); process.exit(0); });
