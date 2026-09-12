import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import type { AuthContext } from "./lib/types.ts";
import { ApiError } from "./errors.ts";
import { ESF_OFFICIAL, assertTestEndpointNotProduction, readEsfConfig, resolveEsfBaseUrl } from "./integrations/esf/EsfConfig.ts";
import { postSoap } from "./integrations/esf/EsfSoap.ts";
import { describeAvrPocReadiness } from "./services/esfConnectionService.ts";
import { officialAvrBody, prepareAvrPocPayload, sendAvrPocSigned, assertPocSignatureCertificate, redactSoapText, sha256Utf8 } from "./services/esfNcaLayerPocService.ts";
import { pemFromCms, publicCertificateFingerprint } from "./services/cmsInspect.ts";
import { makeTestCms } from "./testCms.ts";
import { verifyFrozenAvrPayload, signPlainDataPemFingerprint } from "../../web/src/lib/signing/avrPocPreflight.ts";

const originalCwd = process.cwd();
const fixture = officialAvrBody();
const authPem = pemFromCms(makeTestCms(Buffer.from("AUTH")));
const signPem = pemFromCms(makeTestCms(Buffer.from("SIGN")));
const accepted = '<Envelope><Body><awpUploadResponse><acceptedList><awpUploadResult><awpId>test-external-123</awpId></awpUploadResult></acceptedList></awpUploadResponse></Body></Envelope>';
let scratch: string;
let previousEnv: NodeJS.ProcessEnv;
let row: any;
let requests: Array<{ url: string; body: string }>;
let uploadStatus: number;
let uploadBody: string;
let remoteSession: string;
let transportFailure: boolean;
const prisma = { esfConnection: { findUnique: async () => row } } as unknown as PrismaClient;
const auth = { user: { id: "user", platformAdmin: false }, activeMembership: { tenantId: "tenant", role: "owner" } } as AuthContext;

