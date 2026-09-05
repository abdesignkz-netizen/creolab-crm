import { createPrismaClient } from "@creolab/db";
import { config } from "./config.ts";
import { createApp } from "./app.ts";

const prisma = await createPrismaClient();
const app = createApp(prisma);

app.listen(config.port, () => {
  console.log(`CREOLAB AI CRM API http://127.0.0.1:${config.port}`);
  console.log("WhatsApp не требуется для заявок и кабинета.");
});
