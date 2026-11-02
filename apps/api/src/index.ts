import { assertProductionSecurity } from "./lib/productionSecurity.ts";
import { createPrismaClient, disconnectPrismaClient } from "@creolab/db";
import { config } from "./config.ts";
import { createApp } from "./app.ts";
import { ensureUploadsRoot } from "./lib/storage.ts";
import { promoteWebsiteFormsToLive } from "./services/integrationCatalogService.ts";
import { installShutdownHandler } from "./lib/shutdown.ts";

assertProductionSecurity();
process.umask(0o077);
const prisma = await createPrismaClient({ registerSignalHandlers: false });
const { ensurePlatformAdmin } = await import("./services/platformAdminBootstrap.ts");
const platformAdmin = await ensurePlatformAdmin(prisma);
if (platformAdmin.created || platformAdmin.updated) {
  console.log("Service administrator account is ready");
}
const { ensureSupportCatalog } = await import("./services/supportKnowledgeService.ts");
await ensureSupportCatalog(prisma);
const promoted = await promoteWebsiteFormsToLive(prisma);
if (promoted.updated > 0) {
  console.log(`Website form integrations switched to live mode: ${promoted.updated}`);
}
const storage = await ensureUploadsRoot();
if (storage.warning) {
  console.warn(`[storage] ${storage.warning}`);
} else {
  console.log(`[storage] uploads at ${storage.uploadsRoot} (${storage.storePathKind})`);
}
const app = createApp(prisma);
let shuttingDown = false;
let stopBackground: (() => Promise<void>) | undefined;
let qrRuntime: { stop(): Promise<void> } | undefined;
// Provider startup must never take down unrelated CRM routes.
const qrStartup = process.env.WHATSAPP_QR_ENABLED !== "0"
  ? import("./services/whatsappQrRuntime.ts").then(({ startWhatsAppQrRuntime }) => {
    if (!shuttingDown) qrRuntime = startWhatsAppQrRuntime(prisma);
  }).catch(() => {
    process.env.WHATSAPP_QR_ENABLED = "0";
    console.error("[whatsapp-qr] Runtime could not start. Check dependency/platform compatibility.");
  }) : Promise.resolve();

let backgroundStartup: Promise<void> = Promise.resolve();
const server = app.listen(config.port, () => {
  console.log(`CREOLAB AI CRM API http://127.0.0.1:${config.port}`);
  console.log("WhatsApp не требуется для заявок и кабинета.");
  backgroundStartup = import("./services/backgroundJobs.ts").then(({ startBackgroundJobs }) => {
    if (!shuttingDown) stopBackground = startBackgroundJobs(prisma);
  });
});

installShutdownHandler(async () => {
  shuttingDown = true;
  const requestsFinished = new Promise<void>((resolve, reject) => server.close(error => {
    if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
    else resolve();
  }));
  await Promise.all([requestsFinished, (async () => {
    await Promise.all([qrStartup, backgroundStartup]);
    await Promise.all([stopBackground?.(), qrRuntime?.stop()]);
  })()]);
  await disconnectPrismaClient();
});

// Bound slow clients and idle connections without shortening long document conversions.
server.headersTimeout = 15_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1000;
