import type { PrismaClient } from "@creolab/db";
import type { PdfImportParty } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";

/** Called in the import transaction after the user has reviewed the seller. */
export async function fillImportedSeller(tx: Pick<PrismaClient,"tenantLegalProfile">, tenantId: string, seller: PdfImportParty) {
  const profile = await tx.tenantLegalProfile.findUnique({ where: { tenantId } });
  const taxId = profile?.bin || profile?.iin;
  if (!seller.bin || !seller.name) return { fields: [] as string[], warning: "В договоре не заполнены название и БИН исполнителя. Реквизиты организации не перенесены." };
  if (taxId && taxId !== seller.bin) return { fields: [] as string[], warning: "БИН исполнителя отличается от БИН вашей организации. Её реквизиты не изменены." };
  const values = { legalName:seller.name, bin:seller.bin, legalAddress:seller.legalAddress, directorName:seller.directorName, iban:seller.iban, bik:seller.bik, bankName:seller.bankName };
  const data: Record<string,string> = {};
  for (const [key,value] of Object.entries(values)) if (value && !(profile as unknown as Record<string,unknown> | null)?.[key]) data[key] = value;
  if (Object.keys(data).length) await tx.tenantLegalProfile.upsert({ where:{tenantId}, create:{tenantId,...data}, update:data });
  return { fields:Object.keys(data), warning:null };
}

export async function restoreImportedRequisites(prisma: PrismaClient, auth: AuthContext, contractId: string) {
  const tenantId = auth.activeMembership?.tenantId;
  if (!tenantId || !can(auth,"manage_documents")) throw new ApiError(403,"forbidden","Недостаточно прав для реквизитов");
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    const contract = await tx.contract.findFirst({where:{id:contractId,tenantId}});
    if (!contract?.originalFileId) throw new ApiError(404,"not_found","Загруженный договор не найден");
    const audit = await tx.auditEvent.findFirst({where:{tenantId,entityType:"contract",entityId:contractId,action:"document.import_pdf"},orderBy:{createdAt:"desc"}});
    const draft = (audit?.changesJson as any)?.reviewedImport;
    if (!draft?.seller) throw new ApiError(422,"import_details_missing","В этом договоре нет сохранённых распознанных реквизитов. Загрузите файл для распознавания.");
    const result = await fillImportedSeller(tx,tenantId,draft.seller);
    if (result.warning) throw new ApiError(422,"import_seller_mismatch",result.warning);
    await tx.auditEvent.create({data:{tenantId,actorUserId:auth.user.id,action:"document.restore_requisites",entityType:"contract",entityId:contractId,changesJson:{fields:result.fields}}});
    return {ok:true, ...result};
  });
}
