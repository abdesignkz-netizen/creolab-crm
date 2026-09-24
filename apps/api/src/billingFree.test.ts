import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { syncPricingCatalog, createPrismaClient, type PrismaClient } from '@creolab/db';
import { provisionOrganization } from './services/organizationProvisioning.ts';
import { getEntitlements } from './services/entitlementService.ts';
import { getUsage, freeMetrics, billingMonth, initializeTenantUsage, reserveAiCall } from './services/billingResourceService.ts';
import { quoteSubscription } from './services/pricingEngine.ts';
import { activateSubscription, periodEnd } from './services/subscriptionActivationService.ts';

let db: PrismaClient;
let sequence = 0;
async function freeTenant() {
  return db.$transaction(async tx => {
    const tenant = await provisionOrganization(tx, { name: `Free ${Date.now()} ${sequence++}`, source: 'self_registration', subscriptionStatus: 'none', aiEnabled: false });
    const user = await tx.user.create({ data: { name: 'Owner', email: `${tenant.id}@example.test`, passwordHash: 'test' } });
    await tx.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: 'owner' } });
    return tenant;
  });
}
describe('Free tenant quotas and preserved pricing', () => {
  before(async () => { db = await createPrismaClient(); });
  it('automatically activates only new self registrations with exact limits and no paid features', async () => {
    const tenant = await freeTenant();
    const access = await getEntitlements(db, tenant.id);
    assert.equal(access.snapshot.planCode, 'BASQAR_FREE');
    assert.equal(access.snapshot.subscriptionStatus, 'active');
    assert.equal(access.snapshot.expiresAt, null);
    for (const [key,value] of Object.entries({ USERS:1, CLIENTS:50, ACTIVE_DEALS:20, MONTHLY_LEADS:50, PIPELINES:1, DATABASE_MB:100, FILE_STORAGE_MB:250 })) assert.equal(access.limits[key],value);
    for (const feature of ['TASKS','CLIENTS','COMPANIES','LEADS','DEALS'] as const) assert.equal(access.entitlements[feature],true);
    for (const feature of ['AI_MANAGER','AI_CONTROL','WHATSAPP','IMPORT','EXPORT','SUPPORT','WORKFLOWS','DOCUMENTS','API_ACCESS'] as const) assert.equal(access.entitlements[feature],false);
    assert.equal(await db.billingPayment.count({ where: { tenantId: tenant.id } }),0);
    assert.equal(await db.subscriptionRequest.count({ where: { tenantId: tenant.id } }),0);
  });
  it('serializes concurrent creates: 50 clients, second user rejected, existing data readable', async () => {
    const tenant = await freeTenant();
    const results = await Promise.allSettled(Array.from({length:51}, (_,i) => db.contact.create({data:{tenantId:tenant.id,name:`Client ${i}`}})));
    assert.equal(results.filter(row=>row.status==='fulfilled').length,50);
    assert.equal(await db.contact.count({where:{tenantId:tenant.id}}),50);
    assert.equal(await getUsage(db,tenant.id,'CLIENTS'),50);
    const user = await db.user.create({data:{name:'Second',email:`second-${tenant.id}@example.test`,passwordHash:'test'}});
    await assert.rejects(db.membership.create({data:{tenantId:tenant.id,userId:user.id,role:'manager'}}), /BASQAR_LIMIT:USERS/);
    assert.equal(await getUsage(db,tenant.id,'USERS'),1);
  });
  it('counts active deals, keeps closed history, prevents reopening beyond quota', async () => {
    const tenant = await freeTenant(); const contact = await db.contact.create({data:{tenantId:tenant.id,name:'Customer'}});
    const stage = await db.dealStage.findFirstOrThrow({where:{tenantId:tenant.id}});
    const deals = [];
    for(let i=0;i<20;i++) deals.push(await db.deal.create({data:{tenantId:tenant.id,contactId:contact.id,stageId:stage.id,title:`Order ${i}`}}));
    await assert.rejects(db.deal.create({data:{tenantId:tenant.id,contactId:contact.id,stageId:stage.id,title:'21'}}), /BASQAR_LIMIT:ACTIVE_DEALS/);
    await db.deal.update({where:{id:deals[0].id},data:{outcome:'won',closedAt:new Date()}});
    await db.deal.create({data:{tenantId:tenant.id,contactId:contact.id,stageId:stage.id,title:'Replacement'}});
    await assert.rejects(db.deal.update({where:{id:deals[0].id},data:{outcome:'open',closedAt:null}}), /BASQAR_LIMIT:ACTIVE_DEALS/);
    assert.equal(await db.deal.count({where:{tenantId:tenant.id}}),21);
  });
  it('counts monthly intake even after deletion and resets at month boundary', async () => {
    const tenant = await freeTenant();
    const contact = await db.contact.create({data:{tenantId:tenant.id,name:'Lead contact'}});
    const make = () => db.inquiry.create({data:{tenantId:tenant.id,source:'manual',contactId:contact.id,subject:'Lead'}});
    for(let i=0;i<50;i++) await make();
    await assert.rejects(make(),/BASQAR_LIMIT:MONTHLY_LEADS/);
    const first = await db.inquiry.findFirstOrThrow({where:{tenantId:tenant.id}});
    await db.inquiry.delete({where:{id:first.id}});
    await assert.rejects(make(),/BASQAR_LIMIT:MONTHLY_LEADS/);
    await db.tenantUsage.update({where:{tenantId:tenant.id},data:{period:'2000-01'}});
    await make(); assert.equal(await getUsage(db,tenant.id,'MONTHLY_LEADS'),1);
    assert.equal((await db.tenantUsage.findUniqueOrThrow({where:{tenantId:tenant.id}})).period,billingMonth());
  });
  it('manual tasks work without AI and DB/files are independent with no data deletion', async () => {
    const tenant = await freeTenant();
    const task = await db.task.create({data:{tenantId:tenant.id,title:'Manual',type:'manual',status:'open'}});
    await db.task.update({where:{id:task.id},data:{title:'Changed',priority:'high',dueAt:new Date()}});
    await db.task.update({where:{id:task.id},data:{status:'completed'}});
    await db.task.update({where:{id:task.id},data:{status:'open'}});
    await assert.rejects(db.attachment.create({data:{tenantId:tenant.id,parentType:'task',parentId:task.id,storageKey:'test',fileName:'x',mimeType:'text/plain',sizeBytes:251*1048576}}),/BASQAR_LIMIT:FILE_STORAGE_MB/);
    await db.tenantUsage.update({where:{tenantId:tenant.id},data:{databaseBytes:BigInt(100*1048576)}});
    await assert.rejects(db.contact.create({data:{tenantId:tenant.id,name:'Overflow'}}),/BASQAR_LIMIT:DATABASE_MB/);
    await db.task.update({where:{id:task.id},data:{status:'completed'}});
    await assert.rejects(db.tenantServiceCategory.create({data:{tenantId:tenant.id,code:'oversized',name:'Oversized'}}), /BASQAR_LIMIT:DATABASE_MB/);
    assert.ok(await db.task.findUnique({where:{id:task.id}}));
    await db.task.delete({where:{id:task.id}});
  });
  it('enforces WhatsApp capacity including reconnection at the database boundary', async () => {
    const tenant = await freeTenant();
    const create = () => db.integration.create({data:{tenantId:tenant.id,type:'whatsapp_seller',name:'WhatsApp',status:'active',connectionStatus:'CONNECTED'}});
    await assert.rejects(create(),/BASQAR_LIMIT:WHATSAPP_CONNECTIONS/);
    await db.tenantUsage.update({where:{tenantId:tenant.id},data:{limitsJson:{WHATSAPP_CONNECTIONS:1}}});
    const first = await create(); await assert.rejects(create(),/BASQAR_LIMIT:WHATSAPP_CONNECTIONS/);
    await db.integration.update({where:{id:first.id},data:{connectionStatus:'DISCONNECTED'}});
    await create();
    await assert.rejects(db.integration.update({where:{id:first.id},data:{connectionStatus:'CONNECTED'}}),/BASQAR_LIMIT:WHATSAPP_CONNECTIONS/);
  });
  it('reserves AI capacity for concurrent calls and releases failed work', async () => {
    const tenant = await freeTenant();
    await db.tenantUsage.update({where:{tenantId:tenant.id},data:{limitsJson:{AI_USAGE:1}}});
    const results = await Promise.allSettled([reserveAiCall(db,tenant.id),reserveAiCall(db,tenant.id)]);
    assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
    for(const result of results) if(result.status==='fulfilled') await result.value();
    const release = await reserveAiCall(db,tenant.id); await release();
  });
  it('keeps calendar-month renewals and unlimited addon limits stable', async () => {
    assert.equal(periodEnd(new Date('2026-01-31T12:00:00Z'),'MONTHLY').toISOString(),'2026-02-28T12:00:00.000Z');
    assert.equal(periodEnd(new Date('2024-02-29T12:00:00Z'),'YEARLY').toISOString(),'2025-02-28T12:00:00.000Z');
    const quote = await quoteSubscription(db,{planCode:'CONTROL',addOns:[{code:'ADDON_INTEGRATION'}]});
    assert.equal(quote.recommendation,null);
  });
  it('freezes old assignments before upgrading the public catalog', async () => {
    const tenant = await db.tenant.create({data:{name:'Existing paid company',slug:`old-paid-${Date.now()}`}});
    const oldPlan = await db.plan.update({where:{code:'CRM_START'},data:{version:1,featuresJson:{CRM_CORE:true,TASKS:true},limitsJson:{USERS:7,STORAGE_GB:4},monthlyPriceMinor:12345}});
    await db.tenantPlan.create({data:{tenantId:tenant.id,planId:oldPlan.id,status:'active',amountMinor:12345,featuresSnapshotJson:{},limitsSnapshotJson:{}}});
    await db.$transaction(tx=>syncPricingCatalog(tx));
    const access = await getEntitlements(db,tenant.id);
    assert.equal(access.limits.USERS,7); assert.equal(access.entitlements.IMPORT,true); assert.equal(access.entitlements.FILE_STORAGE,true);
    assert.equal(access.snapshot.amountMinor,12345); assert.equal(await db.tenantUsage.findUnique({where:{tenantId:tenant.id}}),null);
    assert.equal((await db.plan.findUniqueOrThrow({where:{code:'CRM_START'}})).monthlyPriceMinor,14900);
  });
  it('preserves legacy and uses backend price, compatible recommendations, immutable snapshots', async () => {
    const legacy = await db.tenant.create({data:{name:'Legacy',slug:`legacy-${Date.now()}`}});
    assert.equal((await getEntitlements(db,legacy.id)).snapshot.grandfathered,true);
    const quote = await quoteSubscription(db,{planCode:'SALES',addOns:[{code:'ADDON_USER',qty:2},{code:'ADDON_WHATSAPP',qty:1}]});
    assert.equal(quote.baseAmountMinor,49900); assert.equal(quote.finalAmountMinor,67600); assert.equal(quote.limits.USERS,12);
    assert.equal(quote.recommendation,null);
    const expensive = await quoteSubscription(db,{planCode:'SALES',addOns:[{code:'ADDON_AI_PACK',qty:3}]});
    assert.equal(expensive.recommendation?.code,'FULL');
    await assert.rejects(quoteSubscription(db,{planCode:'ADDON_USER'}));
    await assert.rejects(quoteSubscription(db,{planCode:'BASQAR_FREE',addOns:[{code:'ADDON_USER'}]}));
    await assert.rejects(quoteSubscription(db,{planCode:'CRM_START',addOns:[{code:'ADDON_AI_PACK'}]}));
    await assert.rejects(quoteSubscription(db,{planCode:'CRM_START',addOns:[{code:'ADDON_USER',qty:1.5}]}));
    const tenant = await freeTenant();
    await activateSubscription(db,{tenantId:tenant.id,planCode:'SALES',approvedSnapshot:quote.snapshot,amountMinor:quote.finalAmountMinor});
    await db.plan.update({where:{code:'SALES'},data:{monthlyPriceMinor:999999,limitsJson:{USERS:1}}});
    assert.equal((await getEntitlements(db,tenant.id)).limits.USERS,12);
    assert.equal((await getEntitlements(db,tenant.id)).snapshot.amountMinor,67600);
    assert.ok((await freeMetrics(db)).freeToCrmAi > 0);
  });
});
