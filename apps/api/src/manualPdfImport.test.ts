import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import PDFDocument from "pdfkit";
import { createCanvas } from "@napi-rs/canvas";
import { createPrismaClient } from "@creolab/db";
import type { PdfImportDraft } from "@creolab/contracts";
import { createApp } from "./app.ts";
import { parsePdfDocument } from "./services/pdfDocumentParser.ts";
import { extractPdfPages } from "./services/pdfTextExtraction.ts";

async function makePdf(scan=false) {
  const pdf = new PDFDocument({ size:"A4" });const chunks:Buffer[]=[];
  const done = new Promise<Buffer>((resolve,reject)=>{pdf.on("data",c=>chunks.push(c));pdf.on("end",()=>resolve(Buffer.concat(chunks)));pdf.on("error",reject);});
  if (scan) {
    const canvas=createCanvas(1400,900);const c=canvas.getContext("2d");c.fillStyle="white";c.fillRect(0,0,1400,900);c.fillStyle="black";c.font="42px Arial";c.fillText("Contract No 2026-TEST-42",70,150);c.fillText("Total: 400000 KZT",70,260);pdf.image(canvas.toBuffer("image/png"),40,40,{width:510});
  } else pdf.fontSize(16).text("Contract PDF ORIGINAL 2026-42").text("Total: 400000 KZT");
  pdf.end();return done;
}
const party={name:"ТОО Тестовый заказчик",bin:"222222222220",legalAddress:"Тестовый адрес",iban:"KZ738560000006625816",bankName:"Тестовый банк",bik:"KCJBKZKX",directorName:"Тестов Т. Т."};
function draft(kind:"CONTRACT"|"INVOICE"="CONTRACT"):PdfImportDraft{return {kind,number:kind==="CONTRACT"?"MANUAL-42":"BILL-42",date:"2026-08-12",subject:"Презентация и дизайн",buyer:party,seller:{...party,name:"Исполнитель",bin:"123456789013"},contactName:"Тестов Т. Т.",contactPhone:"+77019998855",paymentTerms:"Предоплата 50%",completionTerms:"5 рабочих дней",detectedTotal:400000,items:[{name:"Презентация",quantity:1,unitPrice:200000,vatRate:0,unit:"услуга"},{name:"Дизайн",quantity:2,unitPrice:100000,vatRate:0,unit:"услуга"}]};}

