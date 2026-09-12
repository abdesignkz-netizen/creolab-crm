import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";

function hashPayload(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value ?? {})).digest("hex");
}

export async function withIdempotency<T>(
  prisma: PrismaClient,
  input: {
    scope: string;
    actorKey: string;
    key?: string | null;
    payload: unknown;
    ttlMs?: number;
    run: () => Promise<T>;
  },
): Promise<T> {
  const key = String(input.key || "").trim();
  if (!key) return input.run();

  const requestHash = hashPayload(input.payload);
  const existing = await prisma.idempotencyRecord.findUnique({
    where: { scope_actorKey_key: { scope: input.scope, actorKey: input.actorKey, key } },
  });
  if (existing) {
    if (existing.expiresAt.getTime() < Date.now()) {
      await prisma.idempotencyRecord.delete({ where: { id: existing.id } }).catch(() => undefined);
    } else if (existing.requestHash !== requestHash) {
      throw new ApiError(409, "idempotency_conflict", "Повтор с тем же ключом, но другим телом запроса");
    } else {
      return existing.resultJson as T;
    }
  }

  const result = await input.run();
  try {
    await prisma.idempotencyRecord.create({
      data: {
        scope: input.scope,
        actorKey: input.actorKey,
        key,
        requestHash,
        resultJson: result as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + (input.ttlMs ?? 24 * 60 * 60 * 1000)),
      },
    });
  } catch {
    const raced = await prisma.idempotencyRecord.findUnique({
      where: { scope_actorKey_key: { scope: input.scope, actorKey: input.actorKey, key } },
    });
    if (raced?.requestHash === requestHash) return raced.resultJson as T;
  }
  return result;
}
