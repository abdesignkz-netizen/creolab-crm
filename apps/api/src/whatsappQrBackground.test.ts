import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { createPrismaClient } from "@creolab/db";
import { startWhatsAppQrRuntime } from "./services/whatsappQrRuntime.ts";

async function until(check: () => Promise<boolean>, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  throw new Error("Background runtime condition timed out");
}

test("QR receives without a browser, renews ownership and reconnects with saved credentials", { timeout: 45000 }, async () => {
  const prisma = await createPrismaClient();
  let runtime: ReturnType<typeof startWhatsAppQrRuntime> | undefined;
  const sockets: any[] = [], snapshots: any[] = [];
  let logouts = 0;
  const factory = (options: any) => {
    snapshots.push(structuredClone(options.auth.creds));
    const socket = { ev: new EventEmitter(), user: { id: "77015550101:1@s.whatsapp.net" }, end() {},
      logout: async () => { logouts++; }, auth: options.auth };
    sockets.push(socket); return socket as any;
  };
  try {
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts"); await seedDatabase();
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "creolab" } });
    const id = randomUUID();
    await prisma.integration.create({ data: { id, tenantId: tenant.id, type: "whatsapp_qr", name: "Background test", status: "pending", connectionStatus: "CONNECTING", testMode: false } });
    await prisma.channelConnection.create({ data: { tenantId: tenant.id, integrationId: id, channelType: "whatsapp", status: "pending" } });
    await prisma.$executeRaw`INSERT INTO "WhatsAppQrSession" ("integrationId") VALUES (${id})`;
    const integration = () => prisma.integration.findUniqueOrThrow({ where: { id } });
    const session = async () => (await prisma.$queryRaw<Array<{ owner: string | null; leaseUntil: Date | null; reconnectAt: Date | null }>>`SELECT owner, "leaseUntil", "reconnectAt" FROM "WhatsAppQrSession" WHERE "integrationId" = ${id}`)[0];
    const receive = async (socket: any, messageId: string, type = "notify") => {
      socket.ev.emit("messages.upsert", { type, messages: [{ key: { id: messageId, remoteJid: "77015550999@s.whatsapp.net", fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: "Сообщение при закрытом кабинете" } }] });
      await until(async () => await prisma.message.count({ where: { tenantId: tenant.id, providerMessageId: messageId } }) === 1);
    };

    // No HTTP server, browser, login session, API polling or manual runtime.tick().
    runtime = startWhatsAppQrRuntime(prisma, factory);
    await until(async () => sockets.length === 1);
    sockets[0].auth.creds.registered = true;
    sockets[0].ev.emit("creds.update", {});
    sockets[0].ev.emit("connection.update", { connection: "open" });
    await until(async () => (await integration()).connectionStatus === "CONNECTED");
    const firstLease = await session();
    await receive(sockets[0], "without-browser");
    await until(async () => (await session()).leaseUntil!.getTime() > firstLease.leaseUntil!.getTime());
    assert.equal((await session()).owner, firstLease.owner);

    sockets[0].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } } });
    await until(async () => (await integration()).connectionStatus === "CONNECTING" && (await session()).owner === null);
    assert.ok((await session()).reconnectAt);
    await until(async () => sockets.length === 2);
    assert.equal(snapshots[1].registered, true);
    assert.deepEqual(snapshots[1].signedIdentityKey, snapshots[0].signedIdentityKey);
    sockets[1].ev.emit("connection.update", { connection: "open" });
    await until(async () => (await integration()).connectionStatus === "CONNECTED");
    await receive(sockets[1], "offline-delivery", "append");

    await runtime.stop();
    assert.equal(logouts, 0, "A server restart must not revoke the linked WhatsApp device");
    runtime = startWhatsAppQrRuntime(prisma, factory);
    await until(async () => sockets.length === 3);
    assert.equal(snapshots[2].registered, true);
    assert.deepEqual(snapshots[2].signedIdentityKey, snapshots[0].signedIdentityKey);
    sockets[2].ev.emit("connection.update", { connection: "open" });
    await until(async () => (await integration()).connectionStatus === "CONNECTED");
    await receive(sockets[2], "after-server-restart");

    // Explicit revocation by WhatsApp must still require re-pairing.
    sockets[2].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
    await until(async () => (await integration()).connectionStatus === "RECONNECT_REQUIRED" && (await session()).owner === null);
    await prisma.$executeRaw`UPDATE "WhatsAppQrSession" SET "reconnectAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "integrationId" = ${id}`;
    await delay(3500);
    assert.equal(sockets.length, 3);
  } finally { await runtime?.stop(); await prisma.$disconnect(); }
});
