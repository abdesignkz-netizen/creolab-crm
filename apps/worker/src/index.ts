import { assertProductionSecurity } from "../../api/src/lib/productionSecurity.ts";
import dotenv from "dotenv";
import { createPrismaClient, disconnectPrismaClient } from "@creolab/db";
import { startBackgroundJobs } from "../../api/src/services/backgroundJobs.ts";
import { installShutdownHandler } from "../../api/src/lib/shutdown.ts";

dotenv.config();

assertProductionSecurity();
process.umask(0o077);
const prisma = await createPrismaClient({ registerSignalHandlers: false });
console.log("CRM worker started. Outbox + scheduled + campaign queue + agreement reminders.");
const stop = startBackgroundJobs(prisma, { keepAlive: true });
installShutdownHandler(async () => {
  await stop();
  await disconnectPrismaClient();
});
