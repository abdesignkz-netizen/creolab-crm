import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { WhatsAppSellerBridge } from "@creolab/integrations";
import { connectWhatsAppSeller } from "./services/sellerLink.ts";
import type { AuthContext } from "./lib/types.ts";

it("creates a seller integration and inherits the tenant on its nested channel", async () => {
  const prisma = await createPrismaClient();
  const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
  await seedDatabase();
  const membership = await prisma.membership.findFirstOrThrow({ where: { role: "owner", tenant: { slug: "creolab" } }, include: { user: true, tenant: true } });
  const auth = { user: membership.user, activeMembership: membership } as unknown as AuthContext;
  const health = mock.method(WhatsAppSellerBridge.prototype, "health", async () => ({ sender: "test", ok: true }));
  try {
    const result = await connectWhatsAppSeller(prisma, auth, { sellerUrl: "https://seller.invalid", secret: "synthetic-test-secret" });
    assert.equal(result.ok, true);
    assert.equal(result.reachable, true);
    const channel = await prisma.channelConnection.findFirstOrThrow({ where: { integrationId: result.integrationId } });
    assert.equal(channel.tenantId, membership.tenantId);
    assert.equal(channel.channelType, "whatsapp");
    const again = await connectWhatsAppSeller(prisma, auth, { sellerUrl: "https://seller.invalid", secret: "synthetic-test-secret" });
    assert.equal(again.integrationId, result.integrationId);
    assert.equal(await prisma.channelConnection.count({ where: { integrationId: result.integrationId } }), 1);
    assert.equal(health.mock.callCount(), 2);
  } finally { mock.restoreAll(); }
});
