import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { pemFromCms } from "./services/cmsInspect.ts";
import { makeTestCms } from "./testCms.ts";
import { documentWorkflowState, countDocumentClosing } from "./services/documentWorkflow.ts";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveUploadPath } from "./lib/storage.ts";
import { createApp } from "./app.ts";

describe("AVR editor workflow", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let contactId = "";
  let dealId = "";
  let contractId = "";
  let documentId = "";

  async function json(path: string, init: RequestInit = {}, useCookie = cookie) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        cookie: useCookie,
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  }

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = (server as { address: () => { port: number } }).address();
    base = `http://127.0.0.1:${address.port}`;

    const login = await json(
      "/api/v1/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          email: "owner@creolab.example",
          password: process.env.SEED_PASSWORD,
          client: "web",
        }),
      },
      "",
    );
    cookie = login.response.headers.get("set-cookie") || "";
    const demo = await json(
      "/api/v1/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          email: "owner@demo-agency.example",
          password: process.env.SEED_PASSWORD,
          client: "web",
        }),
      },
      "",
    );
    otherCookie = demo.response.headers.get("set-cookie") || "";

    const profile = await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({
        legalName: "ТОО CREOLAB",
        bin: "123456789013",
        legalAddress: "г. Алматы, пр. Абая 1",
        directorName: "Иванов Иван",
        defaultVatMode: "percent",
        defaultVatRate: 12,
      }),
    });
    assert.equal(profile.response.status, 200);

    const created = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Editor клиент", phone: "+77015550051" }),
    });
    contactId = created.body.client?.id || created.body.id;

    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Editor сайт",
        contactId,
        items: [{ name: "Разработка сайта", quantity: 1, unitPrice: 850000 }],
      }),
    });
    assert.equal(deal.response.status, 201);
    dealId = deal.body.deal.id;

    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Editor Buyer",
        legalName: "ТОО Editor Buyer",
        bin: "222222222220",
        legalAddress: "г. Астана, ул. Кабанбай 10",
        forceCreate: true,
      }),
    });
    assert.equal(company.response.status, 201, JSON.stringify(company.body));
    await json(`/api/v1/deals/${dealId}`, {
      method: "PATCH",
      body: JSON.stringify({ companyId: company.body.id }),
    });

    const draft = await json(`/api/v1/deals/${dealId}/contracts`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    contractId = draft.body.contract.id;
    const generated = await json(`/api/v1/contracts/${contractId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(generated.response.status, 200, JSON.stringify(generated.body));
  });

  after(() => {
    server?.close();
  });

  const editor={documentDate:"2026-09-13",items:[{name:"Дополнительные работы",quantity:1.125,unit:"час",unitPrice:100.10,vatRate:12}]};
  const post=(body:unknown)=>({method:"POST",body:JSON.stringify(body)});
  const patch=(body:unknown)=>({method:"PATCH",body:JSON.stringify(body)});

  it("вычисляет готовность и заполняет карточку без создания документа",async()=>{
    const before=await json("/api/v1/documents/avr/eligible-deals?filter=all");
    const row=before.body.items.find((d:any)=>d.id===dealId);
    assert.equal(row.ready,false);assert.ok(row.reasons.some((r:string)=>r.includes("оплачена")));
    await prisma.deal.update({where:{id:dealId},data:{paymentStatus:"PAID"}});
    const ready=await json("/api/v1/documents/avr/eligible-deals?filter=ready");
    assert.ok(ready.body.items.some((d:any)=>d.id===dealId&&d.ready));
    const ctx=await json(`/api/v1/deals/${dealId}/avr-context`);
    assert.equal(ctx.response.status,200,JSON.stringify(ctx.body));
    assert.equal(ctx.body.deal.id,dealId);assert.equal(ctx.body.contract.id,contractId);
    assert.equal(ctx.body.items[0].name,"Разработка сайта");assert.equal(ctx.body.organization.bin,"123456789013");
    assert.equal(ctx.body.existingDocumentId,null);
    assert.equal((await json(`/api/v1/deals/${dealId}/avr-context`,{},otherCookie)).response.status,404);
    const tenant=(await prisma.deal.findUniqueOrThrow({where:{id:dealId}})).tenantId;
    assert.ok(await countDocumentClosing(prisma,tenant)>0);
  });
  it("повторное и одновременное создание возвращают один черновик без счета и NCALayer",async()=>{
    const results=await Promise.all([1,2].map(()=>json(`/api/v1/deals/${dealId}/electronic-documents`,post({type:"AVR",editor}))));
    for(const r of results)assert.equal(r.response.status,201,JSON.stringify(r.body));
    documentId=results[0].body.document.id;assert.equal(results[1].body.document.id,documentId);
    assert.equal(await prisma.electronicDocument.count({where:{dealId,type:"AVR"}}),1);
    const doc=(await json(`/api/v1/electronic-documents/${documentId}`)).body.document;
    assert.equal(doc.status,"DRAFT");assert.equal(doc.dealId,dealId);assert.equal(doc.invoiceId,null);
    assert.equal(doc.source.items[0].name,editor.items[0].name);
    assert.equal(doc.totalAmount,126.12);assert.equal(doc.source.totals.vatAmount,13.51);
    assert.equal(doc.xmlStorageKey,undefined);
    assert.equal((await prisma.dealItem.findFirstOrThrow({where:{dealId}})).name,"Разработка сайта");
  });
  it("редактирует и повторно открывает; отклоняет устаревшее сохранение и чужую организацию",async()=>{
    const old=(await json(`/api/v1/electronic-documents/${documentId}`)).body.document;
    const edit=await json(`/api/v1/electronic-documents/${documentId}`,patch({...editor,updatedAt:old.updatedAt,items:[{...editor.items[0],quantity:2}]}));
    assert.equal(edit.response.status,200,JSON.stringify(edit.body));assert.equal(edit.body.document.totalAmount,224.22);
    const stale=await json(`/api/v1/electronic-documents/${documentId}`,patch({...editor,updatedAt:old.updatedAt}));
    assert.equal(stale.response.status,409);
    assert.equal((await json(`/api/v1/electronic-documents/${documentId}`,patch(editor),otherCookie)).response.status,404);
    const invalid=await json(`/api/v1/electronic-documents/${documentId}`,patch({...editor,documentDate:"2026-02-30"}));
    assert.equal(invalid.response.status,422);
    const reopened=(await json(`/api/v1/electronic-documents/${documentId}`)).body.document;
    assert.equal(reopened.source.items[0].quantity,2);assert.equal(reopened.status,"DRAFT");
  });
  it("сохраняет реквизиты в компании и обновляет их при проверке без потери позиций",async()=>{
    const deal=await prisma.deal.findUniqueOrThrow({where:{id:dealId}});
    assert.equal((await json(`/api/v1/companies/${deal.companyId}`,patch({legalAddress:"г. Алматы, новый адрес 15"}))).response.status,200);
    const basis=await json("/api/v1/settings/legal-profile",patch({directorBasis:"Устав"}));
    assert.equal(basis.response.status,200,JSON.stringify(basis.body));assert.equal(basis.body.directorBasis,"Устав");
    const checked=await json(`/api/v1/electronic-documents/${documentId}/validate`,post({}));
    assert.equal(checked.response.status,200,JSON.stringify(checked.body));
    assert.equal(checked.body.document.status,"VALIDATED");assert.equal(checked.body.document.source.items[0].quantity,2);
    assert.equal(checked.body.document.totalAmount,224.22);
    assert.equal(checked.body.document.source.buyer.legalAddress,"г. Алматы, новый адрес 15");
    assert.match(checked.body.warnings[0],/не подписан/);
    assert.equal((await json(`/api/v1/deals/${dealId}/avr-context`)).body.organization.directorBasis,"Устав");
  });
  it("пустой черновик сохраняется, но не проходит проверку; сумму проверяет сервер",async()=>{
    assert.equal((await json(`/api/v1/electronic-documents/${documentId}`,patch({...editor,items:[]}))).response.status,200);
    const empty=await json(`/api/v1/electronic-documents/${documentId}/validate`,post({}));
    assert.equal(empty.response.status,422);assert.ok(empty.body.details.missingFields.includes("deal.items"));
    await json(`/api/v1/electronic-documents/${documentId}`,patch({...editor,items:[{...editor.items[0],unitPrice:0}]}));
    assert.equal((await json(`/api/v1/electronic-documents/${documentId}/validate`,post({}))).response.status,422);
    await json(`/api/v1/electronic-documents/${documentId}`,patch(editor));
    assert.equal((await json(`/api/v1/electronic-documents/${documentId}/validate`,post({}))).response.status,200);
  });
  it("предлагает общую услугу сделки без line items",async()=>{
    const created=await json("/api/v1/deals",post({title:"Общая услуга",contactId}));
    assert.equal(created.response.status,201,JSON.stringify(created.body));
    const otherId=created.body.deal.id;
    await prisma.deal.update({where:{id:otherId},data:{offerAmountMinor:120000}});
    const ctx=await json(`/api/v1/deals/${otherId}/avr-context`);
    assert.equal(ctx.body.items.length,1);assert.equal(ctx.body.items[0].quantity,1);assert.equal(ctx.body.items[0].unitPrice,120000);
    const draft=await json(`/api/v1/deals/${otherId}/electronic-documents`,post({type:"AVR",editor:{documentDate:editor.documentDate,items:ctx.body.items}}));
    assert.equal(draft.response.status,201,JSON.stringify(draft.body));assert.equal(draft.body.document.totalAmount,120000);
  });
  it("ошибка отправки сохраняется отдельно и разрешает повтор после исправления",async()=>{
    await json("/api/v1/settings/legal-profile",patch({esfIntegrationEnabled:true}));
    const prepared=await json(`/api/v1/electronic-documents/${documentId}/esf-payload`,post({}));
    assert.equal(prepared.response.status,200,JSON.stringify(prepared.body));
    const bad=await json(`/api/v1/electronic-documents/${documentId}/esf-send-signed`,post({signature:Buffer.alloc(64,7).toString("base64"),publicCertificate:pemFromCms(makeTestCms(Buffer.from("SIGN"))),payloadSha256:"0".repeat(64)}));
    assert.equal(bad.response.status,409,JSON.stringify(bad.body));
    const doc=(await json(`/api/v1/electronic-documents/${documentId}`)).body.document;
    assert.equal(doc.status,"VALIDATED");assert.equal(doc.errorCode,"esf_payload_mismatch");assert.ok(doc.errorMessage);
  });
  it("отказ сервиса ЭСФ не отмечает документ отправленным",async()=>{
    const doc=await prisma.electronicDocument.findUniqueOrThrow({where:{id:documentId}});
    const path=resolveUploadPath(doc.xmlStorageKey!);const original=await readFile(path,"utf8");
    const invalid="<broken/>";await writeFile(path,invalid);
    try{
      const r=await json(`/api/v1/electronic-documents/${documentId}/esf-send-signed`,post({signature:Buffer.alloc(64,7).toString("base64"),publicCertificate:pemFromCms(makeTestCms(Buffer.from("SIGN"))),payloadSha256:createHash("sha256").update(invalid).digest("hex")}));
      assert.equal(r.response.status,422,JSON.stringify(r.body));
      const failed=await prisma.electronicDocument.findUniqueOrThrow({where:{id:documentId}});
      assert.equal(failed.externalId,null);assert.equal(failed.status,"VALIDATED");assert.ok(failed.errorCode);assert.ok(failed.errorMessage);
      assert.doesNotMatch(failed.errorMessage!,/stack|BEGIN CERTIFICATE/);
    }finally{await writeFile(path,original);}
  });
  it("отправляет существующим mock provider один раз и защищает финальный документ",async()=>{
    const prepared=await json(`/api/v1/electronic-documents/${documentId}/esf-payload`,post({}));
    assert.equal(prepared.body.validation.valid,true,JSON.stringify(prepared.body.validation));
    const input={signature:Buffer.alloc(64,7).toString("base64"),publicCertificate:pemFromCms(makeTestCms(Buffer.from("SIGN"))),payloadSha256:prepared.body.payloadSha256};
    const results=await Promise.all([1,2].map(()=>json(`/api/v1/electronic-documents/${documentId}/esf-send-signed`,post(input))));
    assert.ok(results.some(r=>r.response.status===200),JSON.stringify(results.map(r=>r.body)));
    assert.ok(results.every(r=>[200,409].includes(r.response.status)),JSON.stringify(results.map(r=>r.body)));
    const doc=(await json(`/api/v1/electronic-documents/${documentId}`)).body.document;
    assert.ok(doc.externalId);assert.equal(doc.status,"SENT");
    const again=await json(`/api/v1/electronic-documents/${documentId}/esf-send-signed`,post(input));
    assert.equal(again.body.reused,true);assert.equal(again.body.externalId,doc.externalId);
    assert.equal((await json(`/api/v1/electronic-documents/${documentId}`,patch(editor))).response.status,409);
    const created=await json(`/api/v1/deals/${dealId}/electronic-documents`,post({type:"AVR",editor}));
    assert.equal(created.body.document.id,documentId);assert.equal(created.body.reused,true);
    const ready=await json("/api/v1/documents/avr/eligible-deals?filter=ready");
    assert.ok(!ready.body.items.some((d:any)=>d.id===dealId));
    const state=(await json(`/api/v1/deals/${dealId}/documents`)).body.documentState;
    assert.equal(state.code,"AVR_SENT");assert.equal(state.needsEsf,true);
    const inbox=await json("/api/v1/documents?kind=EDOC");
    assert.equal(inbox.response.status,200,JSON.stringify(inbox.body));
    const row=inbox.body.items.find((d:any)=>d.id===documentId);
    assert.equal(row.href,`/documents/avr/${documentId}`);assert.equal(row.status,"SENT");assert.ok(row.date);
    assert.equal(row.avrStatus,"Отправлен");assert.equal(row.esfStatus,"Требуется");
    const dealDocs=await json(`/api/v1/documents?dealId=${dealId}`);
    const related=dealDocs.body.items.find((d:any)=>d.kind!=="AVR"&&d.dealId===dealId);
    if(related){assert.equal(related.avrStatus,"Отправлен");}
  });
  it("отклоняет второй документ по сделке, даже если он был создан ранее",async()=>{
    const first=await prisma.electronicDocument.findUniqueOrThrow({where:{id:documentId}});
    const legacy=await prisma.electronicDocument.create({data:{tenantId:first.tenantId,dealId,type:"AVR",number:"AVR-LEGACY-DUPLICATE",documentDate:first.documentDate,status:"VALIDATED",sourceDataJson:first.sourceDataJson!,amountWithoutVat:first.amountWithoutVat,vatAmount:first.vatAmount,totalAmount:first.totalAmount,xmlStorageKey:first.xmlStorageKey}});
    try{
      const r=await json(`/api/v1/electronic-documents/${legacy.id}/esf-send-signed`,post({signature:Buffer.alloc(64,7).toString("base64"),publicCertificate:pemFromCms(makeTestCms(Buffer.from("SIGN")))}));
      assert.equal(r.response.status,409);assert.equal(r.body.code,"document_duplicate");
      const reused=await json(`/api/v1/deals/${dealId}/electronic-documents`,post({type:"AVR",editor}));
      assert.equal(reused.body.document.id,documentId);
    }finally{await prisma.electronicDocument.delete({where:{id:legacy.id}});}
  });
  it("состояние документов не меняет стадию сделки",()=>{
    assert.equal(documentWorkflowState([]).code,"AVR_MISSING");
    assert.equal(documentWorkflowState([{type:"AVR",status:"DRAFT"}]).code,"AVR_DRAFT");
    assert.equal(documentWorkflowState([{type:"AVR",status:"ACCEPTED"},{type:"ESF",status:"ACCEPTED"}]).closed,true);
    assert.equal(documentWorkflowState([{type:"AVR",status:"VALIDATED",errorCode:"remote_error"}]).code,"ERROR");
  });
  it("берёт основание из счёта без карточки договора и сохраняет его при проверке и редактировании", async () => {
    const companyId = (await prisma.deal.findUniqueOrThrow({ where: { id: dealId } })).companyId!;
    const created = await json("/api/v1/deals", post({ title: "АВР из счёта", contactId, companyId, items: [{ name: "Съёмка", quantity: 1, unitPrice: 400000 }] }));
    const nextId = created.body.deal.id;
    const tenantId = (await prisma.deal.findUniqueOrThrow({ where: { id: nextId } })).tenantId;
    const invoice = await prisma.invoice.create({ data: { tenantId, dealId: nextId, companyId, amountWithoutVat: 400000, vatAmount: 0, totalAmount: 400000, number: "BASIS-INV", status: "ISSUED", contractNumber: "PHOTO-42", contractDate: new Date("2026-09-01T00:00:00Z") } });
    const context = await json(`/api/v1/deals/${nextId}/avr-context`);
    assert.equal(context.body.contract.number, "PHOTO-42");
    const avr = await json(`/api/v1/deals/${nextId}/electronic-documents`, post({ type: "AVR", editor }));
    assert.equal(avr.response.status, 201, JSON.stringify(avr.body));
    const id = avr.body.document.id;
    assert.equal(avr.body.document.invoiceId, invoice.id);
    assert.equal(avr.body.document.contractId, null);
    assert.equal(avr.body.document.source.contract.number, "PHOTO-42");
    assert.equal(avr.body.document.source.contract.date, "2026-09-01T00:00:00.000Z");
    const checked = await json(`/api/v1/electronic-documents/${id}/validate`, post({}));
    assert.equal(checked.response.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.document.source.contract.number, "PHOTO-42");
    const updated = await json(`/api/v1/electronic-documents/${id}`, patch(editor));
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.document.source.contract.number, "PHOTO-42");

    const { renderAvrExcel, resolveAvrSource, formatAvrContractBasis } = await import("./services/avrExcel.ts");
    const ExcelJS = (await import("exceljs")).default;
    const bytes = await renderAvrExcel({ number: avr.body.document.number, source: updated.body.document.source });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes.buffer as any);
    assert.match(String(workbook.worksheets[0].getCell("F13").value), /PHOTO-42/);
    assert.match(formatAvrContractBasis(updated.body.document.source.contract), /2026/);
    const { renderAvrPdf } = await import("./services/avrPdf.ts");
    const { buffer: pdfBytes } = await renderAvrPdf({ number: avr.body.document.number, source: updated.body.document.source });
    const { DOMMatrix, ImageData, Path2D } = await import("@napi-rs/canvas");
    Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true }).promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    assert.match(content.items.map(row => "str" in row ? row.str : "").join(" "), /PHOTO-42/);
    page.cleanup();

    // Old snapshots can lack the basis; only mutable documents may be repaired.
    const emptySource = { ...updated.body.document.source, contract: null, invoice: null };
    await prisma.electronicDocument.update({ where: { id }, data: { sourceDataJson: emptySource, invoiceId: null } });
    const old = await prisma.electronicDocument.findUniqueOrThrow({ where: { id } });
    assert.equal((await resolveAvrSource(prisma, tenantId, old)).contract?.number, "PHOTO-42");
    assert.equal((await json(`/api/v1/electronic-documents/${id}`)).body.document.source.contract.number, "PHOTO-42");
    for (const status of ["SIGNED", "PENDING_SIGNATURE", "SENT", "ACCEPTED"]) {
      assert.equal((await resolveAvrSource(prisma, tenantId, { ...old, status })).contract, null);
    }
    assert.equal((await resolveAvrSource(prisma, tenantId, { ...old, externalId: "sent-id" })).contract, null);
  });

  it("использует связанный договор счёта, явный договор и проверяет принадлежность документов", async () => {
    const { resolveAvrLinks } = await import("./services/avrContractBasis.ts");
    const tenantId = (await prisma.deal.findUniqueOrThrow({ where: { id: dealId } })).tenantId;
    const first = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    const newer = await prisma.contract.create({ data: { tenantId, dealId, amountWithoutVat: 1000, vatAmount: 0, totalAmount: 1000, number: "NEWER-UNRELATED", date: new Date("2026-09-20"), createdAt: new Date(Date.now() + 1000) } });
    const invoice = await prisma.invoice.create({ data: { tenantId, dealId, amountWithoutVat: 1000, vatAmount: 0, totalAmount: 1000, number: "LINKED-INV", contractId: first.id, status: "ISSUED" } });
    assert.equal((await resolveAvrLinks(prisma, tenantId, dealId, { invoiceId: invoice.id })).basis?.number, first.number);
    assert.equal((await resolveAvrLinks(prisma, tenantId, dealId, { contractId: newer.id })).basis?.number, newer.number);
    await prisma.invoice.update({ where: { id: invoice.id }, data: { withoutContract: true } });
    assert.equal((await resolveAvrLinks(prisma, tenantId, dealId, { invoiceId: invoice.id })).basis, null);
    const otherTenant = await prisma.tenant.findFirstOrThrow({ where: { id: { not: tenantId } } });
    await assert.rejects(resolveAvrLinks(prisma, otherTenant.id, dealId, { invoiceId: invoice.id }), /Счёт не найден/);
    await assert.rejects(resolveAvrLinks(prisma, tenantId, "other-deal", { contractId: newer.id }), /Договор не найден/);
  });

  it("восстанавливает номер из проверенного импорта счёта без выдуманной даты", async () => {
    const { resolveAvrLinks } = await import("./services/avrContractBasis.ts");
    const original = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    const created = await json("/api/v1/deals", post({ title: "Импорт счёта", contactId, companyId: original.companyId, items: [{ name: "Работа", quantity: 1, unitPrice: 1000 }] }));
    const imported = await prisma.invoice.create({ data: { tenantId: original.tenantId, dealId: created.body.deal.id, amountWithoutVat: 1000, vatAmount: 0, totalAmount: 1000, number: "IMPORTED-INV", pdfFileId: "legacy-file", status: "ISSUED" } });
    await prisma.auditEvent.create({ data: { tenantId: original.tenantId, entityType: "invoice", entityId: imported.id, action: "document.import_pdf", changesJson: { reviewedImport: { subject: "Работа", paymentTerms: "Оплата", contractNumber: "EXT-45" } } } });
    const result = await resolveAvrLinks(prisma, original.tenantId, created.body.deal.id);
    assert.equal(result.contract, null);
    assert.equal(result.basis?.number, "EXT-45");
    assert.equal(result.basis?.date, "");
  });
});
