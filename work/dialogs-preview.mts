import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const scratch = mkdtempSync(path.join(tmpdir(), "creolab-ui-check-"));
Object.assign(process.env, {
  NODE_ENV: "test", CRM_USE_PGLITE: "1", CRM_PGLITE_DIR: path.join(scratch, "db"), STORAGE_DIR: path.join(scratch, "uploads"),
  SEED_PASSWORD: "ChangeMeLocal1!", ESF_PROVIDER: "mock", ESF_ENV: "test", ESF_ALLOW_LIVE_SEND: "0",
  WHATSAPP_SELLER_URL: "", WHATSAPP_SELLER_SECRET: "", OPENAI_API_KEY: "", ANYMODEL_API_KEY: "", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "",
  ALLOWED_ORIGINS: "http://127.0.0.1:4397", CRM_INLINE_AUTOMATION: "0",
});
const { createPrismaClient } = await import("@creolab/db");
const { seedDatabase } = await import("../packages/db/src/seed.ts");
const prisma = await createPrismaClient();
await seedDatabase();
const tenant = await prisma.tenant.findUniqueOrThrow({where:{slug:"creolab"}});
const owner = await prisma.membership.findFirstOrThrow({where:{tenantId:tenant.id,role:"owner"}});
for (const [channel, name] of [["whatsapp","Atlas Group"],["telegram","Алия Касымова"],["instagram","Global Engineering"],["email","Qazaq Systems"]]) {
 const contact=await prisma.contact.create({data:{tenantId:tenant.id,name}});
 let connectionId;
 if(channel!=="whatsapp"){
  const integration=await prisma.integration.create({data:{tenantId:tenant.id,type:channel,name:channel,status:"active"}});
  const connection=await prisma.channelConnection.create({data:{tenantId:tenant.id,integrationId:integration.id,channelType:channel,status:"active"}});connectionId=connection.id;
 }
 const conversation=await prisma.conversation.create({data:{tenantId:tenant.id,contactId:contact.id,connectionId,sellerLeadId:channel==="whatsapp"?"ui-wa":undefined,mode:"human",status:"open",assigneeMembershipId:owner.id}});
 for(let n=0;n<12;n++)await prisma.message.create({data:{tenantId:tenant.id,conversationId:conversation.id,direction:n%2?"outbound":"inbound",senderKind:n%2?"staff":"client",text:n%2?"Здравствуйте! Подготовим обновлённое предложение. Уточните, пожалуйста, сроки проекта.":"Добрый день! Мы посмотрели ваше предложение. Можете отправить обновлённое КП на 20 пользователей?",createdAt:new Date(Date.now()-(12-n)*60000)}});
}
const { createApp } = await import("../apps/api/src/app.ts");
const app = createApp(prisma);
const server = app.listen(4398, "127.0.0.1");
const { createServer } = await import("vite");
const web = await createServer({ root: path.resolve("apps/web"), configFile: path.resolve("apps/web/vite.config.ts"), server: {
  host: "127.0.0.1", port: 4397, strictPort: true, proxy: { "/api": "http://127.0.0.1:4398", "/public": "http://127.0.0.1:4398", "/health": "http://127.0.0.1:4398" },
} });
await web.listen();
console.log("ISOLATED_UI_READY http://127.0.0.1:4397");
process.on("SIGTERM", async () => { await web.close(); server.close(); process.exit(0); });
