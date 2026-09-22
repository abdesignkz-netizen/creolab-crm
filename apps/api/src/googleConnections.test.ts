import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { googleAgreementEventId } from "./services/googleCalendarSyncService.ts";
import { decryptSecret, encryptSecret } from "./lib/secretBox.ts";
import { mapFormAnswers, gmailPlainText } from "./services/googleIntakeService.ts";

describe("Google company connections", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>; let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base="",cookie="",calendarId="",formsId="",emailId="",agreementId="";
  const nativeFetch=globalThis.fetch; const originalBase=config.apiBaseUrl;
  const oldClient=process.env.GOOGLE_CLIENT_ID,oldSecret=process.env.GOOGLE_CLIENT_SECRET;
  const events=new Map<string,unknown>();const cancelled=new Set<string>(); let inserts=0,refreshes=0; let mailbox="inbox@example.test"; const leadDate=new Date(Date.now()+1000).toISOString();
  before(async()=>{
    process.env.GOOGLE_CLIENT_ID="test-client";process.env.GOOGLE_CLIENT_SECRET="test-secret";config.apiBaseUrl="https://crm.example.test";
    globalThis.fetch=async(url,init)=>{
      const u=new URL(String(url));
      if(!["oauth2.googleapis.com","www.googleapis.com","forms.googleapis.com"].includes(u.hostname))return nativeFetch(url,init);
      const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
      if(u.pathname==="/token") { const form=new URLSearchParams(String(init?.body));if(form.get("grant_type")==="refresh_token")refreshes++;return reply({access_token:"google-access",refresh_token:"google-refresh",expires_in:3600}); }
      if(u.pathname.includes("calendarList/"))return reply({id:"calendar-owner",summary:"Календарь компании",accessRole:"owner"});
      if(u.pathname.includes("/events")){
        const id=u.pathname.split("/").at(-1)!;const method=init?.method;
        if(method==="PATCH") { const body=JSON.parse(String(init?.body));if(cancelled.has(id)){if(body.status!=="confirmed")return reply({},410);cancelled.delete(id);}else if(!events.has(id))return reply({},404);events.set(id,body);return reply({id}); }
        if(method==="POST"){const body=JSON.parse(String(init?.body));if(events.has(body.id)||cancelled.has(body.id))return reply({},409);events.set(body.id,body);inserts++;return reply({id:body.id});}
        if(method==="DELETE"){if(events.has(id))cancelled.add(id);events.delete(id);return new Response(null,{status:204});}
      }
      if(u.pathname.endsWith("/profile"))return reply({emailAddress:mailbox});
      if(u.pathname==="/v1/forms/test-form-12345")return reply({info:{title:"Форма заявок"},items:[{title:"Телефон",questionItem:{question:{questionId:"phone-q"}}},{title:"Имя",questionItem:{question:{questionId:"name-q"}}}]});
      if(u.pathname.endsWith("/responses"))return reply({responses:[{responseId:"response-1",lastSubmittedTime:leadDate,answers:{"phone-q":{textAnswers:{answers:[{value:"+77017778899"}]}},"name-q":{textAnswers:{answers:[{value:"Google клиент"}]}}}},{responseId:"response-2",lastSubmittedTime:leadDate,answers:{"name-q":{textAnswers:{answers:[{value:"Без телефона"}]}}}}]});
      if(u.pathname==="/gmail/v1/users/me/messages")return reply({messages:[{id:"mail-1"}]});
      if(u.pathname.endsWith("/messages/mail-1"))return reply({id:"mail-1",threadId:"thread-1",internalDate:String(Date.now()+1000),snippet:"Запрос",payload:{mimeType:"text/plain",headers:[{name:"From",value:"Покупатель <buyer@example.test>"},{name:"Subject",value:"Запрос стоимости"}],body:{data:Buffer.from("Здравствуйте, нужна консультация").toString("base64url")}}});
      throw new Error(`Unexpected mocked Google path ${u.pathname}`);
    };
    process.env.SEED_PASSWORD||="ChangeMeLocal1!";prisma=await createPrismaClient();const {seedDatabase}=await import("../../../packages/db/src/seed.ts");await seedDatabase();
    await new Promise<void>(resolve=>{server=createApp(prisma).listen(0,"127.0.0.1",resolve);});const addr=server.address();if(!addr||typeof addr==="string")throw new Error("port");base=`http://127.0.0.1:${addr.port}`;
    const login=await nativeFetch(`${base}/api/v1/auth/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"owner@creolab.example",password:process.env.SEED_PASSWORD})});assert.equal(login.status,200);cookie=(login.headers.get("set-cookie")||"").split(";")[0];
  });
  after(async()=>{globalThis.fetch=nativeFetch;config.apiBaseUrl=originalBase;if(oldClient===undefined)delete process.env.GOOGLE_CLIENT_ID;else process.env.GOOGLE_CLIENT_ID=oldClient;if(oldSecret===undefined)delete process.env.GOOGLE_CLIENT_SECRET;else process.env.GOOGLE_CLIENT_SECRET=oldSecret;if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));if(prisma)await prisma.$disconnect();});
  const post=(path:string,body:unknown={})=>nativeFetch(`${base}${path}`,{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify(body)});
  async function connect(kind:string,resourceId?:string){
    const begin=await post("/api/v1/integrations/google/connect",{kind,resourceId});const body=await begin.json();assert.equal(begin.status,200,JSON.stringify(body));const state=new URL(body.url).searchParams.get("state")!;
    const callback=await nativeFetch(`${base}/api/v1/integrations/google/callback?state=${state}&code=test-code`,{headers:{cookie},redirect:"manual"});assert.equal(callback.status,302,await callback.text());
    const reused=await nativeFetch(`${base}/api/v1/integrations/google/callback?state=${state}&code=test-code`,{headers:{cookie},redirect:"manual"});assert.equal(reused.status,400);
    const list=await(await nativeFetch(`${base}/api/v1/integrations/google`,{headers:{cookie}})).json();assert.ok(!JSON.stringify(list).includes("google-access"));return list.items.find((r:{kind:string})=>r.kind===kind).id;
  }
  it("OAuth binds one-time state to the session and rejects fabricated state",async()=>{
    const bad=await nativeFetch(`${base}/api/v1/integrations/google/callback?state=${"a".repeat(64)}&code=test`,{headers:{cookie}});assert.equal(bad.status,400);
    calendarId=await connect("calendar");const row=await prisma.integration.findUniqueOrThrow({where:{id:calendarId}});const credential=await prisma.credential.findUniqueOrThrow({where:{id:row.credentialId!}});assert.ok(!credential.encryptedValue.includes("google-access"));
  });
  it("keeps legacy calendar settings separate from company OAuth connections",async()=>{
    const google=await prisma.integration.findUniqueOrThrow({where:{id:calendarId}});
    const legacy=await prisma.integration.create({data:{tenantId:google.tenantId,type:"calendar",name:"Legacy calendar",status:"active",publicKey:"legacy-calendar-test"}});
    assert.equal(await connect("calendar"),calendarId);
    assert.equal((await prisma.integration.findUniqueOrThrow({where:{id:legacy.id}})).status,"active");
    assert.equal((await post(`/api/v1/integrations/google/${legacy.id}/sync`)).status,404);
  });
  it("calendar creates one event, updates reschedules, deletes cancellations and excludes other tenants",async()=>{
    const row=await prisma.integration.findUniqueOrThrow({where:{id:calendarId}});
    const agreement=await prisma.agreement.create({data:{tenantId:row.tenantId,type:"ONLINE_MEETING",title:"Обсуждение",status:"CONFIRMED",scheduledAt:new Date(Date.now()+86400000)}});agreementId=agreement.id;
    const other=await prisma.tenant.findFirstOrThrow({where:{id:{not:row.tenantId}}});const foreign=await prisma.agreement.create({data:{tenantId:other.id,type:"ONLINE_MEETING",title:"Чужая встреча",status:"CONFIRMED",scheduledAt:new Date(Date.now()+86400000)}});
    let result=await post(`/api/v1/integrations/google/${calendarId}/sync`);assert.equal(result.status,200,await result.text());const eventId=googleAgreementEventId(row.tenantId,agreementId);assert.ok(events.has(eventId));assert.ok(!events.has(googleAgreementEventId(other.id,foreign.id)));const initial=inserts;
    await prisma.agreement.update({where:{id:agreementId},data:{title:"Новое название",scheduledAt:new Date(Date.now()+172800000)}});
    result=await post(`/api/v1/integrations/google/${calendarId}/sync`);assert.equal(result.status,200);assert.equal(inserts,initial);assert.equal((events.get(eventId)as{summary:string}).summary,"Новое название");
    await prisma.agreement.update({where:{id:agreementId},data:{status:"CANCELLED"}});assert.equal((await post(`/api/v1/integrations/google/${calendarId}/sync`)).status,200);assert.ok(!events.has(eventId));
  });
  it("restores cancelled meetings and keeps completed events in calendar history",async()=>{
    const row=await prisma.integration.findUniqueOrThrow({where:{id:calendarId}});const eventId=googleAgreementEventId(row.tenantId,agreementId);
    const insertedBefore=inserts;
    await prisma.agreement.update({where:{id:agreementId},data:{status:"CONFIRMED"}});
    assert.equal((await post(`/api/v1/integrations/google/${calendarId}/sync`)).status,200);assert.ok(events.has(eventId));assert.equal(inserts,insertedBefore);
    await prisma.agreement.update({where:{id:agreementId},data:{status:"COMPLETED"}});
    assert.equal((await post(`/api/v1/integrations/google/${calendarId}/sync`)).status,200);assert.ok(events.has(eventId));
  });
  it("Forms imports phone leads once and preserves incomplete responses for clarification",async()=>{
    formsId=await connect("google_forms","test-form-12345");const result=await post(`/api/v1/integrations/google/${formsId}/sync`);assert.equal(result.status,200,await result.text());
    assert.equal(await prisma.inquiry.count({where:{integrationId:formsId}}),1);assert.equal(await prisma.incompleteIntake.count({where:{integrationId:formsId}}),1);
    assert.equal((await post(`/api/v1/integrations/google/${formsId}/sync`)).status,200);assert.equal(await prisma.inquiry.count({where:{integrationId:formsId}}),1);
  });
  it("Gmail imports new letters into dialogues without generating fake phone leads",async()=>{
    emailId=await connect("email");let result=await post(`/api/v1/integrations/google/${emailId}/sync`);assert.equal(result.status,200,await result.text());
    const connection=await prisma.channelConnection.findFirstOrThrow({where:{integrationId:emailId}});const conversation=await prisma.conversation.findFirstOrThrow({where:{connectionId:connection.id}});
    const message=await prisma.message.findFirstOrThrow({where:{conversationId:conversation.id}});assert.ok(message.text?.includes("нужна консультация"));assert.equal(await prisma.inquiry.count({where:{integrationId:emailId}}),0);
    result=await post(`/api/v1/integrations/google/${emailId}/sync`);assert.equal(result.status,200);assert.equal(await prisma.message.count({where:{conversationId:conversation.id}}),1);
    assert.equal((await post(`/api/v1/conversations/${conversation.id}/messages`,{text:"reply"})).status,409);
  });
  it("reauthorization preserves cursors and refreshes expired access without duplicate imports",async()=>{
    const before=await prisma.integration.findUniqueOrThrow({where:{id:emailId}});
    assert.equal(await connect("email"),emailId);
    const after=await prisma.integration.findUniqueOrThrow({where:{id:emailId}});
    assert.equal((after.schemaJson as {lastSyncAt:string}).lastSyncAt,(before.schemaJson as {lastSyncAt:string}).lastSyncAt);
    const credential=await prisma.credential.findUniqueOrThrow({where:{id:after.credentialId!}});
    const tokens=JSON.parse(decryptSecret(credential.encryptedValue));tokens.expiresAt=0;
    await prisma.credential.update({where:{id:credential.id},data:{encryptedValue:encryptSecret(JSON.stringify(tokens))}});
    assert.equal((await post(`/api/v1/integrations/google/${emailId}/sync`)).status,200);assert.equal(refreshes,1);
  });
  it("switching mailbox isolates identical provider IDs and retains old conversations",async()=>{
    const oldId=emailId;mailbox="different@example.test";emailId=await connect("email");assert.notEqual(emailId,oldId);
    assert.equal((await post(`/api/v1/integrations/google/${oldId}/sync`)).status,404);
    assert.equal((await post(`/api/v1/integrations/google/${emailId}/sync`)).status,200);
    const oldConnection=await prisma.channelConnection.findFirstOrThrow({where:{integrationId:oldId}});
    const newConnection=await prisma.channelConnection.findFirstOrThrow({where:{integrationId:emailId}});
    assert.notEqual(newConnection.id,oldConnection.id);assert.equal(oldConnection.status,"disabled");
    assert.equal(await prisma.conversation.count({where:{connectionId:{in:[oldConnection.id,newConnection.id]}}}),2);
  });
  it("disconnect retains imported data and prevents further sync",async()=>{assert.equal((await post(`/api/v1/integrations/google/${emailId}/disconnect`)).status,200);assert.equal((await post(`/api/v1/integrations/google/${emailId}/sync`)).status,404);assert.equal(await prisma.channelConnection.count({where:{integrationId:emailId}}),1);});
  it("mapping is explicit when labels differ and email HTML is not executed",()=>{assert.equal(mapFormAnswers([{id:"custom",title:"Номер для связи"}],{custom:{textAnswers:{answers:[{value:"+77001234567"}]}}},{phone:"custom"}).phone,"+77001234567");assert.equal(gmailPlainText({mimeType:"text/html",body:{data:Buffer.from("<script>bad()</script>").toString("base64url")}},"Безопасное превью"),"Безопасное превью");});
});
