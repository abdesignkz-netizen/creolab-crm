import type { PrismaClient } from "@creolab/db";
import { rm } from "node:fs/promises";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { resolveUploadPath } from "../lib/storage.ts";

export async function deleteContract(prisma: PrismaClient, auth: AuthContext, contractId: string) {
  const tenantId = auth.activeMembership?.tenantId;
  if (!tenantId || !can(auth, "manage_documents")) throw new ApiError(403, "forbidden", "Недостаточно прав для удаления договора");
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    // Serializes deletion with signing and references created through foreign keys.
    await tx.$queryRaw`SELECT id FROM "Contract" WHERE id = ${contractId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const contract = await tx.contract.findFirst({ where: { id: contractId, tenantId } });
    if (!contract) throw new ApiError(404, "not_found", "Договор не найден или уже удалён");
    const signed = contract.signedAt || contract.finalSignedFileId || ["SIGNED", "PARTIALLY_SIGNED"].includes(contract.status)
      || await tx.documentSignature.count({where:{tenantId,contractId}})
      || await tx.signatureRequest.count({where:{tenantId,contractId,OR:[{status:"SIGNED"},{signedAt:{not:null}}]}});
    if (signed) throw new ApiError(409, "contract_signed", "Договор уже имеет электронную подпись. Удаление недоступно.");
    const invoices = await tx.invoice.count({where:{tenantId,contractId}});
    const documents = await tx.electronicDocument.count({where:{tenantId,contractId}});
    if (invoices || documents) throw new ApiError(409, "contract_has_documents", "С договором связаны счета, АВР или ЭСФ. Удаление нарушит их связи и поэтому недоступно.");
    const files = await tx.attachment.findMany({where:{tenantId,parentType:"contract",parentId:contractId}});
    // Keep failed filesystem cleanups identifiable and inaccessible as contract files.
    await tx.attachment.updateMany({where:{id:{in:files.map(f=>f.id)},tenantId},data:{parentType:"deleted_contract",status:"deletion_pending"}});
    await tx.auditEvent.create({data:{tenantId,actorUserId:auth.user.id,entityType:"contract",entityId:contractId,action:"contract.delete",changesJson:{number:contract.number,dealId:contract.dealId,status:contract.status,imported:Boolean(contract.originalFileId),files:files.map(f=>f.id)}}});
    // Some older installations lack the cascade constraints from the schema.
    await tx.signatureRequest.deleteMany({where:{tenantId,contractId}});
    await tx.contractVersion.deleteMany({where:{tenantId,contractId}});
    await tx.contract.delete({where:{id:contractId}});
    return {dealId:contract.dealId,files};
  });
  for (const file of result.files) {
    try {
      await rm(resolveUploadPath(file.storageKey),{force:true});
      await prisma.attachment.deleteMany({where:{id:file.id,tenantId,status:"deletion_pending"}});
    } catch {
      // The document is already deleted. A retryable storage tombstone remains.
      console.warn("Contract file cleanup pending", {attachmentId:file.id});
    }
  }
  return {ok:true,dealId:result.dealId};
}
