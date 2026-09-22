import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {after,before,describe,it} from "node:test";
import {createPrismaClient} from "@creolab/db";
import {createApp} from "./app.ts";
import {config} from "./config.ts";

describe("Meta company channels",()=>{
  let prisma:Awaited<ReturnType<typeof createPrismaClient>>,server:ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base="",cookie="",instagramId="",leadsId="",conversationId="";let sends=0;let subscribedFields=["feed"];
  const nativeFetch=globalThis.fetch,oldBase=config.apiBaseUrl,appSecret="test-meta-app-secret-123456",accessToken="test-meta-page-access-token-123456";
  before(async()=>{
    config.apiBaseUrl="https://crm.example.test";
    globalThis.fetch=async(url,init)=>{
      const u=new URL(String(url));if(u.hostname!=="graph.facebook.com")return nativeFetch(url,init);
      const reply=(body:unknown)=>new Response(JSON.stringify(body),{headers:{"content-type":"application/json"}});
      if(u.pathname.endsWith("/debug_token"))return reply({data:{app_id:"50001",is_valid:true}});
      if(u.pathname.endsWith("/me"))return reply({id:"10001",name:"Страница компании",instagram_business_account:{id:"20001"}});
      if(u.pathname.endsWith("/leadgen_forms"))return reply({data:[{id:"30001"}]});
      if(u.pathname.endsWith("/subscribed_apps")){if(init?.method!=="POST")return reply({data:[{id:"50001",subscribed_fields:subscribedFields}]});subscribedFields=JSON.parse(String(init?.body)).subscribed_fields;return reply({success:true});}
      if(u.pathname.endsWith("/messages")){sends++;return reply({message_id:`sent-${sends}`});}
      if(u.pathname.endsWith("/40001"))return reply({id:"40001",form_id:"30001",created_time:new Date().toISOString(),field_data:[{name:"full_name",values:["Покупатель Meta"]},{name:"phone_number",values:["+77017654321"]}]});
      throw new Error(`Unexpected Meta call ${u.pathname}`);
    };
    process.env.SEED_PASSWORD||="ChangeMeLocal1!";prisma=await createPrismaClient();const {seedDatabase}=await import("../../../packages/db/src/seed.ts");await seedDatabase();
    await new Promise<void>(resolve=>{server=createApp(prisma).listen(0,"127.0.0.1",resolve);});const a=server.address();if(!a||typeof a==="string")throw new Error("port");base=`http://127.0.0.1:${a.port}`;
    const login=await nativeFetch(`${base}/api/v1/auth/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"owner@creolab.example",password:process.env.SEED_PASSWORD})});assert.equal(login.status,200);cookie=(login.headers.get("set-cookie")||"").split(";")[0];
  });
  after(async()=>{globalThis.fetch=nativeFetch;config.apiBaseUrl=oldBase;if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));if(prisma)await prisma.$disconnect();});
  const post=(path:string,body:unknown={},headers:Record<string,string>={})=>nativeFetch(`${base}${path}`,{method:"POST",headers:{cookie,"content-type":"application/json",...headers},body:JSON.stringify(body)});
  const webhook=(id:string,body:unknown,valid=true)=>{const raw=JSON.stringify(body);return post(`/public/integrations/meta/${id}`,body,{"x-hub-signature-256":`sha256=${createHmac("sha256",valid?appSecret:"wrong").update(raw).digest("hex")}`});};
  async function connect(kind:string){
    const res=await post("/api/v1/integrations/meta/connect",{kind,appId:"50001",pageId:"10001",accessToken,appSecret});const body=await res.json();assert.equal(res.status,200,JSON.stringify(body));assert.equal(body.connected,false);assert.ok(!JSON.stringify(body).includes(accessToken));
    assert.equal((await post(`/api/v1/integrations/meta/${body.id}/activate`)).status,409);
    const bad=await nativeFetch(`${base}/public/integrations/meta/${body.id}?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=hello`);assert.equal(bad.status,403);
    const verify=await nativeFetch(`${base}/public/integrations/meta/${body.id}?hub.mode=subscribe&hub.verify_token=${body.verifyToken}&hub.challenge=hello`);assert.equal(verify.status,200);assert.equal(await verify.text(),"hello");
    assert.equal((await post(`/api/v1/integrations/meta/${body.id}/activate`)).status,200);return body.id;
  }
  const dm=(mid:string,recipient="20001")=>({object:"instagram",entry:[{id:"20001",messaging:[{sender:{id:"90001"},recipient:{id:recipient},timestamp:Date.now(),message:{mid,text:"Нужен проект"}}]}]});
  it("requires real webhook verification before enabling a connection",async()=>{instagramId=await connect("instagram_direct");leadsId=await connect("meta_lead_forms");assert.deepEqual(new Set(subscribedFields),new Set(["feed","messages","leadgen"]));});
  it("rejects forged payloads and ignores unrelated recipients",async()=>{assert.equal((await webhook(instagramId,dm("forged"),false)).status,401);assert.equal((await webhook(instagramId,dm("foreign","99999"))).status,200);assert.equal(await prisma.inboundEvent.count({where:{integrationId:instagramId}}),0);});
  it("Instagram messages enter dialogues once and can be answered within the reply window",async()=>{
    const body=dm("dm-1");assert.equal((await webhook(instagramId,body)).status,200);assert.equal((await webhook(instagramId,body)).status,200);
    const conn=await prisma.channelConnection.findFirstOrThrow({where:{integrationId:instagramId}});const conversation=await prisma.conversation.findFirstOrThrow({where:{connectionId:conn.id}});conversationId=conversation.id;
    assert.equal(await prisma.message.count({where:{conversationId}}),1);
    const path=`/api/v1/conversations/${conversationId}/messages`;const headers={"idempotency-key":"meta-reply-001"};let response=await post(path,{text:"Добрый день"},headers);assert.equal(response.status,201,await response.text());
    response=await post(path,{text:"Добрый день"},headers);assert.equal(response.status,201);assert.equal(sends,1);
    await prisma.message.updateMany({where:{conversationId,direction:"inbound"},data:{createdAt:new Date(Date.now()-90000000)}});
    assert.equal((await post(path,{text:"Поздний ответ"},{"idempotency-key":"meta-reply-002"})).status,409);assert.equal(sends,1);
  });
  it("Meta leadgen resolves fields through the provider API and deduplicates leads",async()=>{
    const body={object:"page",entry:[{id:"10001",changes:[{field:"leadgen",value:{leadgen_id:"40001",page_id:"10001",form_id:"30001"}}]}]};
    let res=await webhook(leadsId,body);assert.equal(res.status,200,await res.text());res=await webhook(leadsId,body);assert.equal(res.status,200);
    assert.equal(await prisma.inquiry.count({where:{integrationId:leadsId}}),1);assert.equal(await prisma.inquiry.count({where:{integrationId:instagramId}}),0);
  });
  it("disconnect stops reception without removing customer history",async()=>{const count=await prisma.message.count({where:{conversationId}});assert.equal((await post(`/api/v1/integrations/meta/${instagramId}/disconnect`)).status,200);assert.equal((await webhook(instagramId,dm("after-disconnect"))).status,403);assert.equal(await prisma.message.count({where:{conversationId}}),count);});
});
