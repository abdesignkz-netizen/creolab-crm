import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const scratch = mkdtempSync(path.join(tmpdir(), "creolab-ui-check-"));
Object.assign(process.env, {
  NODE_ENV: "test", CRM_USE_PGLITE: "1", CRM_PGLITE_DIR: path.join(scratch, "db"), STORAGE_DIR: path.join(scratch, "uploads"),
  SEED_PASSWORD: "ChangeMeLocal1!", ESF_PROVIDER: "mock", ESF_ENV: "test", ESF_ALLOW_LIVE_SEND: "0",
  WHATSAPP_SELLER_URL: "", WHATSAPP_SELLER_SECRET: "", OPENAI_API_KEY: "", ANYMODEL_API_KEY: "", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "",
  ALLOWED_ORIGINS: "http://127.0.0.1:4197", CRM_INLINE_AUTOMATION: "0",
});
const { createPrismaClient } = await import("@creolab/db");
const { seedDatabase } = await import("../packages/db/src/seed.ts");
const prisma = await createPrismaClient();
await seedDatabase();
const { createApp } = await import("../apps/api/src/app.ts");
const app = createApp(prisma);
const server = app.listen(4198, "127.0.0.1");
const { createServer } = await import("vite");
const web = await createServer({ root: path.resolve("apps/web"), configFile: path.resolve("apps/web/vite.config.ts"), server: {
  host: "127.0.0.1", port: 4197, strictPort: true, proxy: { "/api": "http://127.0.0.1:4198", "/public": "http://127.0.0.1:4198", "/health": "http://127.0.0.1:4198" },
} });
await web.listen();
console.log("ISOLATED_UI_READY http://127.0.0.1:4197");
process.on("SIGTERM", async () => { await web.close(); server.close(); process.exit(0); });
