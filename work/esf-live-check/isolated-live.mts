import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
const statePath = "work/esf-live-check/isolated-live-state.json";
const previous = process.env.CRM_RESUME_TEST_POC === "1" && existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8")) : null;
const scratch = previous?.scratch || mkdtempSync(path.join(tmpdir(), "creolab-real-test-poc-"));
if (previous && (!scratch.includes("creolab-real-test-poc-") || !existsSync(path.join(scratch, "db")))) throw new Error("Invalid TEST scratch database");
Object.assign(process.env, {
  NODE_ENV: "development", CRM_USE_PGLITE: "1", CRM_PGLITE_DIR: path.join(scratch, "db"), STORAGE_DIR: path.join(scratch, "files"),
  DATABASE_URL: "", SEED_PASSWORD: "ChangeMeLocal1!", SESSION_SECRET: randomBytes(32).toString("hex"),
  ESF_PROVIDER: "live", ESF_ENV: "test", ESF_ALLOW_LIVE_SEND: "1", ESF_ALLOW_PROD: "0", ESF_TLS_INSECURE: "0", ESF_LEGACY_POC_ENABLED: "0", ESF_ALLOW_SERVER_P12: "0",
  ESF_AUTH_CERT_PEM: "", ESF_AUTH_CERT_PEM_FILE: "", ESF_SIGN_CERT_PEM: "", ESF_SIGN_CERT_PEM_FILE: "", ESF_SIGN_CERT_PATH: "", ESF_SIGN_CERT_PIN: "", ESF_PASSWORD: "", ESF_TIN: "", ESF_IIN: "",
  WHATSAPP_SELLER_URL: "", WHATSAPP_SELLER_SECRET: "", OPENAI_API_KEY: "", ANYMODEL_API_KEY: "", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "",
  ALLOWED_ORIGINS: "http://localhost:4297", CRM_INLINE_AUTOMATION: "0",
});
const { createPrismaClient } = await import("@creolab/db");
const { seedDatabase } = await import("../../packages/db/src/seed.ts");
const prisma = await createPrismaClient();
if (!previous) await seedDatabase();
const tenant = await prisma.tenant.update({where:{slug:"creolab"},data:{name:"CREOLAB — TEST POC"}});
await prisma.tenantLegalProfile.upsert({where:{tenantId:tenant.id},create:{tenantId:tenant.id,legalName:"ТОО Creolab",bin:"221140036408",documentsEnabled:true},update:{legalName:"ТОО Creolab",bin:"221140036408",documentsEnabled:true}});
const { readEsfConfig, assertTestEndpointNotProduction } = await import("../../apps/api/src/integrations/esf/EsfConfig.ts");
const esf = readEsfConfig();assertTestEndpointNotProduction(esf);
if(esf.esfEnv!=="test" || esf.provider!=="live")throw new Error("TEST live only");
const { createApp } = await import("../../apps/api/src/app.ts");
const server = createApp(prisma).listen(4298,"127.0.0.1");
const {createServer}=await import("vite");
const web=await createServer({root:path.resolve("apps/web"),configFile:path.resolve("apps/web/vite.config.ts"),server:{host:"127.0.0.1",port:4297,strictPort:true,proxy:{"/api":"http://127.0.0.1:4298","/health":"http://127.0.0.1:4298","/public":"http://127.0.0.1:4298"}}});
await web.listen();
writeFileSync("work/esf-live-check/isolated-live-state.json",JSON.stringify({scratch,tenantId:tenant.id,environment:esf.esfEnv,endpointHost:esf.endpointHost,url:"http://localhost:4297/integrations/esf"},null,2));
console.log(`LIVE_TEST_POC_READY http://localhost:4297/integrations/esf host=${esf.endpointHost}`);
async function stop(){await web.close();await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();process.exit(0);}
process.on("SIGINT",stop);process.on("SIGTERM",stop);
