import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { makeTestGostCertificate } from "./testGostCertificate.ts";
import { makeTestCms } from "./testCms.ts";

describe("ESF connection NCALayer", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let tenantId = "";

  async function json(path: string, init: RequestInit = {}, useCookie = cookie) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        cookie: useCookie,
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  }

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    process.env.ESF_PROVIDER = "mock";
    process.env.ESF_ENV = "test";
    delete process.env.ESF_ALLOW_LIVE_SEND;
    delete process.env.ESF_SIGN_CERT_PATH;
    delete process.env.ESF_SIGN_CERT_PIN;
    delete process.env.ESF_TIN;
    delete process.env.ESF_IIN;
    delete process.env.ESF_PASSWORD;
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = (server as { address: () => { port: number } }).address();
    base = `http://127.0.0.1:${address.port}`;

    const login = await json(
      "/api/v1/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          email: "owner@creolab.example",
          password: process.env.SEED_PASSWORD,
          client: "web",
        }),
      },
      "",
    );
    cookie = login.response.headers.get("set-cookie") || "";
    tenantId = login.body.user?.activeTenant?.tenant?.id || "";
    const demo = await json(
      "/api/v1/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          email: "owner@demo-agency.example",
          password: process.env.SEED_PASSWORD,
          client: "web",
        }),
      },
      "",
    );
    otherCookie = demo.response.headers.get("set-cookie") || "";
  });

  after(() => {
    server?.close();
  });

  it("отдаёт NOT_CONNECTED без сессии и без секретов", async () => {
    const { response, body } = await json("/api/v1/integrations/esf");
    assert.equal(response.status, 200);
    assert.equal(body.connection.status, "NOT_CONNECTED");
    assert.equal(body.connection.sessionActive, false);
    assert.equal("sessionId" in body.connection, false);
    assert.equal(JSON.stringify(body).includes("BEGIN CERTIFICATE"), false);
    assert.equal(body.system.environmentLabel, "TEST");
    assert.doesNotMatch(String(body.system.endpointHost || ""), /esf\.gov\.kz/);
    assert.equal(body.avrPoc.ready, false);
  });

  it("passes GOST AUTH metadata to SOAP and preserves the server rejection", async (t) => {
    const oldProvider = process.env.ESF_PROVIDER;
    const oldTls = process.env.ESF_TLS_INSECURE;
    const oldLive = process.env.ESF_ALLOW_LIVE_SEND;
    Object.assign(process.env, { ESF_PROVIDER: "live", ESF_TLS_INSECURE: "0", ESF_ALLOW_LIVE_SEND: "1" });
    const realFetch = globalThis.fetch;
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (input, init) => {
      if (String(input).startsWith(base + "/")) return realFetch(input, init);
      assert.equal(new URL(String(input)).hostname, "test3.esf.kgd.gov.kz");
      assert.match(String(init?.body), /createSessionRequest/);
      requests++;
      return new Response("<Envelope><Body><Fault><faultstring>CERTIFICATE_NOT_VALID</faultstring></Fault></Body></Envelope>", { status: 500 });
    });
    try {
      await json("/api/v1/settings/legal-profile", { method: "PATCH", body: JSON.stringify({ legalName: "Тестовая организация", bin: "123456789013" }) });
      const result = await json("/api/v1/integrations/esf/connect", { method: "POST", body: JSON.stringify({ authCertificatePem: makeTestGostCertificate() }) });
      assert.equal(requests, 1);
      assert.equal(result.response.status, 422);
      assert.equal(result.body.code, "CERTIFICATE_NOT_VALID");
      assert.equal(result.body.connection.sessionActive, false);
      assert.equal(result.body.authCertificate.signatureAlgorithm, "1.2.643.7.1.1.3.2");
      assert.equal(result.body.authCertificate.bin, "123456789013");
      assert.doesNotMatch(JSON.stringify(result.body), /BEGIN CERTIFICATE|PRIVATE KEY/);
    } finally {
      process.env.ESF_PROVIDER = oldProvider;
      if (oldTls === undefined) delete process.env.ESF_TLS_INSECURE; else process.env.ESF_TLS_INSECURE = oldTls;
      if (oldLive === undefined) delete process.env.ESF_ALLOW_LIVE_SEND; else process.env.ESF_ALLOW_LIVE_SEND = oldLive;
    }
  });

  it("запрашивает пароль только после SOAP-отказа, а не из-за live-провайдера", async (t) => {
    const oldProvider = process.env.ESF_PROVIDER;
    const oldTls = process.env.ESF_TLS_INSECURE;
    const oldLive = process.env.ESF_ALLOW_LIVE_SEND;
    process.env.ESF_PROVIDER = "live";
    process.env.ESF_TLS_INSECURE = "0";
    process.env.ESF_ALLOW_LIVE_SEND = "1";
    const realFetch = globalThis.fetch;
    let fault = "CERTIFICATE_NOT_VALID";
    let soapCalls = 0;
    let expectWsse = false;
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const url = String(input);
      if (url.startsWith(base + "/")) return realFetch(input, init);
      assert.equal(new URL(url).hostname, "test3.esf.kgd.gov.kz");
      const xml = String(init?.body || "");
      soapCalls++;
      if (xml.includes("createSessionRequest")) {
        if (fault) {
          assert.equal(xml.includes("UsernameToken"), expectWsse);
          return new Response(`<Envelope xmlns:wsse="http://docs.oasis-open.org/wss/wssecurity"><Body><Fault><faultstring>${fault}</faultstring></Fault></Body></Envelope>`, { status: 500 });
        }
        assert.ok(xml.includes("UsernameToken"));
        return new Response("<Envelope><Body><sessionId>synthetic-test-session</sessionId></Body></Envelope>");
      }
      return new Response("<Envelope><Body><status>OK</status></Body></Envelope>");
    });
    try {
      const initial = await json("/api/v1/integrations/esf");
      assert.equal(initial.body.system.provider, "live");
      assert.equal(initial.body.wsseRequired, false);
      assert.equal(soapCalls, 0);
      await json("/api/v1/settings/legal-profile", {
        method: "PATCH", body: JSON.stringify({ legalName: "ТОО CREOLAB", bin: "123456789013" }),
      });
      const cms = makeTestCms(Buffer.from("wsse-prompt-test"), { bin: "123456789013" });
      const connect = (extra = {}) => json("/api/v1/integrations/esf/connect", {
        method: "POST", body: JSON.stringify({ authCmsBase64: cms, ...extra }),
      });
      const invalid = await connect();
      assert.equal(invalid.response.status, 422);
      assert.equal(invalid.body.wsseRequired, false);
      assert.equal((await json("/api/v1/integrations/esf")).body.wsseRequired, false);

      fault = "UsernameToken password is required";
      const needsPassword = await connect();
      assert.equal(needsPassword.response.status, 422);
      assert.equal(needsPassword.body.code, "esf_wsse_required");
      assert.equal(needsPassword.body.wsseRequired, true);
      assert.equal((await json("/api/v1/integrations/esf")).body.wsseRequired, true);

      expectWsse = true;
      fault = "Security error: credentials rejected; echoed synthetic-wsse-password";
      const rejected = await connect({ cabinetUsername: "222222222220", cabinetPassword: "synthetic-wsse-password" });
      assert.equal(rejected.response.status, 422);
      assert.equal(rejected.body.connection.sessionActive, false);
      assert.match(rejected.body.message, /отклонила авторизацию с переданными данными/);
      assert.match(rejected.body.message, /createSession: HTTP 500/);
      assert.match(rejected.body.message, /credentials rejected/);
      assert.equal(JSON.stringify(rejected.body).includes("synthetic-wsse-password"), false);
      const rejectedStored = await prisma.esfConnection.findFirst({ where: { tenantId } });
      assert.equal(JSON.stringify(rejectedStored).includes("synthetic-wsse-password"), false);

      fault = "";
      const connected = await connect({ cabinetUsername: "222222222220", cabinetPassword: "synthetic-wsse-password" });
      assert.equal(connected.response.status, 200);
      assert.equal(connected.body.connection.status, "CONNECTED");
      assert.equal(connected.body.wsseRequired, false);
      assert.equal((await json("/api/v1/integrations/esf")).body.wsseRequired, false);
      const stored = await prisma.esfConnection.findFirst({ where: { tenantId } });
      assert.equal(JSON.stringify(stored).includes("synthetic-wsse-password"), false);
      await json("/api/v1/integrations/esf/disconnect", { method: "POST" });
      assert.equal((await json("/api/v1/integrations/esf")).body.wsseRequired, false);
    } finally {
      process.env.ESF_PROVIDER = oldProvider;
      if (oldTls === undefined) delete process.env.ESF_TLS_INSECURE;
      else process.env.ESF_TLS_INSECURE = oldTls;
      if (oldLive === undefined) delete process.env.ESF_ALLOW_LIVE_SEND;
      else process.env.ESF_ALLOW_LIVE_SEND = oldLive;
    }
  });

  it("creates a session using the exact signed GOST ticket without WSSE credentials", async (t) => {
    const oldProvider = process.env.ESF_PROVIDER;
    const oldLive = process.env.ESF_ALLOW_LIVE_SEND;
    const oldTls = process.env.ESF_TLS_INSECURE;
    process.env.ESF_TLS_INSECURE = "0";
    process.env.ESF_PROVIDER = "live";
    process.env.ESF_ALLOW_LIVE_SEND = "1";
    const pem = makeTestGostCertificate();
    const der = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
    const ticket = `<authSign><iin>222222222220</iin><state>synthetic-ticket-only</state><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${der}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></ds:Signature></authSign>`;
    const realFetch = globalThis.fetch;
    let signedCalls = 0;
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const url = String(input);
      if (url.startsWith(base + "/")) return realFetch(input, init);
      assert.equal(new URL(url).hostname, "test3.esf.kgd.gov.kz");
      const xml = String(init?.body || "");
      assert.equal(xml.includes("UsernameToken"), false);
      if (url.endsWith("/AuthService")) {
        assert.match(xml, /createAuthTicketRequest/);
        return new Response('<Envelope><Body><authTicketXml>&lt;authSign&gt;synthetic&lt;/authSign&gt;</authTicketXml></Body></Envelope>');
      }
      if (xml.includes("createSessionSignedRequest")) {
        const { findDeep, parseXml, textOf } = await import("./integrations/esf/xml.ts");
        assert.equal(textOf(findDeep(parseXml(xml), "signedAuthTicket")), ticket);
        signedCalls++;
        return new Response('<Envelope><Body><sessionId>synthetic-signed-session</sessionId></Body></Envelope>');
      }
      return new Response('<Envelope><Body><status>OK</status></Body></Envelope>');
    });
    try {
      await json("/api/v1/settings/legal-profile", { method: "PATCH", body: JSON.stringify({ bin: "123456789013" }) });
      const prepared = await json("/api/v1/integrations/esf/auth-ticket", { method: "POST", body: JSON.stringify({ iin: "222222222220" }) });
      assert.equal(prepared.response.status, 200);
      assert.equal(prepared.body.authTicketXml, "<authSign>synthetic</authSign>");
      const result = await json("/api/v1/integrations/esf/connect", { method: "POST", body: JSON.stringify({ signedAuthTicket: ticket }) });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.connection.status, "CONNECTED");
      assert.equal(signedCalls, 1);
      assert.equal(JSON.stringify(result.body).includes("synthetic-ticket-only"), false);
      const stored = await prisma.esfConnection.findFirst({ where: { tenantId } });
      assert.equal(JSON.stringify(stored).includes("synthetic-ticket-only"), false);
      await json("/api/v1/integrations/esf/disconnect", { method: "POST" });
      await prisma.tenantLegalProfile.update({ where: { tenantId }, data: { bin: "999999999999" } });
      const wrongTenant = await json("/api/v1/integrations/esf/connect", { method: "POST", body: JSON.stringify({ signedAuthTicket: ticket }) });
      assert.equal(wrongTenant.response.status, 422);
      assert.equal(wrongTenant.body.code, "esf_bin_mismatch");
      assert.equal(signedCalls, 1);
      await json("/api/v1/settings/legal-profile", { method: "PATCH", body: JSON.stringify({ bin: "123456789013" }) });
    } finally {
      process.env.ESF_PROVIDER = oldProvider;
      if (oldTls === undefined) delete process.env.ESF_TLS_INSECURE; else process.env.ESF_TLS_INSECURE = oldTls;
      if (oldLive === undefined) delete process.env.ESF_ALLOW_LIVE_SEND; else process.env.ESF_ALLOW_LIVE_SEND = oldLive;
    }
  });

  it("отклоняет PIN и путь к ЭЦП", async () => {
    const { response, body } = await json("/api/v1/integrations/esf/connect", {
      method: "POST",
      body: JSON.stringify({
        authCmsBase64: makeTestCms(Buffer.from("esf-auth")),
        pin: "should-not-be-accepted",
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(body.code, "esf_private_key_forbidden");
  });

  it("подключает mock-сессию из публичного CMS и не сохраняет пароль кабинета", async () => {
    await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({
        legalName: "ТОО CREOLAB",
        bin: "123456789013",
      }),
    });
    const cms = makeTestCms(Buffer.from("esf-auth-connect"), { iin: "222222222220", bin: "123456789013" });
    const { response, body } = await json("/api/v1/integrations/esf/connect", {
      method: "POST",
      body: JSON.stringify({
        authCmsBase64: cms,
        cabinetUsername: "222222222220",
        cabinetPassword: "secret-cabinet-password-value",
      }),
    });
    assert.equal(response.status, 200, body.message || body.code);
    assert.equal(body.ok, true);
    assert.equal(body.connection.status, "CONNECTED");
    assert.equal(body.connection.sessionActive, true);
    assert.equal(body.connection.organizationBin, "123456789013");
    assert.equal(body.connection.signerIin, "222222222220");
    assert.equal("sessionId" in body.connection, false);
    assert.equal(JSON.stringify(body).includes("secret-cabinet-password-value"), false);

    const stored = await prisma.esfConnection.findFirst({ where: { tenantId } });
    assert.ok(stored?.sessionId);
    assert.equal(JSON.stringify(stored).includes("secret-cabinet-password-value"), false);
    assert.equal(JSON.stringify(stored).includes("should-not-be-accepted"), false);
    assert.match(stored?.authCertificatePem || "", /BEGIN CERTIFICATE/);

    const other = await json("/api/v1/integrations/esf", {}, otherCookie);
    assert.equal(other.body.connection.status, "NOT_CONNECTED");
  });

  it("отключает сессию", async () => {
    const { response, body } = await json("/api/v1/integrations/esf/disconnect", { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal(body.connection.status, "NOT_CONNECTED");
    assert.equal(body.connection.sessionActive, false);
    const stored = await prisma.esfConnection.findFirst({ where: { tenantId } });
    assert.equal(stored?.sessionId, null);
  });
});
