// Isolated fixture server for manual browser QA. Never connects to production or payment providers.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const scratch = mkdtempSync(path.join(tmpdir(), "basqar-checkout-ui-"));
Object.assign(process.env, {
  NODE_ENV: "test",
  CRM_USE_PGLITE: "1",
  CRM_PGLITE_DIR: path.join(scratch, "db"),
  STORAGE_DIR: path.join(scratch, "uploads"),
  SEED_PASSWORD: "ChangeMeLocal1!",
  ESF_PROVIDER: "mock",
  ESF_ENV: "off",
  ESF_ALLOW_LIVE_SEND: "0",
  WHATSAPP_SELLER_URL: "",
  WHATSAPP_SELLER_SECRET: "",
  OPENAI_API_KEY: "",
  ANYMODEL_API_KEY: "",
  VAPID_PUBLIC_KEY: "",
  VAPID_PRIVATE_KEY: "",
  ALLOWED_ORIGINS: "http://127.0.0.1:4507",
  CRM_INLINE_AUTOMATION: "0",
  BILLING_PROVIDER: "none",
  BILLING_KASPI_MANUAL_ENABLED: "1",
});
const { createPrismaClient } = await import("@creolab/db");
const db = await createPrismaClient();
await (await import("../packages/db/src/seed.ts")).seedDatabase();
const { authForUserInTenant } =
  await import("../apps/api/src/services/authService.ts");
const owner = await db.user.findUniqueOrThrow({
    where: { email: "owner@creolab.example" },
  }),
  tenant = await db.tenant.findFirstOrThrow({ where: { slug: "creolab" } }),
  platform = await db.user.findUniqueOrThrow({
    where: { email: "platform@creolab.example" },
  });
const auth = await authForUserInTenant(db, owner.id, tenant.id),
  admin = { ...auth, user: platform, activeMembership: null };
const { saveSeller, renderBillingInvoice } =
  await import("../apps/api/src/services/billing/documents.ts");
await saveSeller(db, admin, {
  legalName: "Тестовый поставщик BasQar",
  bin: "123456789012",
  legalAddress: "Алматы, тестовая улица, 1",
  iban: "KZ123456789012345678",
  bankName: "Тестовый банк",
  bik: "TESTKZKX",
  kbe: "17",
  vatEnabled: true,
  vatRate: 16,
  supportEmail: "billing@example.test",
  supportPhone: "+77000000000",
  invoicePrefix: "BSQ-INV",
});
const { createCheckout, payOrder } =
  await import("../apps/api/src/services/billing/ledger.ts");
const order = await createCheckout(db, auth, { planCode: "CONTROL" });
const detail = await payOrder(db, auth, {
  orderId: order.id,
  method: "BANK_TRANSFER",
  buyer: {
    legalName: "Тестовый покупатель",
    bin: "987654321012",
    legalAddress: "Астана, тестовая улица, 2",
    email: "buyer@example.test",
    phone: "+77000000001",
  },
});
writeFileSync(
  path.join(scratch, "invoice.pdf"),
  await renderBillingInvoice(detail.invoice!),
);
writeFileSync(
  "/tmp/basqar-ux-fixture.json",
  JSON.stringify({
    url: "http://127.0.0.1:4507",
    orderId: order.id,
    pdf: path.join(scratch, "invoice.pdf"),
  }),
);
const { createApp } = await import("../apps/api/src/app.ts");
const server = createApp(db).listen(4508, "127.0.0.1");
const { createServer } = await import("vite");
const web = await createServer({
  root: path.resolve("apps/web"),
  configFile: path.resolve("apps/web/vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port: 4507,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4508",
      "/public": "http://127.0.0.1:4508",
      "/health": "http://127.0.0.1:4508",
    },
  },
});
await web.listen();
console.log("ISOLATED_UI_READY http://127.0.0.1:4507");
process.on("SIGTERM", async () => {
  await web.close();
  server.close();
  await db.$disconnect();
  process.exit(0);
});
