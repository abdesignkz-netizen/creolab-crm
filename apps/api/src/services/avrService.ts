import { avrEditorSchema, avrEditorAmounts, type AvrEditorInput } from "@creolab/contracts";
import { documentOrganization } from "./documentOrganization.ts";
import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { serializeDealItem } from "./dealItemService.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";
import { serializeElectronicDocument } from "./documentDraftService.ts";
import { mapAvrSource } from "./avrMapper.ts";
import { assessAvrReadiness, avrMissingFieldsError } from "./avrReadiness.ts";

const MUTABLE = new Set(["DRAFT", "VALIDATED"]);

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function requireManageDocuments(auth: AuthContext) {
  if (!can(auth, "manage_documents")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для документов");
  }
}

async function nextAvrNumber(prisma: PrismaClient, tenantId: string) {
  const count = await prisma.electronicDocument.count({ where: { tenantId, type: "AVR" } });
  return `AVR-${new Date().getFullYear()}-${String(count + 1).padStart(4, "0")}`;
}

async function loadAvrBundle(prisma: PrismaClient, tenantId: string, dealId: string, contractId?: string | null) {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId },
    include: { items: { orderBy: { sortOrder: "asc" } }, company: true },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const [profile, tenant] = await Promise.all([
    documentOrganization(prisma, tenantId, dealId, contractId),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
  ]);
  return {
    deal,
    items: deal.items.map(serializeDealItem),
    profile,
    tenantName: tenant?.name || null,
  };
}

async function resolveLinks(
  prisma: PrismaClient,
  tenantId: string,
  dealId: string,
  input: { contractId?: string | null; invoiceId?: string | null },
) {
  let contract = null;
  if (input.contractId) {
    contract = await prisma.contract.findFirst({
      where: { id: input.contractId, tenantId, dealId },
    });
    if (!contract) throw new ApiError(404, "not_found", "Договор не найден");
  } else {
    contract = await prisma.contract.findFirst({
      where: { tenantId, dealId },
      orderBy: { createdAt: "desc" },
    });
  }

  let invoice = null;
  if (input.invoiceId) {
    invoice = await prisma.invoice.findFirst({
      where: { id: input.invoiceId, tenantId, dealId },
    });
    if (!invoice) throw new ApiError(404, "not_found", "Счёт не найден");
  }

  return { contract, invoice };
}

