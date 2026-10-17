import type { Prisma, PrismaClient } from "@creolab/db";
import { logServerError } from "../lib/redact.ts";

const LEASE_MS = 60_000;

// availableAt doubles as an expiring claim. CAS makes this work across API and
// worker processes, without holding a database transaction during a network call.
export async function claimOutboxEvent(prisma: PrismaClient, id: string) {
  let until = new Date(Date.now() + LEASE_MS);
  const claim = await prisma.outboxEvent.updateMany({
    where: { id, processedAt: null, availableAt: { lte: new Date() } },
    data: { availableAt: until },
  });
  if (!claim.count) return null;
  let stopped = false;
  let renewal: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (stopped || renewal) return;
    renewal = (async () => {
      const next = new Date(Date.now() + LEASE_MS);
      const result = await prisma.outboxEvent.updateMany({
        where: { id, processedAt: null, availableAt: until }, data: { availableAt: next },
      });
      if (result.count) until = next;
      else { stopped = true; clearInterval(timer); }
    })().catch(error => logServerError(error, "background:outbox lease")).finally(() => { renewal = null; });
  }, LEASE_MS / 3);
  timer.unref?.();
  return {
    async finish(data: Prisma.OutboxEventUpdateManyMutationInput) {
      stopped = true; clearInterval(timer);
      await renewal;
      // An expired/reclaimed event must never be completed by its previous owner.
      return prisma.outboxEvent.updateMany({ where: { id, processedAt: null, availableAt: until }, data });
    },
  };
}
