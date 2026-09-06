import { createPrismaClient } from "@creolab/db";
import { config } from "./config.ts";
import { createApp } from "./app.ts";
import { promoteWebsiteFormsToLive } from "./services/integrationCatalogService.ts";

const prisma = await createPrismaClient();
const promoted = await promoteWebsiteFormsToLive(prisma);
if (promoted.updated > 0) {
  console.log(`Website form integrations switched to live mode: ${promoted.updated}`);
}
const app = createApp(prisma);

app.listen(config.port, () => {
  console.log(`CREOLAB AI CRM API http://127.0.0.1:${config.port}`);
  console.log("WhatsApp не требуется для заявок и кабинета.");
});
