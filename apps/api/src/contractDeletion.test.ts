import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { resolveUploadPath } from "./lib/storage.ts";
import { deleteContract } from "./services/contractDeletionService.ts";
import type { AuthContext } from "./lib/types.ts";

describe("Contract deletion",()=>{
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: Server, base: string, cookie: string, foreign: string, dealId: string, tenantId: string;
  async function req(url:string,method="GET",body?:unknown,session=cookie) {
    const response=await fetch(base+url,{method,headers:{"content-type":"application/json",cookie:session||""},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json().catch(()=>null)};
  }
  async function fixture(status="DRAFT") {
    return prisma.contract.create({data:{tenantId,dealId,number:`DELETE-${randomUUID()}`,status,amountWithoutVat:100,vatAmount:0,totalAmount:100}});
  }
  before(async()=>{
    prisma=await createPrismaClient();await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
    server=createApp(prisma).listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
    base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    for(const email of ["owner@creolab.example","owner@demo-agency.example"]){
      const response=await fetch(base+"/api/v1/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password:process.env.SEED_PASSWORD,client:"web"})});
      assert.equal(response.status,200);const session=response.headers.get("set-cookie")!.split(";")[0];if(!cookie)cookie=session;else foreign=session;
    }
    const contact=await req("/api/v1/contacts","POST",{name:"Удаление договора",phone:"+77019997766"});
    const deal=await req("/api/v1/deals","POST",{title:"Сохранить сделку после удаления",contactId:contact.body.client?.id||contact.body.id,items:[{name:"Тестовая услуга",quantity:1,unitPrice:100,vatRate:0}]});
    assert.equal(deal.status,201,JSON.stringify(deal.body));dealId=deal.body.deal.id;
    tenantId=(await prisma.deal.findUniqueOrThrow({where:{id:dealId}})).tenantId;
  });
  after(async()=>{await new Promise<void>(r=>server?.close(()=>r()));await prisma?.$disconnect();});

  it("deletes a created draft and keeps the deal and numbering usable",async()=>{
    const first=await req(`/api/v1/deals/${dealId}/contracts`,"POST",{});assert.equal(first.status,201);
    const result=await req(`/api/v1/contracts/${first.body.contract.id}`,"DELETE");assert.equal(result.status,200);
    assert.equal(await prisma.contractVersion.count({where:{contractId:first.body.contract.id}}),0);
    const second=await req(`/api/v1/deals/${dealId}/contracts`,"POST",{});assert.equal(second.status,201);
    assert.notEqual(second.body.contract.number,first.body.contract.number);
    assert.equal((await req(`/api/v1/contracts/${second.body.contract.id}`,"DELETE")).status,200);
    assert.ok(await prisma.deal.findUnique({where:{id:dealId}}));assert.equal(await prisma.dealItem.count({where:{dealId}}),1);
  });

  it("removes Word/PDF files, versions and unsigned public links without changing company settings",async()=>{
    const contract=await fixture("PENDING_SIGNATURE");const files=[];
    const profile=await prisma.tenantLegalProfile.findUnique({where:{tenantId}});
    for(const extension of ["docx","pdf"]){
      const id=randomUUID(),storageKey=`${tenantId}/contracts/${contract.id}/${id}.${extension}`;
      const absolute=resolveUploadPath(storageKey);await mkdir(path.dirname(absolute),{recursive:true});await writeFile(absolute,"test contract");
      await prisma.attachment.create({data:{id,tenantId,parentId:contract.id,parentType:"contract",storageKey,fileName:`test.${extension}`,mimeType:extension==="pdf"?"application/pdf":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",sizeBytes:13,status:"imported"}});
      files.push({id,absolute});
    }
    await prisma.contract.update({where:{id:contract.id},data:{originalFileId:files[0].id,generatedFileId:files[1].id}});
    await prisma.contractVersion.create({data:{tenantId,contractId:contract.id,version:1,fileId:files[1].id}});
    const token="test-deleted-contract-token";
    await prisma.signatureRequest.create({data:{tenantId,contractId:contract.id,signerType:"BUYER",order:2,tokenHash:createHash("sha256").update(token).digest("hex")}});
    assert.equal((await req(`/api/v1/contracts/${contract.id}`,"DELETE")).status,200);
    for(const file of files){await assert.rejects(stat(file.absolute),{code:"ENOENT"});assert.equal(await prisma.attachment.findUnique({where:{id:file.id}}),null);}
    assert.equal(await prisma.signatureRequest.count({where:{contractId:contract.id}}),0);
    assert.equal((await req(`/public/sign/${token}`)).status,404);
    assert.equal((await req(`/api/v1/contracts/${contract.id}/original`)).status,404);
    assert.equal((await req(`/api/v1/contracts/${contract.id}/pdf`)).status,404);
    assert.deepEqual(await prisma.tenantLegalProfile.findUnique({where:{tenantId}}),profile);
    const documents=await req(`/api/v1/deals/${dealId}/documents`);assert.ok(!documents.body.contracts.some((c:any)=>c.id===contract.id));
    assert.equal(await prisma.auditEvent.count({where:{entityId:contract.id,action:"contract.delete"}}),1);
    assert.equal((await req(`/api/v1/contracts/${contract.id}`,"DELETE")).status,404);
  });

  it("enforces tenant boundaries and document permissions",async()=>{
    const contract=await fixture();
    assert.equal((await req(`/api/v1/contracts/${contract.id}`,"DELETE",undefined,foreign)).status,404);
    assert.equal((await req(`/api/v1/contracts/${contract.id}`,"DELETE",undefined,"")).status,401);
    await assert.rejects(deleteContract(prisma,{user:{platformAdmin:false},activeMembership:{tenantId,role:"manager",permissions:[]}} as unknown as AuthContext,contract.id),{status:403});
    assert.ok(await prisma.contract.findUnique({where:{id:contract.id}}));
  });

  it("blocks signed contracts and linked invoices/acts",async()=>{
    for(const status of ["SIGNED","PARTIALLY_SIGNED"]){const contract=await fixture(status);const r=await req(`/api/v1/contracts/${contract.id}`,"DELETE");assert.equal(r.status,409);assert.equal(r.body.code,"contract_signed");}
    const contract=await fixture();
    await prisma.documentSignature.create({data:{tenantId,contractId:contract.id,documentHash:"test",verificationStatus:"VERIFIED"}});
    assert.equal((await req(`/api/v1/contracts/${contract.id}`,"DELETE")).body.code,"contract_signed");
    const invoiceContract=await fixture();
    await prisma.invoice.create({data:{tenantId,dealId,contractId:invoiceContract.id,number:"LINKED-INVOICE",amountWithoutVat:100,vatAmount:0,totalAmount:100}});
    assert.equal((await req(`/api/v1/contracts/${invoiceContract.id}`,"DELETE")).body.code,"contract_has_documents");
    const actContract=await fixture();
    await prisma.electronicDocument.create({data:{tenantId,dealId,contractId:actContract.id,type:"AVR",number:"LINKED-ACT",amountWithoutVat:100,vatAmount:0,totalAmount:100}});
    assert.equal((await req(`/api/v1/contracts/${actContract.id}`,"DELETE")).body.code,"contract_has_documents");
    assert.ok(await prisma.contract.findUnique({where:{id:actContract.id}}));
  });
});
