import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const scratch = mkdtempSync(path.join(tmpdir(), "creolab-ui-check-"));
Object.assign(process.env, {
  NODE_ENV: "test", CRM_USE_PGLITE: "1", CRM_PGLITE_DIR: path.join(scratch, "db"), STORAGE_DIR: path.join(scratch, "uploads"),
  SEED_PASSWORD: "ChangeMeLocal1!", ESF_PROVIDER: "mock", ESF_ENV: "test", ESF_ALLOW_LIVE_SEND: "0",
  WHATSAPP_SELLER_URL: "", WHATSAPP_SELLER_SECRET: "", OPENAI_API_KEY: "", ANYMODEL_API_KEY: "", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "",
  ALLOWED_ORIGINS: "http://127.0.0.1:4497", CRM_INLINE_AUTOMATION: "0",
});
const { createPrismaClient } = await import("@creolab/db");
const { seedDatabase } = await import("../packages/db/src/seed.ts");
const prisma = await createPrismaClient();
await seedDatabase();
const { provisionOrganization } = await import("../apps/api/src/services/organizationProvisioning.ts");
await prisma.$transaction(async tx => {
  const tenant = await provisionOrganization(tx, { name: "Free UI", source: "self_registration", subscriptionStatus: "none", aiEnabled: false });
  const hash = (await tx.user.findUniqueOrThrow({where:{email:"owner@creolab.example"}})).passwordHash;
  const user = await tx.user.create({data:{email:"free-ui@basqar.test",name:"Free UI",passwordHash:hash}});
  await tx.membership.create({data:{tenantId:tenant.id,userId:user.id,role:"owner"}});
});
const { createApp } = await import("../apps/api/src/app.ts");
const app = createApp(prisma);
const server = app.listen(4498, "127.0.0.1");
const { createServer } = await import("vite");
const web = await createServer({ root: path.resolve("apps/web"), configFile: path.resolve("apps/web/vite.config.ts"), server: {
  host: "127.0.0.1", port: 4497, strictPort: true, proxy: { "/api": "http://127.0.0.1:4498", "/public": "http://127.0.0.1:4498", "/health": "http://127.0.0.1:4498" },
} });
await web.listen();
console.log("ISOLATED_UI_READY http://127.0.0.1:4497");
process.on("SIGTERM", async () => { await web.close(); server.close(); process.exit(0); });
