import { assertProductionSecurity } from "../../api/src/lib/productionSecurity.ts";
import dotenv from "dotenv";
import { createPrismaClient } from "@creolab/db";
import { startBackgroundJobs } from "../../api/src/services/backgroundJobs.ts";

dotenv.config();

assertProductionSecurity();
process.umask(0o077);
const prisma = await createPrismaClient();
console.log("CRM worker started. Outbox + scheduled + campaign queue + agreement reminders.");
const stop = startBackgroundJobs(prisma, { keepAlive: true });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    stop();
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}
