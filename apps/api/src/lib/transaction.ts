import type { Prisma, PrismaClient } from "@creolab/db";

export type DomainDb = PrismaClient | Prisma.TransactionClient;
/** Domain operations can join the caller's transaction without an early commit. */
export function inTransaction<T>(db: DomainDb, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return "$transaction" in db ? db.$transaction(work) : work(db);
}
