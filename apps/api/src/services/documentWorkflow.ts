import type { PrismaClient, Prisma } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";
import { documentOrganization } from "./documentOrganization.ts";
import { assessAvrReadiness } from "./avrReadiness.ts";
import { serializeDealItem } from "./dealItemService.ts";
import { avrEditorAmounts } from "@creolab/contracts";

export function documentWorkflowState(docs: Array<{type:string;status:string;externalStatus?:string|null;externalId?:string|null;errorCode?:string|null}>) {
  const sent=(d:typeof docs[number]|undefined)=>Boolean(d&&(d.externalId||["SENT","ACCEPTED"].includes(d.status)));
  const pick=(type:string)=>docs.find(d=>d.type===type&&sent(d))||docs.find(d=>d.type===type);
  const avr=pick("AVR"),esf=pick("ESF");
  const accepted=(d:typeof avr)=>Boolean(d&&(d.status==="ACCEPTED"||["CONFIRMED","DELIVERED"].includes(d.externalStatus||"")));
  const error=[avr,esf].some(d=>d&&(d.errorCode||["ERROR","FAILED"].includes(d.status)||["FAILED","DECLINED","REVOKED"].includes(d.externalStatus||"")));
  const closed=accepted(avr)&&accepted(esf)&&!error;
  const code=error?"ERROR":closed?"CLOSED":sent(esf)?"ESF_SENT":accepted(avr)?"AVR_ACCEPTED":sent(avr)?"AVR_SENT":avr?.status==="SENDING"?"AVR_SENDING":avr?.status==="VALIDATED"?"AVR_READY":avr?"AVR_DRAFT":"AVR_MISSING";
  const labels:Record<string,string>={ERROR:"Ошибка документов",CLOSED:"Документы закрыты",ESF_SENT:"ЭСФ отправлен",AVR_ACCEPTED:"АВР принят · требуется ЭСФ",AVR_SENT:"АВР отправлен · требуется ЭСФ",AVR_SENDING:"АВР отправляется",AVR_READY:"АВР готов к подписи",AVR_DRAFT:"АВР черновик",AVR_MISSING:"АВР не создан"};
  return {code,label:labels[code],closed,finalAvr:sent(avr),needsEsf:sent(avr)&&!sent(esf),error};
}
export async function workflowAccess(prisma: PrismaClient,auth:AuthContext) {
  if(!auth.activeMembership)throw new ApiError(403,"no_tenant","Нет активной организации");
  if(!can(auth,"manage_documents"))throw new ApiError(403,"forbidden","Недостаточно прав для документов");
  await requireDocumentsEnabled(prisma,auth.activeMembership.tenantId);
  return auth.activeMembership;
}
export async function listAvrEligibleDeals(prisma:PrismaClient,auth:AuthContext,query:Record<string,unknown>={}) {
  const membership=await workflowAccess(prisma,auth),tid=membership.tenantId;
  const deals=await prisma.deal.findMany({where:{tenantId:tid,outcome:{not:"lost"},...(query.scope==="mine"?{assigneeMembershipId:membership.id}:query.scope==="unassigned"?{assigneeMembershipId:null}:{})},include:{company:true,contact:true,stage:true,assignee:{include:{user:{select:{name:true}}}},items:true,payments:{where:{status:"confirmed"},orderBy:{confirmedAt:"desc"},take:1},electronicDocuments:{orderBy:{createdAt:"desc"},select:{id:true,type:true,status:true,errorCode:true,externalId:true,externalStatus:true}}},orderBy:{createdAt:"desc"}});
  const profile=await prisma.tenantLegalProfile.findUnique({where:{tenantId:tid}});
  const items=deals.map(deal=>{
    const state=documentWorkflowState(deal.electronicDocuments);
    const base=assessAvrReadiness({dealId:deal.id,profile,company:deal.company,itemCount:deal.items.length|| (deal.title&&Number(deal.offerAmountMinor)>0?1:0)});
    const reasons=base.missingFields.map(f=>base.missingFieldLabels[f]);
    const amount=deal.items.length?avrEditorAmounts(deal.items.map(serializeDealItem)).totals.totalAmount:Number(deal.offerAmountMinor||0);
    if(amount<=0)reasons.push("Не указана сумма сделки");
    const stageReady=deal.paymentStatus==="PAID"||deal.fulfillmentStatus==="COMPLETED"||deal.outcome==="won"||deal.stage.isTerminal;
    if(!stageReady)reasons.push("Сделка ещё не оплачена или не завершена");
    if(state.finalAvr)reasons.push("АВР уже отправлен");
    return {id:deal.id,number:deal.id.slice(0,8).toUpperCase(),title:deal.title,companyId:deal.companyId,companyName:deal.company?.name||null,contactName:deal.contact.name,amount,currency:deal.currency,stage:deal.stage.name,paymentStatus:deal.paymentStatus,paidAt:deal.payments[0]?.confirmedAt.toISOString()||null,responsible:deal.assignee?.user.name||null,ready:!reasons.length,reasons,documentState:state,documentId:deal.electronicDocuments.find(d=>d.type==="AVR")?.id||null};
  }).filter(d=>!d.documentState.closed && (!query.q||`${d.title} ${d.companyName} ${d.number}`.toLowerCase().includes(String(query.q).toLowerCase()))).sort((a,b)=>Number(b.ready)-Number(a.ready));
  return {items:query.filter==="ready"?items.filter(d=>d.ready):items,total:items.length};
}
export async function getAvrEditorContext(prisma:PrismaClient,auth:AuthContext,dealId:string) {
  const m=await workflowAccess(prisma,auth);
  const deal=await prisma.deal.findFirst({where:{id:dealId,tenantId:m.tenantId},include:{company:true,contact:true,assignee:{include:{user:{select:{name:true}}}},items:{orderBy:{sortOrder:"asc"}},contracts:{orderBy:{createdAt:"desc"},take:1},electronicDocuments:{orderBy:{createdAt:"desc"},select:{id:true,type:true,status:true,errorCode:true,externalId:true,externalStatus:true}}}});
  if(!deal)throw new ApiError(404,"not_found","Сделка не найдена");
  const profile=await documentOrganization(prisma,m.tenantId,deal.id,deal.contracts[0]?.id);
  const legal=await (await import("./legalProfileService.ts")).getLegalProfile(prisma,auth);
  const items=deal.items.map(serializeDealItem);
  const fallback=!items.length&&Number(deal.offerAmountMinor)>0?[{name:deal.title,quantity:1,unit:"услуга",unitPrice:Number(deal.offerAmountMinor),vatRate:0}]:[];
  return {deal:{id:deal.id,title:deal.title,number:deal.id.slice(0,8).toUpperCase(),contactId:deal.contactId,contactName:deal.contact.name,companyId:deal.companyId,responsible:deal.assignee?.user.name||null},company:deal.company,organization:{...profile,directorBasis:legal.directorBasis},contract:deal.contracts[0]||null,items:items.length?items:fallback,documentState:documentWorkflowState(deal.electronicDocuments),existingDocumentId:deal.electronicDocuments.find(d=>d.type==="AVR")?.id||null};
}

export async function countDocumentClosing(prisma:PrismaClient,tenantId:string,scope:Prisma.DealWhereInput={}) {
  if(!await (await import("./legalProfileService.ts")).isDocumentsEnabled(prisma,tenantId))return 0;
  const deals=await prisma.deal.findMany({where:{...scope,tenantId,outcome:{not:"lost"}},select:{paymentStatus:true,electronicDocuments:{orderBy:{createdAt:"desc"},select:{type:true,status:true,externalId:true,externalStatus:true,errorCode:true}}}});
  return deals.filter(d=>{const state=documentWorkflowState(d.electronicDocuments);return !state.closed&&(state.error||(d.paymentStatus==="PAID"&&!d.electronicDocuments.some(r=>r.type==="AVR"))||(d.electronicDocuments.some(r=>r.type==="AVR")&&!d.electronicDocuments.some(r=>r.type==="ESF")));}).length;
}
