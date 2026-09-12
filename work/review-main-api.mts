import { createPrismaClient } from "@creolab/db";
import { createApp } from "../apps/api/src/app.ts";
const prisma = await createPrismaClient();
const server = createApp(prisma).listen(4100,"127.0.0.1",()=>console.log("CRM_API_READY 4100"));
async function stop(){await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();process.exit(0);}
process.on("SIGINT",stop);process.on("SIGTERM",stop);