describe("Manual PDF import",()=>{
 let prisma:Awaited<ReturnType<typeof createPrismaClient>>;let server:Server;let base="";let cookie="";let foreign="";let bytes:Buffer;let importId="";let dealId="";let contractId="";
 async function req(path:string,method="GET",body?:unknown,status=200,session=cookie){const r=await fetch(base+path,{method,headers:{"content-type":"application/json",cookie:session},body:body?JSON.stringify(body):undefined});const b=await r.json();assert.equal(r.status,status,JSON.stringify(b));return b;}
 async function preview(kind="CONTRACT"){return req("/api/v1/documents/import-pdf/preview","POST",{kind,fileName:"original.pdf",fileBase64:bytes.toString("base64")});}
 before(async()=>{
  process.env.ESF_PROVIDER="mock";process.env.ESF_ENV="off";process.env.ESF_ALLOW_LIVE_SEND="0";
  prisma=await createPrismaClient();await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
  server=createApp(prisma).listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  for(const email of ["owner@creolab.example","owner@demo-agency.example"]){const r=await fetch(base+"/api/v1/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password:process.env.SEED_PASSWORD,client:"web"})});assert.equal(r.status,200);const c=r.headers.get("set-cookie")!.split(";")[0];if(!cookie)cookie=c;else foreign=c;}
  bytes=await makePdf();
 });
 after(async()=>{await new Promise<void>(r=>server?.close(()=>r()));await prisma?.$disconnect();});
 it("rejects non-PDF uploads",async()=>{await req("/api/v1/documents/import-pdf/preview","POST",{kind:"CONTRACT",fileName:"fake.pdf",fileBase64:Buffer.from("not a PDF").toString("base64")},422);});
 it("recognizes a scanned PDF locally",async()=>{const pages=await extractPdfPages(await makePdf(true));assert.equal(pages[0].ocr,true);assert.match(pages[0].text,/2026.TEST.42/);assert.match(pages[0].text,/400000/);});
 it("allows only one recognition and accepts new uploads after it finishes or fails",async()=>{
  const scan=await makePdf(true);
  const body=JSON.stringify({kind:"CONTRACT",fileName:"scan.pdf",fileBase64:scan.toString("base64")});
  const replies=await Promise.all([1,2].map(()=>fetch(base+"/api/v1/documents/import-pdf/preview",{method:"POST",headers:{"content-type":"application/json",cookie},body})));
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,429]);
  for(const r of replies){const data=await r.json();if(r.status===429)assert.equal(data.code,"pdf_import_busy");else await req(`/api/v1/documents/import-pdf/${data.importId}`,"DELETE");}
  await req("/api/v1/documents/import-pdf/preview","POST",{kind:"CONTRACT",fileName:"broken.pdf",fileBase64:Buffer.from("%PDF-1.7\ninvalid contents").toString("base64")},422);
  const next=await preview();await req(`/api/v1/documents/import-pdf/${next.importId}`,"DELETE");
 });
 it("previews original PDF without creating a deal",async()=>{const before=await prisma.deal.count();const p=await preview();importId=p.importId;assert.equal(p.usedOcr,false);assert.equal(p.sha256,createHash("sha256").update(bytes).digest("hex"));assert.equal(await prisma.deal.count(),before);});
 it("requires a valid date, contact phone and consistent totals",async()=>{
  for(const changes of [{date:"2026-02-31"},{contactPhone:""},{detectedTotal:500000}])await req("/api/v1/documents/import-pdf/confirm","POST",{importId,draft:{...draft(),...changes}},422);
  assert.equal((await prisma.attachment.findUnique({where:{id:importId}}))?.status,"preview");
 });
 it("isolates preview and confirmation from another tenant",async()=>{await req("/api/v1/documents/import-pdf/confirm","POST",{importId,draft:draft()},404,foreign);await req(`/api/v1/documents/import-pdf/${importId}`,"DELETE",undefined,200,foreign);assert.ok(await prisma.attachment.findUnique({where:{id:importId}}));});
 it("atomically creates linked deal, company, contact and immutable original contract",async()=>{
  const result=await req("/api/v1/documents/import-pdf/confirm","POST",{importId,draft:draft()});dealId=result.dealId;contractId=result.documentId;
  const deal=await prisma.deal.findUniqueOrThrow({where:{id:dealId},include:{company:true,contact:{include:{methods:true}},items:true}});
  assert.equal(deal.company?.bin,party.bin);assert.equal(deal.company?.iban,party.iban);assert.equal(deal.contact.methods[0].normalizedValue,"77019998855");assert.equal(deal.items.length,2);assert.equal(Number(deal.offerAmountMinor),400000);
  const contract=await prisma.contract.findUniqueOrThrow({where:{id:contractId}});assert.equal(contract.number,"MANUAL-42");assert.equal(contract.date.toISOString().slice(0,10),"2026-08-12");assert.equal(contract.originalFileId,importId);assert.equal(contract.signedAt,null);
  const r=await fetch(base+`/api/v1/contracts/${contractId}/pdf`,{headers:{cookie}});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
  assert.equal((await req(`/api/v1/contracts/${contractId}/generate`,"POST",{},422)).code,"imported_pdf_immutable");
 });
 it("fills missing seller details and restores them for an older imported contract",async()=>{
  const contract=await prisma.contract.findUniqueOrThrow({where:{id:contractId}});
  await prisma.tenantLegalProfile.update({where:{tenantId:contract.tenantId},data:{legalName:null,bin:null,legalAddress:null,directorName:null,iban:null,bik:null}});
  await req(`/api/v1/contracts/${contractId}/imported-requisites`,"POST",undefined,404,foreign);
  const restored=await req(`/api/v1/contracts/${contractId}/imported-requisites`,"POST");
  assert.ok(restored.fields.includes("legalName"));
  const profile=await prisma.tenantLegalProfile.findUniqueOrThrow({where:{tenantId:contract.tenantId}});
  assert.equal(profile.legalName,draft().seller.name);assert.equal(profile.bin,draft().seller.bin);assert.equal(profile.iban,draft().seller.iban);
  const readiness=await (await import("./services/contractReadiness.ts")).getContractReadiness(prisma,{activeMembership:{tenantId:contract.tenantId}} as any,dealId);
  assert.equal(readiness.ready,true);
  await prisma.tenantLegalProfile.update({where:{tenantId:contract.tenantId},data:{legalAddress:"Verified existing address"}});
  await req(`/api/v1/contracts/${contractId}/imported-requisites`,"POST");
  assert.equal((await prisma.tenantLegalProfile.findUniqueOrThrow({where:{tenantId:contract.tenantId}})).legalAddress,"Verified existing address");
  await prisma.tenantLegalProfile.update({where:{tenantId:contract.tenantId},data:{bin:"999999999999",directorName:null}});
  await req(`/api/v1/contracts/${contractId}/imported-requisites`,"POST",undefined,422);
  assert.equal((await prisma.tenantLegalProfile.findUniqueOrThrow({where:{tenantId:contract.tenantId}})).directorName,null);
  await prisma.tenantLegalProfile.update({where:{tenantId:contract.tenantId},data:{bin:draft().seller.bin}});
 });
 it("uses reviewed imported details across documents even when organization settings are empty",async()=>{
  const contract=await prisma.contract.findUniqueOrThrow({where:{id:contractId}});
  const savedProfile=await prisma.tenantLegalProfile.findUniqueOrThrow({where:{tenantId:contract.tenantId}});
  const fields={legalName:savedProfile.legalName,bin:savedProfile.bin,iin:savedProfile.iin,legalAddress:savedProfile.legalAddress,directorName:savedProfile.directorName,iban:savedProfile.iban,bik:savedProfile.bik,bankName:savedProfile.bankName};
  const {documentOrganization}=await import("./services/documentOrganization.ts");
  let invoiceId:string|undefined;
  try {
    await prisma.tenantLegalProfile.update({where:{tenantId:contract.tenantId},data:Object.fromEntries(Object.keys(fields).map(k=>[k,null]))});
    for(const route of ["contract-readiness","invoice-readiness","avr-readiness","esf-invoice-readiness"]){
      const r=await req(`/api/v1/deals/${dealId}/${route}`);
      assert.ok(!r.missingFields.some((f:string)=>f.startsWith("organization.")),JSON.stringify(r));
      if(route!=="contract-readiness")assert.ok(r.missingFields.includes("contract.signed"));
    }
    assert.equal((await prisma.tenantLegalProfile.findUniqueOrThrow({where:{tenantId:contract.tenantId}})).legalName,null,"readiness must not mutate organization settings");
    const dealView=await req(`/api/v1/deals/${dealId}`);assert.equal(dealView.deal.contact.phone,"+77019998855");
    for(const type of ["AVR","ESF"]){
      const r=await req(`/api/v1/deals/${dealId}/electronic-documents`,"POST",{type,contractId},201);
      const row=await prisma.electronicDocument.findUniqueOrThrow({where:{id:r.document.id}});
      const source=row.sourceDataJson as any;
      assert.equal(source.seller.bin,draft().seller.bin);assert.equal(source.seller.legalName,draft().seller.name);
      assert.equal(source.buyer.bin,party.bin);assert.equal(row.contractId,contractId);assert.equal(Number(row.totalAmount),400000);
    }
    // Signature is supplied by the test fixture only; importing never signs a contract.
    await prisma.contract.update({where:{id:contractId},data:{status:"SIGNED",signedAt:new Date()}});
    const invoice=await req(`/api/v1/deals/${dealId}/invoices`,"POST",{contractId},201);invoiceId=invoice.invoice.id;
    await req(`/api/v1/invoices/${invoiceId}/generate`,"POST",{});
    const generated=await prisma.invoice.findUniqueOrThrow({where:{id:invoiceId}});assert.ok(generated.pdfFileId);assert.equal(generated.contractId,contractId);
    await prisma.tenantLegalProfile.update({where:{tenantId:contract.tenantId},data:{legalAddress:"Verified address"}});
    assert.equal((await documentOrganization(prisma,contract.tenantId,dealId))?.legalAddress,"Verified address");
    await prisma.tenantLegalProfile.update({where:{tenantId:contract.tenantId},data:{bin:"999999999999"}});
    assert.equal((await documentOrganization(prisma,contract.tenantId,dealId))?.legalName,null,"a different seller must not supply missing fields");
    await prisma.tenantLegalProfile.update({where:{tenantId:contract.tenantId},data:{bin:null}});
    assert.equal((await documentOrganization(prisma,contract.tenantId,"00000000-0000-4000-8000-000000000001",contractId))?.legalName,null,"contract must belong to the requested deal");
    const foreignTenant=await prisma.tenant.findFirstOrThrow({where:{id:{not:contract.tenantId}}});
    const foreignProfile=await prisma.tenantLegalProfile.findUnique({where:{tenantId:foreignTenant.id}});
    assert.deepEqual(await documentOrganization(prisma,foreignTenant.id,dealId,contractId),foreignProfile);
  } finally {
    await prisma.tenantLegalProfile.update({where:{tenantId:contract.tenantId},data:fields});
    await prisma.contract.update({where:{id:contractId},data:{status:contract.status,signedAt:contract.signedAt}});
    if(invoiceId)await prisma.invoice.update({where:{id:invoiceId},data:{status:"CANCELLED"}});
  }
 });
 it("imports Word, extracts both parties and preserves the source alongside its PDF",async()=>{
  const word=await readFile(new URL("./fixtures/manual-word-contract.docx",import.meta.url));
  const p=await req("/api/v1/documents/import-pdf/preview","POST",{kind:"CONTRACT",fileName:"contract.docx",fileBase64:word.toString("base64")});
  assert.equal(p.draft.number,"WORD-2026/01");assert.equal(p.draft.date,"2026-08-12");
  assert.equal(p.draft.buyer.bin,party.bin);assert.equal(p.draft.seller.bin,draft().seller.bin);
  assert.equal(p.draft.items.length,1);assert.equal(p.draft.detectedTotal,100000);
  const result=await req("/api/v1/documents/import-pdf/confirm","POST",{importId:p.importId,draft:p.draft});
  const contract=await prisma.contract.findUniqueOrThrow({where:{id:result.documentId}});
  assert.notEqual(contract.originalFileId,contract.generatedFileId);
  const version=await prisma.contractVersion.findFirstOrThrow({where:{contractId:contract.id}});
  const pdf=await fetch(base+`/api/v1/contracts/${contract.id}/pdf`,{headers:{cookie}});
  const pdfBytes=Buffer.from(await pdf.arrayBuffer());assert.equal(pdf.status,200);assert.equal(pdfBytes.subarray(0,5).toString(),"%PDF-");assert.equal(version.sha256,createHash("sha256").update(pdfBytes).digest("hex"));
  const original=await fetch(base+`/api/v1/contracts/${contract.id}/original`,{headers:{cookie}});assert.deepEqual(Buffer.from(await original.arrayBuffer()),word);
  const hidden=await fetch(base+`/api/v1/contracts/${contract.id}/original`,{headers:{cookie:foreign}});assert.equal(hidden.status,404);
  assert.equal((await req("/api/v1/documents/import-pdf/confirm","POST",{importId:p.importId,draft:p.draft})).reused,true);
  // Reproduce an older Word import whose seller cell was missed by the parser.
  const savedProfile = await prisma.tenantLegalProfile.findUniqueOrThrow({where:{tenantId:contract.tenantId}});
  const savedAudit = await prisma.auditEvent.findFirstOrThrow({where:{tenantId:contract.tenantId,entityId:contract.id,action:"document.import_pdf"}});
  await prisma.auditEvent.update({where:{id:savedAudit.id},data:{changesJson:{...(savedAudit.changesJson as object),reviewedImport:{...p.draft,seller:Object.fromEntries(Object.keys(p.draft.seller).map(k=>[k,""]))}}}});
  await prisma.tenantLegalProfile.update({where:{tenantId:contract.tenantId},data:{legalName:null,bin:null,iin:null,legalAddress:null,directorName:null,iban:null,bik:null,bankName:null}});
  try {
    const before = await prisma.deal.count();
    const restored = await req(`/api/v1/contracts/${contract.id}/imported-requisites`,"POST");
    assert.ok(restored.fields.includes("legalName"));
    const settings = await req("/api/v1/settings/legal-profile");
    assert.equal(settings.legalName,p.draft.seller.name);
    assert.equal(settings.bin,p.draft.seller.bin);
    assert.equal(settings.iban,p.draft.seller.iban);
    assert.equal(await prisma.deal.count(),before,"restore must not create another deal");
  } finally {
    const keys=["legalName","bin","iin","legalAddress","directorName","iban","bik","bankName"] as const;
    await prisma.tenantLegalProfile.update({where:{tenantId:contract.tenantId},data:Object.fromEntries(keys.map(k=>[k,savedProfile[k]]))});
  }
  const cancel=await req("/api/v1/documents/import-pdf/preview","POST",{kind:"CONTRACT",fileName:"cancel.docx",fileBase64:word.toString("base64")});
  await req(`/api/v1/documents/import-pdf/${cancel.importId}`,"DELETE");
  assert.equal(await prisma.attachment.count({where:{OR:[{id:cancel.importId},{parentId:cancel.importId}]}}),0);
 });
 it("accepts legacy DOC and rejects a renamed non-Word file",async()=>{
  const word=await readFile(new URL("./fixtures/manual-word-contract.doc",import.meta.url));
  const p=await req("/api/v1/documents/import-pdf/preview","POST",{kind:"CONTRACT",fileName:"legacy.doc",fileBase64:word.toString("base64")});
  assert.equal(p.draft.number,"WORD-2026/01");assert.equal(p.draft.seller.bin,draft().seller.bin);
  await req(`/api/v1/documents/import-pdf/${p.importId}`,"DELETE");
  await req("/api/v1/documents/import-pdf/preview","POST",{kind:"CONTRACT",fileName:"fake.docx",fileBase64:bytes.toString("base64")},422);
 });
 it("reuses a confirmed import and rejects re-uploaded duplicates",async()=>{const results=await Promise.all([1,2].map(()=>req("/api/v1/documents/import-pdf/confirm","POST",{importId,draft:draft()})));assert.ok(results.every(r=>r.reused&&r.dealId===dealId));const p=await preview();await req("/api/v1/documents/import-pdf/confirm","POST",{importId:p.importId,draft:{...draft(),number:"ANOTHER"}},409);await req(`/api/v1/documents/import-pdf/${p.importId}`,"DELETE");});
 it("adds manual invoice to the existing deal and preserves the PDF",async()=>{
  const p=await preview("INVOICE");const data={...draft("INVOICE"),paymentKind:"PREPAYMENT" as const,contractNumber:draft().number};await req("/api/v1/documents/import-pdf/confirm","POST",{importId:p.importId,draft:data},422);
  const saved=await req("/api/v1/documents/import-pdf/confirm","POST",{importId:p.importId,dealId,draft:data});
  const invoice=await prisma.invoice.findUniqueOrThrow({where:{id:saved.documentId}});assert.equal(invoice.dealId,dealId);assert.equal(invoice.contractId,contractId);assert.equal(invoice.status,"ISSUED");
  const r=await fetch(base+`/api/v1/invoices/${invoice.id}/pdf`,{headers:{cookie}});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
  await req(`/api/v1/invoices/${invoice.id}/generate`,"POST",{},422);
  const docs=await req(`/api/v1/deals/${dealId}/documents`);assert.equal(docs.contracts[0].importedPdf,true);assert.equal(docs.invoices[0].importedPdf,true);
  assert.deepEqual(docs.invoices[0].importDetails,{subject:data.subject,paymentTerms:"Предоплата 50%",paymentKind:"PREPAYMENT",contractNumber:data.contractNumber});
  assert.equal((await req(`/api/v1/invoices/${invoice.id}`)).invoice.importDetails.paymentKind,"PREPAYMENT");
  const hidden=await fetch(base+`/api/v1/invoices/${invoice.id}/pdf`,{headers:{cookie:foreign}});assert.equal(hidden.status,404);
 });
 it("matches invoice company by tax ID and contract, without guessing between deals or tenants",async()=>{
  const deal=await prisma.deal.findUniqueOrThrow({where:{id:dealId}});
  const url=`/api/v1/documents/import-pdf/matches?buyerBin=${party.bin}`;
  const existing=await req(url);assert.equal(existing.companies[0].id,deal.companyId);assert.ok(existing.deals.length>1);assert.equal(existing.suggestedDealId,null);
  const second=await prisma.deal.create({data:{tenantId:deal.tenantId,contactId:deal.contactId,stageId:deal.stageId,companyId:deal.companyId,title:"Вторая сделка"}});
  try {
    assert.equal((await req(url)).suggestedDealId,null);
    assert.equal((await req(`${url}&contractNumber=${encodeURIComponent(draft().number)}`)).suggestedDealId,dealId);
    assert.equal((await req(`${url}&contractNumber=UNKNOWN`)).suggestedDealId,null);
    assert.deepEqual((await req(url,"GET",undefined,200,foreign)).companies,[]);
    const duplicate=await prisma.company.create({data:{tenantId:deal.tenantId,name:"Дубликат заказчика",bin:party.bin}});
    try {assert.equal((await req(`${url}&contractNumber=${encodeURIComponent(draft().number)}`)).suggestedDealId,null);} finally {await prisma.company.delete({where:{id:duplicate.id}});}
    const company=await prisma.company.findUniqueOrThrow({where:{id:deal.companyId!}});
    await prisma.company.update({where:{id:company.id},data:{bin:null,iin:party.bin}});
    try {assert.equal((await req(url)).companies[0].id,company.id);} finally {await prisma.company.update({where:{id:company.id},data:{bin:company.bin,iin:company.iin}});}
  } finally {await prisma.deal.delete({where:{id:second.id}});}
 });
 it("links an unassigned deal and invoice to the buyer company, rejects a different buyer",async()=>{
  const originalBytes=bytes;bytes=Buffer.concat([bytes,Buffer.from("\n% invoice-company-link\n")]);
  const source=await prisma.deal.findUniqueOrThrow({where:{id:dealId}});
  const unassigned=await prisma.deal.create({data:{tenantId:source.tenantId,contactId:source.contactId,stageId:source.stageId,title:"Счёт без привязанной компании"}});
  try {
    const p=await preview("INVOICE");const data={...draft("INVOICE"),number:"BILL-LINK",paymentKind:"BALANCE" as const,paymentTerms:"Остаток 50%"};
    const mismatch=await req("/api/v1/documents/import-pdf/confirm","POST",{importId:p.importId,dealId,draft:{...data,buyer:{...party,bin:"999999999990"}}},422);
    assert.equal(mismatch.code,"pdf_buyer_mismatch");
    const duplicate=await prisma.company.create({data:{tenantId:source.tenantId,name:"Дубликат заказчика",bin:party.bin}});
    try {
      assert.equal((await req("/api/v1/documents/import-pdf/confirm","POST",{importId:p.importId,dealId:unassigned.id,draft:data},422)).code,"pdf_company_ambiguous");
      assert.equal((await prisma.deal.findUniqueOrThrow({where:{id:unassigned.id}})).companyId,null);
    } finally {await prisma.company.delete({where:{id:duplicate.id}});}
    const result=await req("/api/v1/documents/import-pdf/confirm","POST",{importId:p.importId,dealId:unassigned.id,draft:data});
    const invoice=await prisma.invoice.findUniqueOrThrow({where:{id:result.documentId}});
    assert.equal(invoice.companyId,source.companyId);assert.equal(invoice.contractId,null);assert.equal(invoice.status,"ISSUED");
    assert.equal((await prisma.deal.findUniqueOrThrow({where:{id:unassigned.id}})).companyId,source.companyId);
    assert.equal((await req(`/api/v1/invoices/${invoice.id}`)).invoice.importDetails.paymentTerms,"Остаток 50%");
    await req(`/api/v1/invoices/${invoice.id}`,"GET",undefined,404,foreign);
  } finally {bytes=originalBytes;}
 });
 it("creates a missing customer and links it to the invoice and deal",async()=>{
  const originalBytes=bytes;bytes=Buffer.concat([bytes,Buffer.from("\n% new-invoice-customer\n")]);
  const source=await prisma.deal.findUniqueOrThrow({where:{id:dealId}});
  const deal=await prisma.deal.create({data:{tenantId:source.tenantId,contactId:source.contactId,stageId:source.stageId,title:"Новый заказчик"}});
  try {
    const p=await preview("INVOICE");const buyer={...party,bin:"555555555550",name:"Новый заказчик"};
    assert.deepEqual((await req(`/api/v1/documents/import-pdf/matches?buyerBin=${buyer.bin}`)).companies,[]);
    const result=await req("/api/v1/documents/import-pdf/confirm","POST",{importId:p.importId,dealId:deal.id,draft:{...draft("INVOICE"),number:"BILL-NEW-CUSTOMER",buyer}});
    const invoice=await prisma.invoice.findUniqueOrThrow({where:{id:result.documentId}});
    const company=await prisma.company.findUniqueOrThrow({where:{id:invoice.companyId!}});
    assert.equal(company.bin,buyer.bin);assert.equal(company.legalAddress,buyer.legalAddress);
    assert.equal((await prisma.deal.findUniqueOrThrow({where:{id:deal.id}})).companyId,company.id);
    assert.equal((await req(`/api/v1/documents/import-pdf/matches?buyerBin=${buyer.bin}`)).suggestedDealId,deal.id);
  } finally {bytes=originalBytes;}
 });
 it("serializes simultaneous uploads and preserves existing company details",async()=>{
  const originalBytes=bytes;bytes=Buffer.concat([bytes,Buffer.from("\n% concurrency-check\n")]);
  try {
    const company=await prisma.company.findFirstOrThrow({where:{bin:party.bin}});
    await prisma.company.update({where:{id:company.id},data:{legalAddress:"Адрес, уточнённый менеджером"}});
    const count=await prisma.deal.count();const a=await preview(),b=await preview();
    const replies=await Promise.all([a,b].map((p,i)=>fetch(base+"/api/v1/documents/import-pdf/confirm",{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify({importId:p.importId,draft:{...draft(),number:`RACE-${i}`}})})));
    assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);assert.equal(await prisma.deal.count(),count+1);
    assert.equal((await prisma.company.findUniqueOrThrow({where:{id:company.id}})).legalAddress,"Адрес, уточнённый менеджером");
    for(const p of [a,b])await req(`/api/v1/documents/import-pdf/${p.importId}`,"DELETE");
  } finally {bytes=originalBytes;}
 });
 it("rolls back the entire deal when a document number already exists",async()=>{
  const originalBytes=bytes;bytes=Buffer.concat([bytes,Buffer.from("\n% unique-number-check\n")]);
  try {
    const p=await preview();const count=await prisma.deal.count();await req("/api/v1/documents/import-pdf/confirm","POST",{importId:p.importId,draft:draft()},409);
    assert.equal(await prisma.deal.count(),count);assert.equal((await prisma.attachment.findUniqueOrThrow({where:{id:p.importId}})).status,"preview");
    await req(`/api/v1/documents/import-pdf/${p.importId}`,"DELETE");
  } finally {bytes=originalBytes;}
 });
 it("reads invoice quantity, unit and price from separate columns",()=>{
  const text="Счёт на оплату № 42 от 12.08.2026\nБез НДС\n№   Наименование товара   Кол-во   Ед.   Цена   Сумма\n1   Бумага A4   2   шт   1 500,00   3 000,00\n2   Печать   100   шт   10,00   1 000,00\nИтого: 4 000,00";
  const parsed=parsePdfDocument([{page:1,text,words:[],width:600,height:800,ocr:false}],"INVOICE");
  assert.equal(parsed.draft.number,"42");assert.equal(parsed.draft.detectedTotal,4000);assert.deepEqual(parsed.draft.items.map(i=>[i.name,i.quantity,i.unitPrice]),[["Бумага A4",2,1500],["Печать",100,10]]);
 });
 it("extracts final work specification instead of unit-price appendix",()=>{
  const texts=["Договор № 12082026/01\n«12» августа 2026 года\nКонтактное лицо от Заказчика: +7 778 159 8899\nИсполнитель не является плательщиком НДС.","Прайс лист\nРазработка презентации 20 000", "Задание\n1 Разработка презентации 4-5 рабочих дня 200 000\n2 Разработка логотипа 3-4 рабочих дня 100 000\n3 Верстка версий 3-4 рабочих дня 100 000\nИтого: 400 000"];
  const p=parsePdfDocument(texts.map((text,i)=>({page:i+1,text,words:[],width:600,height:800,ocr:false})),"CONTRACT");assert.equal(p.draft.number,"12082026/01");assert.equal(p.draft.date,"2026-08-12");assert.equal(p.draft.items.length,3);assert.deepEqual(p.draft.items.map(i=>i.unitPrice),[200000,100000,100000]);
 });
});
