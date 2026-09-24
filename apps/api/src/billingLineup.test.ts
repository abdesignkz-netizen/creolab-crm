import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createPrismaClient, syncPricingCatalog } from "@creolab/db";
import { CATALOG_BY_CODE, LEGACY_CATALOG_CODES } from "@creolab/contracts";
import { quoteSubscription, quoteRenewal, loadPublicCatalog } from "./services/pricingEngine.ts";
import { getEntitlements, matchPaidFeatures, matchAlternativeFeatures } from "./services/entitlementService.ts";
import { activateSubscription } from "./services/subscriptionActivationService.ts";
import { processNewRequestAutomation } from "./services/requestAutomationService.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>;
let sequence = 0;
async function tenant() {
  return db.tenant.create({ data: { name: "Lineup test", slug: `lineup-${Date.now()}-${sequence++}` } });
}

describe("BasQar v3 product access, resources and legacy agreements", () => {
  before(async () => { db = await createPrismaClient(); await syncPricingCatalog(db); });

  it("publishes five fixed-price tiers and separate Enterprise, with exact quotas", async () => {
    const catalog = await loadPublicCatalog(db);
    assert.deepEqual(catalog.filter(item => item.kind !== "addon").map(item => item.code).sort(), ["BASQAR_FREE", "CRM_START", "CONTROL", "SALES", "FULL", "CRM_ENTERPRISE"].sort());
    const expectations = [
      ["BASQAR_FREE",0,1,50,20,50,100,250,0,0],
      ["CRM_START",14900,3,1000,300,1000,500,5120,0,0],
      ["CONTROL",29900,5,5000,1000,3000,1024,10240,1000,1],
      ["SALES",49900,10,15000,3000,10000,3072,15360,3000,2],
      ["FULL",69900,20,50000,10000,30000,10240,30720,8000,4],
    ] as const;
    for (const [code,price,...values] of expectations) {
      const quote = await quoteSubscription(db,{planCode:code});
      assert.equal(quote.finalAmountMinor,price);
      assert.equal((await quoteSubscription(db,{planCode:code,billingPeriod:"YEARLY"})).finalAmountMinor,price*10);
      ["USERS","CLIENTS","ACTIVE_DEALS","MONTHLY_LEADS","DATABASE_MB","FILE_STORAGE_MB","AI_USAGE","WHATSAPP_CONNECTIONS"].forEach((key,index) => assert.equal(quote.limits[key],values[index],`${code} ${key}`));
      assert.equal(quote.limits.PIPELINES,1);
      const index=expectations.findIndex(row=>row[0]===code);
      for (const key of ["CLIENTS","COMPANIES","LEADS","DEALS","TASKS"] as const) assert.equal(quote.features[key],true);
      assert.equal(quote.features.IMPORT,index>=1);
      assert.equal(quote.features.SUPPORT,index>=1);
      assert.equal(quote.features.DOCUMENTS,index>=2);
      assert.equal(quote.features.AI_CONTROL,index>=2);
      assert.equal(quote.features.AI_MANAGER,index>=3);
      assert.equal(quote.features.MASS_MESSAGING,index>=3);
      assert.equal(quote.features.CONTROL_BULK,index===4);
      assert.equal(quote.features.ADVANCED_AUTOMATION,index===4);
    }
  });

  it("adds resource capacity exactly once without enabling a product feature", async () => {
    for (const [code,addon,qty,key,cap] of [
      ["CRM_START","ADDON_USER",2,"USERS",5], ["CONTROL","ADDON_AI_PACK",2,"AI_USAGE",3000],
      ["SALES","ADDON_WHATSAPP",1,"WHATSAPP_CONNECTIONS",3], ["FULL","ADDON_STORAGE_10GB",1,"FILE_STORAGE_MB",40960],
    ] as const) {
      const base=await quoteSubscription(db,{planCode:code});
      const quote=await quoteSubscription(db,{planCode:code,addOns:[{code:addon,qty}]});
      assert.deepEqual(quote.features,base.features);
      assert.equal(quote.limits[key],cap);
      const company=await tenant();
      await activateSubscription(db,{tenantId:company.id,planCode:code,approvedSnapshot:quote.snapshot});
      const access=await getEntitlements(db,company.id);
      assert.equal(access.limits[key],cap);
      assert.equal((await db.tenantUsage.findUniqueOrThrow({where:{tenantId:company.id}})).limitsJson[key],cap);
      if (code==="CONTROL") assert.equal(access.entitlements.AI_MANAGER,false);
    }
    for (const addon of ["ADDON_USER","ADDON_AI_PACK","ADDON_WHATSAPP","ADDON_STORAGE_10GB"]) await assert.rejects(quoteSubscription(db,{planCode:"BASQAR_FREE",addOns:[{code:addon}]}));
    await assert.rejects(quoteSubscription(db,{addOns:[{code:"ADDON_USER"}]}));
    await assert.rejects(quoteSubscription(db,{planCode:"CRM_START",addOns:[{code:"ADDON_WHATSAPP"}]}));
    const integration=await quoteSubscription(db,{planCode:"CRM_START",addOns:[{code:"ADDON_INTEGRATION"}]});
    assert.equal(integration.features.CHANNELS,false);
    assert.equal(integration.lines[1].chargeType,"ONE_TIME");
  });

  it("retains legacy plan IDs, modules, prices and entitlements on renewal", async () => {
    for (const code of [...LEGACY_CATALOG_CODES.filter(code=>!code.startsWith("ADDON_")),"CRM_ENTERPRISE"]) {
      const company=await tenant(); const plan=await db.plan.findUniqueOrThrow({where:{code}});
      const features={...plan.featuresJson as object,AI_MANAGER:true,AI_CONTROL:true};
      await db.tenantPlan.create({data:{tenantId:company.id,planId:plan.id,status:"active",amountMinor:12345,featuresSnapshotJson:features,limitsSnapshotJson:{USERS:7,AI_USAGE:1234},itemsJson:[{code:"ADDON_AI_BUSINESS",qty:1}],priceSnapshotJson:{planVersion:2}}});
      const before=await getEntitlements(db,company.id);
      const quote=await quoteRenewal(db,company.id,code,"MONTHLY");
      assert.equal(quote.finalAmountMinor,12345);assert.equal(quote.limits.USERS,7);
      assert.equal(quote.features.AI_MANAGER,true);assert.equal(quote.features.CONTROL_BULK,true);
      await activateSubscription(db,{tenantId:company.id,planCode:code,approvedSnapshot:quote.snapshot});
      const after=await getEntitlements(db,company.id);
      assert.equal(after.snapshot.planId,before.snapshot.planId);
      assert.deepEqual(after.entitlements,before.entitlements);
      assert.equal(after.snapshot.amountMinor,12345);
      if(code!=="CRM_ENTERPRISE")await assert.rejects(quoteSubscription(db,{planCode:code}));
    }
  });

  it("applies explicit overrides while suspension still denies access", async () => {
    const company=await tenant();await activateSubscription(db,{tenantId:company.id,planCode:"CONTROL"});
    await db.tenantBillingOverride.create({data:{tenantId:company.id,featuresJson:{DOCUMENTS:false,AI_MANAGER:true},limitsJson:{USERS:42,AI_USAGE:5000}}});
    const access=await getEntitlements(db,company.id);
    assert.equal(access.entitlements.DOCUMENTS,false);assert.equal(access.entitlements.AI_MANAGER,true);assert.equal(access.limits.USERS,42);
    await db.tenantPlan.updateMany({where:{tenantId:company.id},data:{status:"suspended"}});
    assert.equal((await getEntitlements(db,company.id)).entitlements.AI_MANAGER,false);
  });

  it("guards read and write APIs and blocks background Sales work on Control", async () => {
    for(const method of ["GET","POST","PATCH","DELETE"]) {
      assert.ok(matchPaidFeatures(method,"/api/v1/support/tickets").includes("SUPPORT"));
      assert.ok(matchPaidFeatures(method,"/api/v1/documents").includes("DOCUMENTS"));
      assert.ok(matchPaidFeatures(method,"/api/v1/campaigns").includes("MASS_MESSAGING"));
    }
    assert.ok(matchAlternativeFeatures("POST","/api/v1/situation/ask").includes("AI_CONTROL"));
    assert.deepEqual(matchPaidFeatures("POST","/api/v1/tasks"),[]);
    const company=await tenant();await activateSubscription(db,{tenantId:company.id,planCode:"CONTROL"});
    assert.equal(await processNewRequestAutomation(db,company.id,"missing"),null);
  });
});
