import type { Prisma, PrismaClient } from "@creolab/db";
import { z } from "zod";

const sellerSchema = z.object({
  name: z.string().trim().min(1), bin: z.string().regex(/^\d{12}$/),
  legalAddress: z.string().default(""), directorName: z.string().default(""),
  iban: z.string().default(""), bik: z.string().default(""), bankName: z.string().default(""),
});

/** Resolve missing document fields from the user-reviewed import of this deal.
 * Read-only: does not edit organisation settings or infer a signature from a scan.
 */
export async function documentOrganization(prisma: PrismaClient | Prisma.TransactionClient, tenantId: string, dealId: string, contractId?: string | null) {
  const profile = await prisma.tenantLegalProfile.findUnique({ where: { tenantId } });
  const where = { tenantId, dealId, status: { notIn: ["CANCELLED", "VOID"] } };
  const contract = contractId
    ? await prisma.contract.findFirst({ where: { ...where, id: contractId } })
    : await prisma.contract.findFirst({ where: { ...where, status: "SIGNED" }, orderBy: { signedAt: "desc" } })
      || await prisma.contract.findFirst({ where, orderBy: { createdAt: "desc" } });
  if (!contract?.originalFileId) return profile;
  const audit = await prisma.auditEvent.findFirst({
    where: { tenantId, entityType: "contract", entityId: contract.id, action: "document.import_pdf" },
    orderBy: { createdAt: "desc" },
  });
  const changes = audit?.changesJson as { reviewedImport?: { seller?: unknown } } | null;
  const parsed = sellerSchema.safeParse(changes?.reviewedImport?.seller);
  if (!parsed.success) return profile;
  const seller = parsed.data;
  const taxId = profile?.bin?.trim() || profile?.iin?.trim();
  if (taxId && taxId !== seller.bin) return profile;
  const filled = (current: string | null | undefined, imported: string) => current?.trim() ? current : imported.trim() || null;
  return {
    ...profile,
    legalName: filled(profile?.legalName, seller.name),
    bin: profile?.iin?.trim() ? profile.bin : filled(profile?.bin, seller.bin),
    iin: profile?.iin || null,
    legalAddress: filled(profile?.legalAddress, seller.legalAddress),
    directorName: filled(profile?.directorName, seller.directorName),
    directorPosition: profile?.directorPosition || null,
    iban: filled(profile?.iban, seller.iban),
    bik: filled(profile?.bik, seller.bik),
    bankName: filled(profile?.bankName, seller.bankName),
  };
}
