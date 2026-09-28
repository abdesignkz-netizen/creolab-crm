import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { getLegalBundle, legalProfile, legalReleaseIssues, renderLegalDocument, validateLegalAcceptance, recordRegistrationAcceptance } from "./services/legalDocuments.ts";
import { ApiError } from "./errors.ts";

const approved = () => ({ ...structuredClone(legalProfile), effectiveDate: "2026-01-01", hosting: "Test infrastructure", processors: "Test recipients", release: { approved: true, emailVerified: true, storageKzVerified: true, processorsReviewed: true, retentionOperational: true, securityReviewed: true } });
const acceptance = (revision: string) => ({ revision, offerAccepted: true, personalDataAccepted: true, authorizedRepresentative: true });

describe("legal documents and evidence", () => {
  it("keeps incomplete publication in draft and fails explicit activation", () => {
    const profile = approved(); profile.release.storageKzVerified = false;
    assert.ok(legalReleaseIssues(profile).includes("release.storageKzVerified"));
    assert.equal(getLegalBundle(profile, false).active, false);
    assert.throws(() => getLegalBundle(profile, true), /storageKzVerified/);
    assert.match(renderLegalDocument(getLegalBundle(profile, false), "offer")!, /Проект для согласования/);
    assert.match(renderLegalDocument(getLegalBundle(profile, false), "offer")!, /noindex,nofollow/);
  });
  it("requires a valid effective date that is not in the future", () => {
    for (const effectiveDate of ["", "bad", "2026-02-31", "2999-01-01"]) {
      assert.ok(legalReleaseIssues({ ...approved(), effectiveDate }).includes("profile.effectiveDate.valid"));
    }
  });
  it("renders initial HTML safely, only for known documents", () => {
    const profile = approved(); profile.companyName = '<script>alert("x")</script>';
    const html = renderLegalDocument(getLegalBundle(profile, true), "offer")!;
    assert.match(html, /<title>Публичная оферта — BasQar<\/title>/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>|Проект для согласования|\{\{/);
    assert.match(html, /name="viewport"/);
    assert.equal(renderLegalDocument(getLegalBundle(profile, true), "../profile.json"), null);
  });
  it("hashes actual content and rejects absent, partial and stale acceptance", () => {
    const bundle = getLegalBundle(approved(), true);
    for (const doc of bundle.documents) assert.equal(doc.sha256, createHash("sha256").update(doc.text).digest("hex"));
    assert.doesNotThrow(() => validateLegalAcceptance(acceptance(bundle.revision), bundle));
    for (const input of [undefined, { ...acceptance(bundle.revision), offerAccepted: false }, { ...acceptance(bundle.revision), personalDataAccepted: false }, { ...acceptance(bundle.revision), authorizedRepresentative: false }]) {
      assert.throws(() => validateLegalAcceptance(input, bundle), (error: unknown) => error instanceof ApiError && error.code === "legal_consent_required");
    }
    const changed = getLegalBundle({ ...approved(), address: "Changed address" }, true);
    assert.notEqual(changed.revision, bundle.revision);
    assert.throws(() => validateLegalAcceptance(acceptance(bundle.revision), changed), (error: unknown) => error instanceof ApiError && error.code === "legal_revision_changed");
    assert.doesNotThrow(() => validateLegalAcceptance(undefined, getLegalBundle(approved(), false)));
  });
  it("records complete snapshots without credentials and propagates write failures", async () => {
    const bundle = getLegalBundle(approved(), true);
    let record: any;
    const tx = { auditEvent: { create: async (input: any) => { record = input; } } } as any;
    await recordRegistrationAcceptance(tx, "pending-test", bundle, { name: "Test Name", email: "test@example.test", companyName: "Test Company" });
    assert.equal(record.data.action, "legal.registration_accepted");
    assert.equal(record.data.changesJson.revision, bundle.revision);
    assert.deepEqual(record.data.changesJson.documents, bundle.documents);
    assert.equal(record.data.changesJson.identityVerified, false);
    assert.equal(record.data.changesJson.subject.email, "test@example.test");
    assert.equal(Object.hasOwn(record.data.changesJson, "password"), false);
    await assert.rejects(recordRegistrationAcceptance({ auditEvent: { create: async () => { throw new Error("audit unavailable"); } } } as any, "pending", bundle, { name: "Test", email: "test@example.test", companyName: "Test" }), /audit unavailable/);
    record = undefined;
    await recordRegistrationAcceptance(tx, "pending", { ...bundle, active: false }, { name: "Test", email: "test@example.test", companyName: "Test" });
    assert.equal(record, undefined);
  });
});