export async function createAvrDraft(prisma:PrismaClient, auth:AuthContext, dealId:string, input:{contractId?:string;invoiceId?:string;editor?:AvrEditorInput}={}) {
  const m=requireTenant(auth);requireManageDocuments(auth);
  return prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${m.tenantId} FOR UPDATE`;
    return createAvrDraftLocked(tx as PrismaClient,auth,dealId,input);
  });
}

function applyEditor(source: ReturnType<typeof mapAvrSource>, editor:AvrEditorInput) {
  const amounts=avrEditorAmounts(editor.items);
  return {...source,editorVersion:1,documentDate:new Date(editor.documentDate).toISOString(),items:editor.items.map((i,n)=>({...i,dealItemId:"",description:null,sortOrder:n,...amounts.rows[n]})),totals:{...amounts.totals,currency:source.totals.currency}};
}
function savedEditor(document:{sourceDataJson:unknown;documentDate:Date}):AvrEditorInput|null {
  const source=document.sourceDataJson as {editorVersion?:number;items?:unknown};
  if(source?.editorVersion!==1)return null;
  return avrEditorSchema.parse({documentDate:document.documentDate.toISOString().slice(0,10),items:source.items});
}

async function createAvrDraftLocked(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: { contractId?: string; invoiceId?: string; editor?: AvrEditorInput } = {},
) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const tid = membership.tenantId;
  await requireDocumentsEnabled(prisma, tid);

  const existing = await prisma.electronicDocument.findFirst({
    where:{tenantId:tid,dealId,type:"AVR",OR:[{externalId:{not:null}},{status:{in:["SENDING","SENT","ACCEPTED"]}}]},orderBy:{createdAt:"desc"},
  }) || await prisma.electronicDocument.findFirst({
    where: { tenantId: tid, dealId, type: "AVR", status: { in: ["DRAFT", "VALIDATED", "SIGNED"] } },orderBy:{createdAt:"desc"},
  });
  if (existing && existing.status !== "DRAFT") {
    return { document: serializeElectronicDocument(existing), reused: true };
  }
  const { contract, invoice } = await resolveLinks(prisma, tid, dealId, {...input, contractId: input.contractId || existing?.contractId, invoiceId: input.invoiceId || existing?.invoiceId});

  const { deal, items, profile, tenantName } = await loadAvrBundle(prisma, tid, dealId, contract?.id);
  if (!items.length && !input.editor && !existing) {
    throw new ApiError(422, "deal_items_required", "Сначала добавьте позиции в сделку");
  }
  let source: ReturnType<typeof mapAvrSource> & {editorVersion?:number} = mapAvrSource({
    documentDate: existing?.documentDate || new Date(),
    currency: deal.currency || "KZT",
    deal,
    items,
    profile,
    tenantName,
    company: deal.company,
    contract,
    invoice,
  });

  const editor=input.editor?avrEditorSchema.parse(input.editor):existing?savedEditor(existing):null;
  if(editor)source=applyEditor(source,editor);
  if (existing) {
    const updated = await prisma.electronicDocument.update({
      where: { id: existing.id },
      data: {
        contractId: contract?.id || existing.contractId,
        invoiceId: invoice?.id || existing.invoiceId,
        companyId: deal.companyId,
        amountWithoutVat: source.totals.amountWithoutVat,
        vatAmount: source.totals.vatAmount,
        totalAmount: source.totals.totalAmount,
        currency: source.totals.currency,
        sourceDataJson: source,
        documentDate: new Date(source.documentDate),
        errorCode: null,
        errorMessage: null,
      },
    });
    return { document: serializeElectronicDocument(updated), reused: true };
  }

  const created = await prisma.electronicDocument.create({
    data: {
      tenantId: tid,
      type: "AVR",
      dealId,
      contractId: contract?.id || null,
      invoiceId: invoice?.id || null,
      companyId: deal.companyId,
      number: await nextAvrNumber(prisma, tid),
      amountWithoutVat: source.totals.amountWithoutVat,
      vatAmount: source.totals.vatAmount,
      totalAmount: source.totals.totalAmount,
      currency: source.totals.currency,
      status: "DRAFT",
      sourceDataJson: source,
      documentDate: new Date(source.documentDate),
      createdByUserId: auth.user.id,
    },
  });
  await prisma.auditEvent.create({
    data: {
      tenantId: tid,
      actorUserId: auth.user.id,
      action: "electronic_document.create_draft",
      entityType: "electronic_document",
      entityId: created.id,
      changesJson: { dealId, type: "AVR", number: created.number },
    },
  });
  return { document: serializeElectronicDocument(created), reused: false };
}

export async function validateAvr(prisma: PrismaClient, auth: AuthContext, documentId: string) {
  const m=requireTenant(auth);requireManageDocuments(auth);
  return prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "ElectronicDocument" WHERE id = ${documentId} AND "tenantId" = ${m.tenantId} FOR UPDATE`;
    return validateAvrLocked(tx as PrismaClient,auth,documentId);
  });
}
async function validateAvrLocked(prisma: PrismaClient, auth: AuthContext, documentId: string) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const tid = membership.tenantId;
  await requireDocumentsEnabled(prisma, tid);

  const document = await prisma.electronicDocument.findFirst({
    where: { id: documentId, tenantId: tid },
  });
  if (!document) throw new ApiError(404, "not_found", "Документ не найден");
  if (document.type !== "AVR") {
    throw new ApiError(422, "not_avr", "Проверка доступна только для АВР");
  }
  if (!MUTABLE.has(document.status)) {
    throw new ApiError(422, "avr_immutable", "АВР уже подписан или отправлен — проверку менять нельзя");
  }

  const { contract, invoice } = await resolveLinks(prisma, tid, document.dealId, {
    contractId: document.contractId,
    invoiceId: document.invoiceId,
  });
  const { deal, items, profile, tenantName } = await loadAvrBundle(prisma, tid, document.dealId, contract?.id);

  const readiness = assessAvrReadiness({
    dealId: deal.id,
    contractId: contract?.id || null,
    documentId: document.id,
    signedContractId: contract?.status === "SIGNED" ? contract.id : null,
    invoiceId: invoice?.id || document.invoiceId,
    contractNumber: contract?.number || null,
    contractDate: contract?.date || null,
    itemCount: savedEditor(document)?.items.length ?? items.length,
    profile,
    company: deal.company,
  });
  if (!readiness.ready) throw avrMissingFieldsError(readiness);

  let source: ReturnType<typeof mapAvrSource> & {editorVersion?:number} = mapAvrSource({
    documentDate: document.documentDate,
    currency: deal.currency || "KZT",
    deal,
    items,
    profile,
    tenantName,
    company: deal.company,
    contract,
    invoice,
  });

  const editor=savedEditor(document);
  if(editor)source=applyEditor(source,editor);
  if(source.totals.totalAmount<=0)throw new ApiError(422,"missing_fields","Укажите положительную сумму АВР",undefined,{missingFields:["deal.amount"],missingFieldLabels:{"deal.amount":"Сумма АВР"}});
  const updated = await prisma.electronicDocument.update({
    where: { id: document.id },
    data: {
      contractId: contract?.id || null,
      invoiceId: invoice?.id || document.invoiceId,
      companyId: deal.companyId,
      amountWithoutVat: source.totals.amountWithoutVat,
      vatAmount: source.totals.vatAmount,
      totalAmount: source.totals.totalAmount,
      currency: source.totals.currency,
      status: "VALIDATED",
      sourceDataJson: source,
      validatedAt: new Date(),
      xmlStorageKey: null,
      errorCode: null,
      errorMessage: null,
    },
  });
  await prisma.auditEvent.create({
    data: {
      tenantId: tid,
      actorUserId: auth.user.id,
      action: "electronic_document.validate",
      entityType: "electronic_document",
      entityId: updated.id,
      changesJson: { type: "AVR", number: updated.number },
    },
  });
  return {
    document: serializeElectronicDocument(updated),
    ready: true,
    warnings: readiness.warnings,
    missingFields: [] as string[],
  };
}