beforeEach(() => {
  previousEnv = { ...process.env };
  Object.assign(process.env, { NODE_ENV: "test", ESF_ENV: "test", ESF_PROVIDER: "live", ESF_ALLOW_LIVE_SEND: "1", ESF_TLS_INSECURE: "0" });
  scratch = mkdtempSync(path.join(tmpdir(), "avr-poc-guards-"));
  const dest = path.join(scratch, "apps/api/src/integrations/esf/schemas");
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, "One AwpV1.xml"), fixture);
  process.chdir(scratch);
  row = { status: "CONNECTED", sessionId: "private-session-id", sessionExpiresAt: new Date(Date.now() + 60_000), environment: "test", organizationBin: "123456789013", authCertificatePem: authPem };
  requests = [];
  uploadStatus = 200; uploadBody = accepted; remoteSession = "OK"; transportFailure = false;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), body: String(init.body) });
    assert.equal(init.redirect, "error");
    assert.equal(new URL(url).hostname, "test3.esf.kgd.gov.kz");
    if (String(init.body).includes("currentSessionStatusRequest")) return new Response(`<Envelope><status>${remoteSession}</status></Envelope>`);
    if (transportFailure) throw new Error("password=secret-from-transport");
    return new Response(uploadBody, { status: uploadStatus });
  });
});
afterEach(() => {
  mock.restoreAll();
  process.chdir(originalCwd);
  rmSync(scratch, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

async function preparedInput() {
  const prepared = await prepareAvrPocPayload(prisma, auth);
  return { prepared, raw: { signature: Buffer.alloc(64, 7).toString("base64"), pem: signPem, pemFingerprint: publicCertificateFingerprint(signPem), payloadSha256: prepared.payloadSha256, sessionBinding: prepared.sessionBinding } };
}
function uploadRequests() { return requests.filter((request) => request.body.includes("awpUploadRequest")); }
async function rejected(raw: Record<string, unknown>, code: string) {
  await assert.rejects(sendAvrPocSigned(prisma, auth, raw), (error: any) => {
    assert.equal(error.code, code);
    assert.equal(error.details.ok, false);
    assert.ok(error.details.soap);
    assert.doesNotMatch(JSON.stringify(error.details), /BEGIN CERTIFICATE|private-session-id|secret-from-transport/);
    return true;
  });
}

describe("AVR POC preflight, without external SOAP", () => {
  it("pins TEST despite arbitrary, credential-bearing, production and misleading overrides", async () => {
    for (const baseUrl of [ESF_OFFICIAL.prodBaseUrl, "https://esf.gov.kz.:8443/esf-web", "https://prod.kgd.gov.kz/esf-web", "https://test3.esf.kgd.gov.kz.evil.invalid/esf-web", "https://user:password@test3.esf.kgd.gov.kz:8443/esf-web", "http://127.0.0.1:8009/esf-web"]) {
      assert.equal(resolveEsfBaseUrl({ esfEnv: "test", baseUrl, testApiUrl: baseUrl }), ESF_OFFICIAL.testBaseUrl);
      assert.throws(() => assertTestEndpointNotProduction({ esfEnv: "test", baseUrl }));
      await assert.rejects(postSoap(baseUrl, "no request", { testOnly: true }));
    }
    await assert.rejects(postSoap(ESF_OFFICIAL.prodBaseUrl, "no request"));
    assert.equal(requests.length, 0);
    assert.equal(resolveEsfBaseUrl({ esfEnv: "prod" }), ESF_OFFICIAL.prodBaseUrl);
  });

  it("keeps the legacy signing transport callable while TEST-only calls reject other hosts", async () => {
    mock.restoreAll();
    let calls = 0;
    mock.method(globalThis, "fetch", async () => { calls++; return new Response("<signatureResponse/>"); });
    await postSoap("https://legacy-localservice.invalid", "<signatureRequest/>");
    assert.equal(calls, 1);
    await assert.rejects(postSoap("https://legacy-localservice.invalid", "<awpUploadRequest/>", { testOnly: true }));
    assert.equal(calls, 1);
  });

  it("blocks all non-connected, missing, expired, wrong-environment and mock sessions", () => {
    const config = readEsfConfig();
    assert.equal(describeAvrPocReadiness(row, config).ready, true);
    for (const change of [{ status: "ERROR" }, { status: "REAUTH_REQUIRED" }, { sessionId: null }, { sessionExpiresAt: new Date(0) }, { environment: "prod" }, { environment: undefined }]) {
      assert.equal(describeAvrPocReadiness({ ...row, ...change }, config).ready, false);
    }
    assert.equal(describeAvrPocReadiness(null, config).ready, false);
    assert.equal(describeAvrPocReadiness(row, { ...config, esfEnv: "prod" }).ready, false);
    assert.equal(describeAvrPocReadiness(row, { ...config, provider: "mock" }).ready, false);
    assert.equal(describeAvrPocReadiness(row, { ...config, liveSendAllowed: false }).ready, false);
  });

  it("prepares only from session BIN, freezes exact UTF-8 bytes and sends only SIGN PEM", async () => {
    const { prepared, raw } = await preparedInput();
    assert.equal(prepared.senderTin, row.organizationBin);
    assert.equal(prepared.payload.replace(`<tin>${row.organizationBin}</tin>`, "<tin>123456789021</tin>"), fixture.toString("utf8"));
    await verifyFrozenAvrPayload(prepared);
    assert.equal(await signPlainDataPemFingerprint(signPem), raw.pemFingerprint);
    const again = await prepareAvrPocPayload(prisma, auth);
    assert.equal(again.payload, prepared.payload);
    const report = await sendAvrPocSigned(prisma, auth, raw);
    const uploads = uploadRequests();
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].body.match(/<awpBody><!\[CDATA\[([\s\S]*?)\]\]><\/awpBody>/)?.[1], prepared.payload);
    assert.ok(uploads[0].body.includes(signPem.trim()));
    assert.ok(!uploads[0].body.includes(authPem.trim()));
    assert.equal(requests.at(-1), uploads[0]);
    assert.ok(!requests.some((r) => /syncInvoice|queryAwp|createSessionRequest/.test(r.body)));
    assert.equal(report.code, "POC_AVR_NCALAYER_SUCCESS");
    assert.equal(report.externalId, "test-external-123");
    assert.equal(report.environment, "TEST");
    assert.equal(report.soap.httpStatus, 200);
    assert.equal(report.signature.decodedLength, 64);
    assert.equal(report.payload.sha256, sha256Utf8(prepared.payload));
    for (const cert of [report.authCertificate, report.signCertificate]) {
      assert.ok(cert?.subject && cert.serial && cert.algorithm && cert.validFrom && cert.validTo);
    }
    assert.doesNotMatch(JSON.stringify(report), /BEGIN CERTIFICATE|private-session-id|PRIVATE KEY/);
  });

  it("rejects browser hash or byte-length changes before signing", async () => {
    const { prepared } = await preparedInput();
    await assert.rejects(verifyFrozenAvrPayload({ ...prepared, payload: prepared.payload + "\n" }));
    await assert.rejects(verifyFrozenAvrPayload({ ...prepared, byteLength: 1 }));
    assert.equal(uploadRequests().length, 0);
  });

  it("does not overwrite previously frozen bytes when another BIN is prepared", async () => {
    const first = await preparedInput();
    row.organizationBin = "123456789099";
    const second = await preparedInput();
    assert.notEqual(first.raw.payloadSha256, second.raw.payloadSha256);
    const firstPath = path.join(scratch, "apps/api/data/esf-poc/tenant", `avr-payload-${first.raw.payloadSha256}.xml`);
    assert.equal(readFileSync(firstPath, "utf8"), first.prepared.payload);
    await rejected(first.raw, "ESF_POC_SESSION_CHANGED");
    assert.equal(uploadRequests().length, 0);
  });

  it("detects stored XML mutation and refuses to repair/re-serialize it", async () => {
    const { raw, prepared } = await preparedInput();
    const file = path.join(scratch, "apps/api/data/esf-poc/tenant", `avr-payload-${raw.payloadSha256}.xml`);
    writeFileSync(file, prepared.payload + "\n");
    await rejected(raw, "ESF_SIGNED_PAYLOAD_CHANGED");
    await assert.rejects(prepareAvrPocPayload(prisma, auth));
    assert.equal(readFileSync(file, "utf8"), prepared.payload + "\n");
    assert.equal(uploadRequests().length, 0);
  });

  it("requires a matching SIGN fingerprint and refuses AUTH substitution", async () => {
    const { raw } = await preparedInput();
    for (const pemFingerprint of [undefined, "", "0".repeat(64)]) await rejected({ ...raw, pemFingerprint }, "ESF_SIGN_PEM_MISMATCH");
    await rejected({ ...raw, pem: authPem, pemFingerprint: publicCertificateFingerprint(authPem) }, "ESF_AUTH_PEM_USED_FOR_SIGN");
    assert.throws(() => assertPocSignatureCertificate(signPem + signPem, raw.pemFingerprint, authPem));
    assert.equal(uploadRequests().length, 0);
  });

  it("blocks expired or replaced sessions after NCALayer signing", async () => {
    const { raw } = await preparedInput();
    row.sessionExpiresAt = new Date(0);
    await rejected(raw, "ESF_POC_SESSION_GUARD");
    row.sessionExpiresAt = null;
    row.sessionId = "replacement";
    await rejected(raw, "ESF_POC_SESSION_CHANGED");
    assert.equal(uploadRequests().length, 0);
  });

  it("checks remote session expiry even if no expiry date is stored", async () => {
    const { raw } = await preparedInput();
    row.sessionExpiresAt = null;
    remoteSession = "CLOSED";
    await rejected(raw, "ESF_POC_SESSION_GUARD");
    await assert.rejects(prepareAvrPocPayload(prisma, auth), (e: any) => e.code === "ESF_POC_SESSION_GUARD");
    assert.equal(uploadRequests().length, 0);
  });

  it("never reports mock acceptance as TEST success", async () => {
    const { raw } = await preparedInput();
    process.env.ESF_PROVIDER = "mock";
    await rejected(raw, "ESF_POC_SESSION_GUARD");
    assert.equal(uploadRequests().length, 0);
  });

  it("reports SOAP rejection with HTTP status and the ESF error code", async () => {
    const { raw } = await preparedInput();
    uploadBody = '<Envelope><declinedList><awpUploadResult><errorList><error><errorCode>AWP_SENDER_NOT_VALID</errorCode><text>Sender invalid</text></error></errorList></awpUploadResult></declinedList></Envelope>';
    await rejected(raw, "AWP_SENDER_NOT_VALID");
    const report = JSON.parse(readFileSync(path.join(scratch, "apps/api/data/esf-poc/tenant/avr-result.json"), "utf8"));
    assert.equal(report.soap.httpStatus, 200);
    assert.equal(report.soap.result, "declined");
    assert.equal(report.soap.errorMessage, "Sender invalid");
    assert.equal(report.externalId, null);
  });

  it("does not accept HTTP 500 even if the body contains an accepted ID", async () => {
    const { raw } = await preparedInput();
    uploadStatus = 500;
    await rejected(raw, "esf_upload_declined");
  });

  it("returns a complete safe report for transport failures", async () => {
    const { raw } = await preparedInput();
    transportFailure = true;
    await rejected(raw, "ESF_POC_SOAP_ERROR");
    const report = JSON.parse(readFileSync(path.join(scratch, "apps/api/data/esf-poc/tenant/avr-result.json"), "utf8"));
    assert.equal(report.soap.httpStatus, null);
    assert.equal(report.soap.result, "transport_error");
    assert.ok(report.payload.sha256 && report.signCertificate.subject);
  });

  it("redacts PEM, private keys, PIN and WSSE passwords in SOAP errors", () => {
    const result = redactSoapText(`${signPem} <wsse:Password Type="x">secret-password</wsse:Password> PIN=1234 privateKey=secretkey`);
    assert.doesNotMatch(result, /BEGIN CERTIFICATE|secret-password|1234|secretkey/);
  });
});
