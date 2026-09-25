import type { PrismaClient } from "@creolab/db";
import { rm } from "node:fs/promises";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { resolveUploadPath } from "../lib/storage.ts";

export async function deleteAvr(prisma: PrismaClient, auth: AuthContext, id: string) {
  const tenantId = auth.activeMembership?.tenantId;
  if (!tenantId || !can(auth, "manage_documents")) throw new ApiError(403, "forbidden", "Недостаточно прав для удаления АВР");
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ElectronicDocument" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const document = await tx.electronicDocument.findFirst({ where: { id, tenantId, type: "AVR" } });
    if (!document) throw new ApiError(404, "not_found", "АВР не найден или уже удалён");
    const signing = await tx.avrSigning.findFirst({ where: { tenantId, documentId: id } });
    if (signing?.buyerSignature || signing?.status === "SIGNED" || document.externalId) {
      throw new ApiError(409, "avr_signed", "Подписанный или отправленный АВР удалить нельзя");
    }
    if (signing) throw new ApiError(409, "avr_signing_active", "Сначала отмените подписание АВР");
    const files = await tx.attachment.findMany({ where: { tenantId, parentType: "electronic_document", parentId: id } });
    await tx.auditEvent.create({ data: { tenantId, actorUserId: auth.user.id, action: "avr.delete", entityType: "electronic_document", entityId: id, changesJson: { number: document.number } } });
    await tx.electronicDocument.delete({ where: { id } });
    return { files, dealId: document.dealId };
  });
  for (const file of result.files) {
    await rm(resolveUploadPath(file.storageKey), { force: true }).catch(() => {});
    await prisma.attachment.deleteMany({ where: { id: file.id, tenantId } });
  }
  return { ok: true, dealId: result.dealId };
}
