import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { docxToText } from "./services/wordDocumentText.ts";

describe("Document numbering and editable AVR numbers", () => {
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

  it("validates settings and keeps tenant settings isolated", async () => {
    const invalid = await json("/api/v1/settings/document-numbering", patch({DOG:1, INV:1, AVR:0, ESF:1}));
    assert.equal(invalid.response.status, 422);
    const beforeOther = (await json("/api/v1/settings/document-numbering", {}, otherCookie)).body;
    const saved = await json("/api/v1/settings/document-numbering", patch({DOG:120, INV:240, AVR:360, ESF:480}));
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.AVR.next, 360);
    assert.equal(saved.body.INV.next, 240);
    assert.deepEqual((await json("/api/v1/settings/document-numbering", {}, otherCookie)).body, beforeOther);
    assert.equal((await json("/api/v1/settings/document-numbering", {}, "")).response.status, 401);
  });
  async function newDeal() {
    const result = await json("/api/v1/deals", post({title:"Numbering test",contactId,items:[{name:"Услуга",quantity:1,unitPrice:1000}]}));
    assert.equal(result.response.status,201,JSON.stringify(result.body));
    return result.body.deal.id as string;
  }
  it("applies configured starts to all four document types", async () => {
    const id = await newDeal();
    const contract = await json(`/api/v1/deals/${id}/contracts`, post({}));
    assert.equal(contract.response.status,201,JSON.stringify(contract.body));
    assert.match(contract.body.contract.number, /-0120$/);
    const invoice = await json(`/api/v1/deals/${id}/invoices`, post({}));
    assert.equal(invoice.response.status,201,JSON.stringify(invoice.body));
    assert.match(invoice.body.invoice.number, /-0240$/);
    for (const [type, suffix] of [["AVR","0360"],["ESF","0480"]]) {
      const result = await json(`/api/v1/deals/${id}/electronic-documents`, post({type}));
      assert.equal(result.response.status,201,JSON.stringify(result.body));
      assert.ok(result.body.document.number.endsWith(`-${suffix}`));
      if(type === "AVR") documentId = result.body.document.id;
    }
  });
  it("allocates distinct numbers concurrently and does not reuse deleted numbers", async () => {
    const ids = [await newDeal(), await newDeal()];
    const results = await Promise.all(ids.map(id => json(`/api/v1/deals/${id}/electronic-documents`,post({type:"AVR",editor}))));
    for(const result of results) assert.equal(result.response.status,201,JSON.stringify(result.body));
    assert.equal(new Set(results.map(result=>result.body.document.number)).size,2);
    const numbers=results.map(result=>Number(result.body.document.number.split("-").at(-1))).sort((a,b)=>a-b);
    assert.deepEqual(numbers,[361,362]);
    for(const result of results) assert.equal((await json(`/api/v1/electronic-documents/${result.body.document.id}`,{method:"DELETE"})).response.status,200);
    const settings=await json("/api/v1/settings/document-numbering",patch({DOG:1,INV:1,AVR:1,ESF:1}));
    assert.equal(settings.body.AVR.next,363);
    const created=await json(`/api/v1/deals/${ids[0]}/electronic-documents`,post({type:"AVR",editor}));
    assert.match(created.body.document.number,/-0363$/);
  });
  it("creates and edits manual numbers and rejects aliases", async () => {
    const id = await newDeal();
    const created = await json(`/api/v1/deals/${id}/electronic-documents`, post({type:"AVR",editor:{...editor,number:"Акт-125/А"}}));
    assert.equal(created.response.status,201,JSON.stringify(created.body));
    assert.equal(created.body.document.number,"Акт-125/А");
    const otherId=await newDeal();
    const alias=`${String(new Date().getFullYear()).slice(-2)}-0360`;
    const clash=await json(`/api/v1/deals/${otherId}/electronic-documents`,post({type:"AVR",editor:{...editor,number:alias}}));
    assert.equal(clash.response.status,409,JSON.stringify(clash.body));
    const edited=await json(`/api/v1/electronic-documents/${created.body.document.id}`,patch({...editor,number:"Акт-126/Б",updatedAt:created.body.document.updatedAt}));
    assert.equal(edited.response.status,200,JSON.stringify(edited.body));
    assert.equal(edited.body.document.number,"Акт-126/Б");
    const duplicateEdit=await json(`/api/v1/electronic-documents/${created.body.document.id}`,patch({...editor,number:alias}));
    assert.equal(duplicateEdit.response.status,409);
    const reopened=await json(`/api/v1/electronic-documents/${created.body.document.id}`);
    assert.equal(reopened.body.document.number,"Акт-126/Б");
    const cleared=await json(`/api/v1/electronic-documents/${created.body.document.id}`,patch({...editor,number:""}));
    assert.equal(cleared.body.document.number,"Акт-126/Б");
    const invalid=await json(`/api/v1/electronic-documents/${created.body.document.id}`,patch({...editor,number:"X".repeat(41)}));
    assert.equal(invalid.response.status,422);
  });
  it("continues after a manually assigned sequential number", async () => {
    const id = await newDeal();
    const number = `${String(new Date().getFullYear()).slice(-2)}-0700`;
    const created = await json(`/api/v1/deals/${id}/electronic-documents`, post({type:"AVR",editor:{...editor,number}}));
    assert.equal(created.response.status,201,JSON.stringify(created.body));
    assert.equal((await json("/api/v1/settings/document-numbering")).body.AVR.next,701);
    const deleted = await json(`/api/v1/electronic-documents/${created.body.document.id}`,{method:"DELETE"});
    assert.equal(deleted.response.status,200);
    assert.equal((await json("/api/v1/settings/document-numbering")).body.AVR.next,701);
  });

  it("creates a single contract draft with a manual number/date and rejects duplicates", async () => {
    const id = await newDeal();
    const input = {number:"ДГ-125/А",documentDate:"2026-08-15"};
    const results = await Promise.all([1,2].map(()=>json(`/api/v1/deals/${id}/contracts`,post(input))));
    for(const result of results) assert.equal(result.response.status,201,JSON.stringify(result.body));
    assert.equal(results[0].body.contract.id,results[1].body.contract.id);
    assert.equal(results[0].body.contract.number,input.number);
    assert.equal(results[0].body.contract.date.slice(0,10),input.documentDate);
    assert.equal(await prisma.contract.count({where:{dealId:id}}),1);
    const other = await newDeal();
    assert.equal((await json(`/api/v1/deals/${other}/contracts`,post(input))).response.status,409);
    assert.equal((await json(`/api/v1/deals/${other}/contracts`,post({number:"X".repeat(41)}))).response.status,422);
    assert.equal((await json(`/api/v1/deals/${other}/contracts`,post({documentDate:"2026-02-30"}))).response.status,422);
    const latest = (await json(`/api/v1/contracts/${results[0].body.contract.id}`)).body.contract;
    const changed = await json(`/api/v1/deals/${id}/contracts`,post({number:"ДГ-126/Б",updatedAt:latest.updatedAt}));
    assert.equal(changed.response.status,201,JSON.stringify(changed.body));
    assert.equal(changed.body.contract.number,"ДГ-126/Б");
    assert.equal((await json(`/api/v1/deals/${id}/contracts`,post({number:"ДГ-127",updatedAt:latest.updatedAt}))).response.status,409);
  });
  it("edits the number/date in PDF and Word atomically and preserves signed contracts", async () => {
    const before = (await json(`/api/v1/contracts/${contractId}`)).body.contract;
    const number = "ДГ-200/В";
    const changed = await json(`/api/v1/contracts/${contractId}/generate`,post({number,documentDate:"2026-08-17",updatedAt:before.updatedAt}));
    assert.equal(changed.response.status,200,JSON.stringify(changed.body));
    assert.equal(changed.body.contract.number,number);
    assert.equal(changed.body.contract.date.slice(0,10),"2026-08-17");
    assert.notEqual(changed.body.contract.generatedFileId,before.generatedFileId);
    const word = await fetch(`${base}/api/v1/contracts/${contractId}/docx`,{headers:{cookie}});
    assert.equal(word.status,200);
    assert.ok((await docxToText(Buffer.from(await word.arrayBuffer()))).includes(number));
    const pdf = await fetch(`${base}/api/v1/contracts/${contractId}/pdf`,{headers:{cookie}});
    assert.equal(pdf.status,200);
    const {DOMMatrix,ImageData,Path2D} = await import("@napi-rs/canvas");
    Object.assign(globalThis,{DOMMatrix,ImageData,Path2D});
    const {getDocument} = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const parsed = await getDocument({data:new Uint8Array(await pdf.arrayBuffer()),useSystemFonts:true}).promise;
    let text = "";
    for(let i=1;i<=parsed.numPages;i++) {
      const page = await parsed.getPage(i);
      text += (await page.getTextContent()).items.map(item=>"str" in item?item.str:"").join(" ");
      page.cleanup();
    }
    assert.ok(text.includes(number));
    const failed = await json(`/api/v1/contracts/${contractId}/generate`,post({number:"ДГ-126/Б"}));
    assert.equal(failed.response.status,409,JSON.stringify(failed.body));
    assert.equal((await json(`/api/v1/contracts/${contractId}`)).body.contract.number,number);
    const requests = await Promise.all(["ДГ-параллельный-А","ДГ-параллельный-Б"].map(number=>json(`/api/v1/contracts/${contractId}/generate`,post({number,updatedAt:changed.body.contract.updatedAt}))));
    assert.deepEqual(requests.map(r=>r.response.status).sort(),[200,409]);
    const winner = requests.find(r=>r.response.status===200)!.body.contract;
    const source = await fetch(`${base}/api/v1/contracts/${contractId}/docx`,{headers:{cookie}});
    assert.ok((await docxToText(Buffer.from(await source.arrayBuffer()))).includes(winner.number));
    assert.equal((await json(`/api/v1/contracts/${contractId}/generate`,post({number:"Чужой"}),otherCookie)).response.status,404);
    for(const status of ["PENDING_SIGNATURE","PARTIALLY_SIGNED","SIGNED"]) {
      await prisma.contract.update({where:{id:contractId},data:{status}});
      assert.equal((await json(`/api/v1/contracts/${contractId}/generate`,post({number:"Запрещённый"}))).response.status,422);
    }
    await prisma.contract.update({where:{id:contractId},data:{status:"DRAFT",originalFileId:crypto.randomUUID()}});
    assert.equal((await json(`/api/v1/contracts/${contractId}/generate`,post({number:"Импорт"}))).response.status,422);
    assert.equal((await json(`/api/v1/deals/${dealId}/contracts`,post({number:"Импорт"}))).response.status,422);
  });
  it("advances the contract counter after a manually entered automatic-series number", async () => {
    const id = await newDeal();
    const number = `DOG-${new Date().getFullYear()}-0900`;
    const result = await json(`/api/v1/deals/${id}/contracts`,post({number}));
    assert.equal(result.response.status,201,JSON.stringify(result.body));
    assert.equal((await json("/api/v1/settings/document-numbering")).body.DOG.next,901);
  });

});
