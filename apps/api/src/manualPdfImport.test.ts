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
 it("reuses a confirmed import and rejects re-uploaded duplicates",async()=>{const results=await Promise.all([1,2].map(()=>req("/api/v1/documents/import-pdf/confirm","POST",{importId,draft:draft()})));assert.ok(results.every(r=>r.reused&&r.dealId===dealId));const p=await preview();await req("/api/v1/documents/import-pdf/confirm","POST",{importId:p.importId,draft:{...draft(),number:"ANOTHER"}},409);await req(`/api/v1/documents/import-pdf/${p.importId}`,"DELETE");});
 it("adds manual invoice to the existing deal and preserves the PDF",async()=>{
  const p=await preview("INVOICE");const data=draft("INVOICE");await req("/api/v1/documents/import-pdf/confirm","POST",{importId:p.importId,draft:data},422);
  const saved=await req("/api/v1/documents/import-pdf/confirm","POST",{importId:p.importId,dealId,draft:data});
  const invoice=await prisma.invoice.findUniqueOrThrow({where:{id:saved.documentId}});assert.equal(invoice.dealId,dealId);assert.equal(invoice.contractId,contractId);assert.equal(invoice.status,"ISSUED");
  const r=await fetch(base+`/api/v1/invoices/${invoice.id}/pdf`,{headers:{cookie}});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
  await req(`/api/v1/invoices/${invoice.id}/generate`,"POST",{},422);
  const docs=await req(`/api/v1/deals/${dealId}/documents`);assert.equal(docs.contracts[0].importedPdf,true);assert.equal(docs.invoices[0].importedPdf,true);
  const hidden=await fetch(base+`/api/v1/invoices/${invoice.id}/pdf`,{headers:{cookie:foreign}});assert.equal(hidden.status,404);
 });
 it("serializes simultaneous uploads and preserves existing company details",async()=>{
  const originalBytes=bytes;bytes=Buffer.concat([bytes,Buffer.from("\n% concurrency-check\n")]);
  try {
    const company=await prisma.company.findFirstOrThrow({where:{bin:party.bin}});
    await prisma.company.update({where:{id:company.id},data:{legalAddress:"Адрес, уточнённый менеджером"}});
    const count=await prisma.deal.count();const [a,b]=await Promise.all([preview(),preview()]);
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
