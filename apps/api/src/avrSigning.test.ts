import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createPrismaClient } from "@creolab/db";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";
import { createApp } from "./app.ts";
import { makeTestCms } from "./testCms.ts";
import { startTestKalkan } from "./testKalkan.ts";
import { resolveUploadPath } from "./lib/storage.ts";

describe("AVR signing in BasQar", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let verifier: Awaited<ReturnType<typeof startTestKalkan>>;
  let base = "", cookie = "", otherCookie = "", id = "", dealId = "", buyerToken = "", original: Buffer;
  async function json(path: string, method = "GET", data?: unknown, session = cookie) {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(session ? { cookie: session } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body, response };
  }
  const route = (action: string) => `/api/v1/electronic-documents/${id}/${action}`;
  const publicRoute = (action = "") => `/public/avr-sign/${buyerToken}${action ? "/" + action : ""}`;
  before(async () => {
    verifier = await startTestKalkan();
    prisma = await createPrismaClient();
    await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
    await new Promise<void>(resolve => { server = createApp(prisma).listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
    for (const email of ["owner@creolab.example", "owner@demo-agency.example"]) {
      const r = await json("/api/v1/auth/login", "POST", { email, password: process.env.SEED_PASSWORD, client: "web" }, "");
      assert.equal(r.status, 200);
      if (email.includes("creolab")) cookie = r.response.headers.get("set-cookie")!;
      else otherCookie = r.response.headers.get("set-cookie")!;
    }
    assert.equal((await json("/api/v1/settings/legal-profile", "PATCH", { contractSigningEnabled: true }, otherCookie)).status, 200);
    const profile = await json("/api/v1/settings/legal-profile", "PATCH", { legalName: "ТОО Исполнитель", bin: "123456789013", legalAddress: "г. Алматы", directorName: "Иванов Иван", defaultVatMode: "none", defaultVatRate: 0, contractSigningEnabled: true });
    assert.equal(profile.status, 200);
    const contact = await json("/api/v1/contacts", "POST", { name: "Заказчик АВР", phone: "+77015550198" });
    const company = await json("/api/v1/companies", "POST", { name: "ТОО Заказчик", legalName: "ТОО Заказчик", bin: "222222222220", legalAddress: "г. Астана", forceCreate: true });
    const deal = await json("/api/v1/deals", "POST", { title: "Подписание АВР", contactId: contact.body.client?.id || contact.body.id, companyId: company.body.id, items: [{ name: "Дизайн презентации", quantity: 1, unitPrice: 120000 }] });
    assert.equal(deal.status, 201, JSON.stringify(deal.body));
    dealId = deal.body.deal.id;
    const draft = await json(`/api/v1/deals/${dealId}/electronic-documents`, "POST", { type: "AVR" });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    id = draft.body.document.id;
    const valid = await json(route("validate"), "POST", {});
    assert.equal(valid.status, 200, JSON.stringify(valid.body));
  });
  after(async () => { server?.close(); await verifier?.close(); });

  it("rejects wrong parties and enforces tenant and authentication before freezing", async () => {
    const d = await prisma.electronicDocument.findUniqueOrThrow({ where: { id } });
    const source = d.sourceDataJson as any;
    await prisma.electronicDocument.update({ where: { id }, data: { sourceDataJson: { ...source, buyer: { ...source.buyer, bin: source.seller.bin } } } });
    const bad = await json(route("prepare-seller-sign"), "POST");
    assert.equal(bad.status, 422); assert.equal(bad.body.code, "same_parties");
    await prisma.electronicDocument.update({ where: { id }, data: { sourceDataJson: source } });
    assert.equal((await json(route("prepare-seller-sign"), "POST", undefined, otherCookie)).status, 404);
    assert.equal((await json(route("prepare-seller-sign"), "POST", undefined, "")).status, 401);
    assert.equal((await json(route("signing"), "GET", undefined, otherCookie)).status, 404);
  });
  it("freezes one PDF for parallel preparation and protects against edits and ESF submission", async () => {
    for (const r of await Promise.all([1,2].map(() => json(route("prepare-seller-sign"), "POST")))) {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.status, "PENDING_SIGNATURE"); assert.equal(r.body.signUrl, undefined);
    }
    assert.equal(await prisma.avrSigning.count({ where: { documentId: id } }), 1);
    const pdf = await fetch(base + route("signing-pdf"), { headers: { cookie } });
    assert.equal(pdf.status, 200); original = Buffer.from(await pdf.arrayBuffer());
    assert.equal(original.subarray(0,5).toString(), "%PDF-");
    assert.deepEqual(Buffer.from(await (await fetch(base + route("pdf"), { headers: { cookie } })).arrayBuffer()), original);
    assert.equal((await json(route("send-to-buyer"), "POST")).body.code, "seller_must_sign_first");
    assert.equal((await json(route("signed-zip"))).status, 409);
    const edit = await json(`/api/v1/electronic-documents/${id}`, "PATCH", { documentDate: "2026-09-25", items: [{ name: "Changed", quantity: 1, unit: "796", unitPrice: 1, vatRate: 0 }] });
    assert.equal(edit.status, 409, JSON.stringify(edit.body));
    assert.equal((await json(route("validate"), "POST")).status, 422);
    assert.equal((await json(route("esf-payload"), "POST")).body.code, "avr_signing_mode");
    const reused = await json(`/api/v1/deals/${dealId}/electronic-documents`, "POST", { type: "AVR" });
    assert.equal(reused.body.document.id, id);
  });
  it("rejects another company, expired certificates and signatures for altered bytes", async () => {
    for (const cmsBase64 of [
      makeTestCms(original, { bin: "222222222220" }),
      makeTestCms(original, { expired: true }),
      makeTestCms(Buffer.concat([original, Buffer.from("altered")])),
    ]) {
      const result = await json(route("sign"), "POST", { cmsBase64 });
      assert.equal(result.status, 422, JSON.stringify(result.body));
      assert.equal(result.body.code, "signature_invalid");
    }
    assert.equal((await prisma.avrSigning.findUniqueOrThrow({ where: { documentId: id } })).sellerSignature, null);
  });
  it("fails closed when signing is disabled or cryptographic verification is unavailable", async () => {
    const cmsBase64 = makeTestCms(original);
    await json("/api/v1/settings/legal-profile", "PATCH", { contractSigningEnabled: false });
    assert.equal((await json(route("sign"), "POST", { cmsBase64 })).status, 403);
    await json("/api/v1/settings/legal-profile", "PATCH", { contractSigningEnabled: true });
    const previous = process.env.KALKAN_VERIFY_URL;
    try {
      process.env.KALKAN_VERIFY_URL = "";
      const denied = await json(route("sign"), "POST", { cmsBase64 });
      assert.equal(denied.status, 503, JSON.stringify(denied.body));
      assert.equal(denied.body.code, "signature_verification_unavailable");
      assert.equal((await prisma.avrSigning.findUniqueOrThrow({ where: { documentId: id } })).sellerSignature, null);
    } finally { process.env.KALKAN_VERIFY_URL = previous; }
  });
  it("accepts seller once even on parallel requests; makes a separate buyer link", async () => {
    const cmsBase64 = `-----BEGIN CMS-----\n${makeTestCms(original)}\n-----END CMS-----`;
    const results = await Promise.all([1,2].map(() => json(route("sign"), "POST", { cmsBase64 })));
    assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
    assert.equal((await json(route("signing"))).body.status, "PARTIALLY_SIGNED");
    const sent = await json(route("send-to-buyer"), "POST");
    assert.equal(sent.status, 200, JSON.stringify(sent.body)); buyerToken = sent.body.signUrl.split("/sign/avr/")[1];
    assert.ok(buyerToken);
    const saved = await prisma.avrSigning.findUniqueOrThrow({ where: { documentId: id } });
    assert.notEqual(saved.buyerTokenHash, buyerToken);
    assert.equal(saved.buyerTokenHash, createHash("sha256").update(buyerToken).digest("hex"));
  });
  it("handles decline, expiry, rotated links and unsigned archive access", async () => {
    assert.equal((await json(publicRoute("signed-zip"), "GET", undefined, "")).status, 409);
    assert.equal((await json(publicRoute("decline"), "POST", { reason: "Уточните акт" }, "")).status, 200);
    assert.equal((await json(publicRoute(), "GET", undefined, "")).body.canSign, false);
    const denied = await json(publicRoute("sign"), "POST", { cmsBase64: makeTestCms(original, { bin: "222222222220" }) }, "");
    assert.equal(denied.status, 409);
    const oldToken = buyerToken;
    const newLink = await json(route("send-to-buyer"), "POST");
    buyerToken = newLink.body.signUrl.split("/sign/avr/")[1];
    assert.equal((await json(`/public/avr-sign/${oldToken}/pdf`, "GET", undefined, "")).status, 404);
    await prisma.avrSigning.update({ where: { documentId: id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await json(publicRoute(), "GET", undefined, "")).status, 410);
    assert.equal((await json(publicRoute("pdf"), "GET", undefined, "")).status, 410);
    const refreshed = await json(route("send-to-buyer"), "POST"); buyerToken = refreshed.body.signUrl.split("/sign/avr/")[1];
  });
  it("allows a buyer without account, checks the fixed PDF and rejects tampering", async () => {
    const accounts = await prisma.user.count(), memberships = await prisma.membership.count();
    const publicView = await json(publicRoute(), "GET", undefined, "");
    assert.equal(publicView.status, 200); assert.equal(publicView.body.canSign, true);
    const pdf = await fetch(base + publicRoute("pdf")); assert.equal(pdf.status, 200);
    assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), original);
    const row = await prisma.avrSigning.findUniqueOrThrow({ where: { documentId: id } });
    const attachment = await prisma.attachment.findUniqueOrThrow({ where: { id: row.originalFileId } });
    const abs = resolveUploadPath(attachment.storageKey);
    const cmsBase64 = makeTestCms(original, { bin: "222222222220", iin: "222222222220" });
    try {
      await writeFile(abs, Buffer.concat([original, Buffer.from("tamper")]));
      const denied = await json(publicRoute("sign"), "POST", { cmsBase64 }, "");
      assert.equal(denied.status, 409); assert.equal(denied.body.code, "DOCUMENT_CHANGED");
    } finally { await writeFile(abs, original); }
    // Changing the customer's live card must not change the signed version or expected signer.
    const doc = await prisma.electronicDocument.findUniqueOrThrow({ where: { id } });
    await prisma.company.update({ where: { id: doc.companyId! }, data: { bin: "333333333330", legalName: "Changed live card" } });
    assert.equal((await json(publicRoute(), "GET", undefined, "")).body.buyerName, "ТОО Заказчик");
    const results = await Promise.all([1,2].map(() => json(publicRoute("sign"), "POST", { cmsBase64 }, "")));
    assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
    assert.equal((await json(publicRoute(), "GET", undefined, "")).body.canSign, false);
    assert.equal((await json(route("signing"))).body.status, "SIGNED");
    assert.equal(await prisma.user.count(), accounts); assert.equal(await prisma.membership.count(), memberships);
    assert.equal(await prisma.auditEvent.count({ where: { action: "avr.signed", entityId: id } }), 1);
    assert.equal((await json(route("esf-payload"), "POST")).body.code, "avr_signing_mode");
  });
  it("exports original and both real CMS signatures, with a separate receipt and public masked verification", async () => {
    const registry = await json("/api/v1/documents?kind=AVR&status=SIGNED");
    assert.ok(registry.body.items.some((item: any) => item.id === id));
    const context = await json(`/api/v1/deals/${dealId}/avr-context`);
    assert.equal(context.body.documentState.code, "AVR_SIGNED");
    const row = await prisma.avrSigning.findUniqueOrThrow({ where: { documentId: id } });
    const verify = await json(`/public/avr-verify/${row.verificationPublicId}`, "GET", undefined, "");
    assert.equal(verify.body.status, "SIGNED"); assert.equal(verify.body.documentType, "AVR");
    assert.equal(verify.body.signers.length, 2); assert.equal(verify.body.documentHash, row.documentHash);
    assert.equal(verify.body.tenantId, undefined); assert.equal(verify.body.buyerTokenHash, undefined);
    assert.ok(verify.body.signers.every((s: any) => !s.iin || /^•+\d{4}$/.test(s.iin)));
    for (const external of [false,true]) {
      const response = await fetch(base + (external ? publicRoute("signed-zip") : route("signed-zip")), { headers: external ? {} : { cookie } });
      assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /no-store/);
      const zip = await JSZip.loadAsync(await response.arrayBuffer());
      assert.deepEqual(await zip.file("original.pdf")!.async("nodebuffer"), original);
      const manifest = JSON.parse(await zip.file("verification.json")!.async("string"));
      assert.equal(manifest.documentLabel, "АВР");
      const scratch = resolveUploadPath(`avr-qa-${external}`); await mkdir(scratch, { recursive: true });
      for (const name of ["original.pdf", "seller.p7s", "buyer.p7s"]) {
        const bytes = await zip.file(name)!.async("nodebuffer");
        assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.files.find((f: any) => f.name === name).sha256);
        await writeFile(`${scratch}/${name}`, bytes);
      }
      for (const role of ["seller","buyer"]) await promisify(execFile)("openssl", ["cms", "-verify", "-noverify", "-binary", "-inform", "DER", "-in", `${scratch}/${role}.p7s`, "-content", `${scratch}/original.pdf`, "-out", `${scratch}/verified.pdf`]);
      const visual = await PDFDocument.load(await zip.file("signed-view.pdf")!.async("nodebuffer"));
      assert.ok(visual.getPageCount() > (await PDFDocument.load(original)).getPageCount());
      assert.match(visual.getTitle()!, /^АВР /);
      if (process.env.SIGNED_EXPORT_QA_DIR) {
        await mkdir(process.env.SIGNED_EXPORT_QA_DIR, { recursive: true });
        for (const name of ["signed-view.pdf", "signing-receipt.pdf"]) await writeFile(`${process.env.SIGNED_EXPORT_QA_DIR}/avr-${name}`, await zip.file(name)!.async("nodebuffer"));
      }
    }
    assert.equal((await fetch(base + publicRoute("signed-pdf"))).status, 200);
    assert.equal((await json(route("signed-zip"), "GET", undefined, "")).status, 401);
    assert.equal((await json(route("signed-zip"), "GET", undefined, otherCookie)).status, 404);
    const sig = row.buyerSignature as any;
    try {
      await prisma.avrSigning.update({ where: { id: row.id }, data: { buyerSignature: { ...sig, verificationDetails: { ...sig.verificationDetails, authority: "UNCHECKED" } } } });
      assert.equal((await json(publicRoute("signed-zip"), "GET", undefined, "")).status, 409);
    } finally { await prisma.avrSigning.update({ where: { id: row.id }, data: { buyerSignature: sig } }); }
    const file = await prisma.attachment.findUniqueOrThrow({ where: { id: sig.fileId } });
    const bytes = await readFile(resolveUploadPath(file.storageKey));
    try {
      await writeFile(resolveUploadPath(file.storageKey), Buffer.from("corrupt"));
      assert.equal((await json(publicRoute("signed-zip"), "GET", undefined, "")).status, 409);
    } finally { await writeFile(resolveUploadPath(file.storageKey), bytes); }
    // Completed recipients keep their archive even after the original signing window.
    await prisma.avrSigning.update({ where: { id: row.id }, data: { expiresAt: new Date(0) } });
    assert.equal((await fetch(base + publicRoute("signed-zip"))).status, 200);
  });
});
