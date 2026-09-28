import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createPrismaClient, syncPricingCatalog } from '@creolab/db';
import { activateSubscription } from './services/subscriptionActivationService.ts';
import { getEntitlements } from './services/entitlementService.ts';
import { quoteRenewal, quoteSubscription } from './services/pricingEngine.ts';
import { consumeResource, resourcePeriod } from './services/billingResourceService.ts';
import { getBillingState } from './services/billingService.ts';
import { processNewRequestAutomation } from './services/requestAutomationService.ts';
import { sellerAiAccess } from './services/sellerLink.ts';
import { encryptSecret } from './lib/secretBox.ts';
let db: Awaited<ReturnType<typeof createPrismaClient>>;
let sequence = 0;
async function tenant(planCode: string) {
  const company = await db.tenant.create({data:{name:'AI access test',slug:`ai-access-${Date.now()}-${sequence++}`}});
  await activateSubscription(db,{tenantId:company.id,planCode});
  return company;
}
describe('AI Manager tariff policy', () => {
  before(async () => { db = await createPrismaClient(); await syncPricingCatalog(db); });
  it('denies Start including old snapshots while retaining Control credits, price and limits', async () => {
    const company = await tenant('CRM_START');
    await db.tenantPlan.updateMany({where:{tenantId:company.id},data:{featuresSnapshotJson:{AI_MANAGER:true,ai:true,AI_CONTROL:true,DOCUMENTS:true},priceSnapshotJson:{planVersion:4},amountMinor:12345}});
    const access = await getEntitlements(db,company.id);
    assert.equal(access.entitlements.AI_MANAGER,false);
    assert.equal(access.entitlements.AI_CONTROL,true);
    assert.equal(access.limits.AI_CREDITS,1000);
    assert.equal(access.snapshot.amountMinor,12345);
    assert.equal(await processNewRequestAutomation(db,company.id,'nonexistent'),null);
    const renewed = await quoteRenewal(db,company.id,'CRM_START','MONTHLY');
    assert.equal(renewed.features.AI_MANAGER,false);
    assert.equal(renewed.finalAmountMinor,12345);
    const billing = await getBillingState(db,company.id);
    assert.equal(billing.accessBreakdown.subscriptionFeatures.AI_MANAGER,false);
    const boosted = await quoteSubscription(db,{planCode:'CRM_START',addOns:[{code:'ADDON_AI_PACK'}]});
    assert.equal(boosted.features.AI_MANAGER,false);
    assert.equal(boosted.limits.AI_CREDITS,2000);
  });
  it('preserves explicitly purchased historical modules and individual grants', async () => {
    const company = await tenant('CRM_START');
    await db.tenantPlan.updateMany({where:{tenantId:company.id},data:{itemsJson:[{code:'ADDON_AI_START',qty:1}]}});
    assert.equal((await getEntitlements(db,company.id)).entitlements.AI_MANAGER,true);
    await db.tenantBillingOverride.create({data:{tenantId:company.id,featuresJson:{AI_MANAGER:false}}});
    assert.equal((await getEntitlements(db,company.id)).entitlements.AI_MANAGER,false);
    await db.tenantPlan.updateMany({where:{tenantId:company.id},data:{itemsJson:[]}});
    await db.tenantBillingOverride.update({where:{tenantId:company.id},data:{featuresJson:{AI_MANAGER:true}}});
    assert.equal((await getEntitlements(db,company.id)).entitlements.AI_MANAGER,true);
    await db.tenantPlan.updateMany({where:{tenantId:company.id},data:{status:'suspended'}});
    assert.equal((await getEntitlements(db,company.id)).entitlements.AI_MANAGER,false);
  });
  it('authorizes the external seller by integration and stops Free after its one-time credits', async () => {
    const free = await tenant('BASQAR_FREE');
    const start = await tenant('CRM_START');
    const integrations = [];
    for (const company of [free,start]) integrations.push(await db.integration.create({data:{tenantId:company.id,type:'whatsapp_seller',name:'Test seller',status:'active',schemaJson:{secretEnc:encryptSecret(`test-${company.id}`)}}}));
    const auth = {integrationId:integrations[0].id,secret:`test-${free.id}`};
    await assert.rejects(sellerAiAccess(db,{...auth,secret:'wrong'}));
    await assert.rejects(sellerAiAccess(db,{...auth,integrationId:integrations[1].id}));
    assert.equal((await sellerAiAccess(db,auth)).allowed,true);
    assert.equal((await sellerAiAccess(db,auth)).trial,true);
    assert.equal((await sellerAiAccess(db,{integrationId:integrations[1].id,secret:`test-${start.id}`})).reason,'feature_required');
    await consumeResource(db,free.id,'AI_CREDITS',100,'test-trial');
    assert.equal((await sellerAiAccess(db,auth)).reason,'ai_credits_exhausted');
    assert.equal(await resourcePeriod(db,free.id,'AI_CREDITS',new Date('2030-01-01')),'lifetime');
  });
});
