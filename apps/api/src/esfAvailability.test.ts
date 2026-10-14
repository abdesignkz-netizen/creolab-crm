import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { getEffectiveTenantSettings } from "./services/runtimeSettings.ts";
import { isEsfEnabled, requireEsfEnabled } from "./services/esfAvailability.ts";
import { processEsfStatusPollAction, ensureEsfStatusPolls } from "./services/esfStatusSyncService.ts";
import { withIdempotency } from "./services/idempotency.ts";

describe("global IS ESF availability", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base = "", admin = "", owner = "", other = "", tenantId = "", dealId = "", esfId = "", avrId = "";
  async function request(cookie: string, path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + "/api/v1" + path, { method, headers: { cookie, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json(), cookie: res.headers.get("set-cookie") || "" };
  }
  const toggle = (enabled: boolean) => request(admin, "/admin/settings", "PATCH", { features: { esf: enabled } });
  before(async () => {
    db = await createPrismaClient();
    await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
    server = createApp(db).listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = async (email: string) => (await request("", "/auth/login", "POST", { email, password: process.env.SEED_PASSWORD, client: "web" })).cookie;
    admin = await login("platform@creolab.example"); owner = await login("owner@creolab.example"); other = await login("owner@demo-agency.example");
    tenantId = (await db.tenant.findFirstOrThrow({ where: { slug: "creolab" } })).id;
    const contact = await db.contact.create({ data: { tenantId, name: "Availability test" } });
    const stage = await db.dealStage.findFirstOrThrow({ where: { tenantId } });
    dealId = (await db.deal.create({ data: { tenantId, contactId: contact.id, stageId: stage.id, title: "Local documents" } })).id;
    for (const type of ["AVR", "ESF"]) {
      const doc = await db.electronicDocument.create({ data: { tenantId, dealId, type, number: `GATE-${type}`, amountWithoutVat: 100, vatAmount: 0, totalAmount: 100, ...(type === "AVR" ? { status: "SENT", externalId: "external-gate", externalSystem: "ESF_AWP" } : {}) } });
      if (type === "ESF") esfId = doc.id; else avrId = doc.id;
    }
  });
  after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  it("is off by default; only platform admin can change it with a boolean", async () => {
    assert.equal(await isEsfEnabled(db), false);
    assert.equal((await request(owner, "/admin/settings", "PATCH", { features: { esf: true } })).status, 403);
    assert.equal((await request(admin, "/admin/settings", "PATCH", { features: { esf: "false" } })).status, 422);
    assert.equal((await request(owner, "/me")).data.serviceFeatures.esf, false);
    assert.equal((await toggle(true)).status, 200);
    for (const cookie of [owner, other]) assert.equal((await request(cookie, "/service-features")).data.esf, true);
  });

  it("cannot be overridden by a company or stale process cache", async () => {
    await db.tenant.update({ where: { id: tenantId }, data: { settingsJson: { features: { esf: true } } } });
    await db.tenantLegalProfile.upsert({ where: { tenantId }, create: { tenantId, esfIntegrationEnabled: true }, update: { esfIntegrationEnabled: true } });
    assert.equal((await getEffectiveTenantSettings(db, tenantId)).features.esf.value, true);
    // Simulate another API instance writing the flag without invalidating this process's cache.
    const row = await db.platformSetting.findUniqueOrThrow({ where: { key: "defaults" } });
    const value = row.valueJson as any;
    await db.platformSetting.update({ where: { key: "defaults" }, data: { valueJson: { ...value, features: { ...value.features, esf: false } } } });
    assert.equal((await getEffectiveTenantSettings(db, tenantId)).features.esf.value, false);
    assert.equal((await request(admin, "/admin/settings")).data.features.esf, false);
    await assert.rejects(requireEsfEnabled(db), (e: any) => e.status === 404);
    for (const cookie of [owner, other]) assert.equal((await request(cookie, "/service-features")).data.esf, false);
  });

  it("blocks every portal route and ESF draft/validation while ordinary AVR stays accessible", async () => {
    const paths: Array<[string, string, unknown?]> = [
      ["GET", "/settings/esf-preflight"], ["GET", "/integrations/esf"],
      ...["auth-ticket", "connect", "disconnect", "ncalayer-poc/legacy-sign", "ncalayer-poc/avr-payload", "ncalayer-poc/avr-send"].map(p => ["POST", `/integrations/esf/${p}`, {}] as [string, string, unknown]),
      ["GET", "/integrations/esf/ncalayer-poc"], ["GET", `/deals/${dealId}/esf-invoice-readiness`], ["POST", `/deals/${dealId}/esf-sync`],
      ...["esf-preview", "esf-payload", "esf-send", "esf-send-signed", "esf-refresh"].map(p => ["POST", `/electronic-documents/${avrId}/${p}`, {}] as [string, string, unknown]),
      ["GET", `/electronic-documents/${esfId}`], ["POST", `/electronic-documents/${esfId}/validate`],
      ["POST", `/deals/${dealId}/electronic-documents`, { type: "ESF" }],
    ];
    for (const [method, path, body] of paths) {
      const result = await request(owner, path, method, body);
      assert.equal(result.status, 404, `${method} ${path}: ${JSON.stringify(result.data)}`);
      assert.doesNotMatch(JSON.stringify(result.data), /ЭСФ|ESF/);
    }
    assert.equal((await request(owner, `/electronic-documents/${avrId}`)).status, 200);
    const avrReadiness = await request(owner, `/deals/${dealId}/avr-readiness`);
    assert.equal(avrReadiness.status, 200);
    assert.doesNotMatch(JSON.stringify(avrReadiness.data.warnings), /ЭСФ|ESF/);
    const list = await request(owner, "/documents");
    assert.equal(list.status, 200);
    assert.ok(list.data.items.some((i: any) => i.id === avrId));
    assert.ok(!list.data.items.some((i: any) => i.kind === "ESF"));
    assert.equal((await request(owner, `/deals/${dealId}/close-readiness`)).data.ready, true);
    const help = await request(owner, "/support/articles?q=ЭСФ");
    assert.equal(help.status, 200);
    assert.doesNotMatch(JSON.stringify(help.data.items), /ЭСФ|ИС ЭСФ/);
    assert.ok(!help.data.categories.some((c: any) => c.id === "esf"));
    assert.equal((await request(owner, "/support/articles/connect-esf")).status, 404);
    const numbering = await request(owner, "/settings/document-numbering");
    assert.ok(numbering.data.AVR); assert.equal(numbering.data.ESF, undefined);
  });

  it("blocks replay of an old successful ESF creation after disabling", async () => {
    const key = "old-esf-creation";
    await withIdempotency(db, {
      scope: "edoc.create_draft.ESF", actorKey: `${tenantId}:${dealId}`, key,
      payload: { dealId, type: "ESF" }, run: async () => ({ document: { id: esfId, type: "ESF" } }),
    });
    const response = await request(owner, `/deals/${dealId}/electronic-documents`, "POST", { type: "ESF" }, { "idempotency-key": key });
    assert.equal(response.status, 404);
    assert.doesNotMatch(JSON.stringify(response.data), /ЭСФ|ESF/);
  });

  it("defers background portal polling without changing documents, and resumes after enabling", async () => {
    const job = await db.scheduledAction.create({ data: { tenantId, type: "esf_status_poll", parentType: "electronic_document", parentId: avrId, state: "scheduled", dueAt: new Date(), payloadJson: { attempt: 3, documentId: avrId } } });
    assert.equal(await ensureEsfStatusPolls(db), 0);
    assert.deepEqual(await processEsfStatusPollAction(db, job), { skipped: true });
    const deferred = await db.scheduledAction.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(deferred.state, "scheduled"); assert.ok(deferred.dueAt > job.dueAt);
    assert.equal((await db.electronicDocument.findUniqueOrThrow({ where: { id: avrId } })).externalId, "external-gate");
    // Saving unrelated requisites while hidden must not erase connection preferences.
    assert.equal((await request(owner, "/settings/legal-profile", "PATCH", { phone: "+77000000000", esfIntegrationEnabled: false })).status, 200);
    assert.equal((await db.tenantLegalProfile.findUniqueOrThrow({ where: { tenantId } })).esfIntegrationEnabled, true);
    assert.equal((await toggle(true)).status, 200);
    assert.equal((await request(owner, `/electronic-documents/${esfId}`)).status, 200);
    assert.equal((await request(owner, "/integrations/esf")).status, 200);
    assert.equal((await request(owner, "/settings/document-numbering")).data.ESF.start, 1);
    assert.equal((await request(owner, "/documents")).data.items.some((i: any) => i.id === esfId), true);
    const audit = await db.auditEvent.findFirst({ where: { action: "settings.platform_updated" }, orderBy: { createdAt: "desc" } });
    assert.equal((audit?.changesJson as any).esfEnabled, true);
    assert.equal((await request(admin, "/admin/settings", "PATCH", { limits: { members: 21 } })).status, 200);
    assert.equal(await isEsfEnabled(db), true);
  });
});