export async function updateAvrDraft(prisma:PrismaClient,auth:AuthContext,id:string,raw:unknown) {
  const m=requireTenant(auth);requireManageDocuments(auth);await requireDocumentsEnabled(prisma,m.tenantId);
  const editor=avrEditorSchema.parse(raw);
  const expected=(raw as {updatedAt?:string}).updatedAt;
  return prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "ElectronicDocument" WHERE id = ${id} AND "tenantId" = ${m.tenantId} FOR UPDATE`;
    const doc=await tx.electronicDocument.findFirst({where:{id,tenantId:m.tenantId,type:"AVR"}});
    if(!doc)throw new ApiError(404,"not_found","АВР не найден");
    if(!MUTABLE.has(doc.status)||doc.externalId)throw new ApiError(409,"avr_immutable","Отправленный или подписываемый АВР нельзя редактировать");
    if(expected&&doc.updatedAt.toISOString()!==expected)throw new ApiError(409,"document_changed","Документ изменён. Откройте его заново.");
    const source=applyEditor(doc.sourceDataJson as ReturnType<typeof mapAvrSource>,editor);
    const updated=await tx.electronicDocument.update({where:{id},data:{documentDate:new Date(editor.documentDate),sourceDataJson:source,...source.totals,status:"DRAFT",validatedAt:null,xmlStorageKey:null,errorCode:null,errorMessage:null}});
    await tx.auditEvent.create({data:{tenantId:m.tenantId,actorUserId:auth.user.id,action:"electronic_document.edit_draft",entityType:"electronic_document",entityId:id,changesJson:{dealId:doc.dealId,itemCount:editor.items.length}}});
    return {document:serializeElectronicDocument(updated)};
  });
}
