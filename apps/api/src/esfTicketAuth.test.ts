import assert from "node:assert/strict";
import { it } from "node:test";
import { createEsfSessionFromSignedTicket, ticketFault } from "./integrations/esf/EsfTicketAuth.ts";
import { readEsfConfig } from "./integrations/esf/EsfConfig.ts";
import { findDeep, parseXml, textOf, xmlEscape } from "./integrations/esf/xml.ts";
import { SOAP_NS, WSSE_NS } from "./integrations/esf/EsfSoap.ts";

const soapFault = (message: string) => `<s:Envelope xmlns:s="${SOAP_NS}"><s:Body><s:Fault><faultcode>s:Server</faultcode><faultstring>${xmlEscape(message)}</faultstring></s:Fault></s:Body></s:Envelope>`;

it("recognizes portal WS-Security rejection while preserving specific ticket failures", () => {
  const security = ticketFault(soapFault("A security error was encountered when verifying the message"), 500);
  assert.equal(security.code, "esf_wsse_required");
  assert.equal(security.wsseRequired, true);
  assert.match(security.description, /security error/);
  for (const code of ["INVALID_SIGNATURE", "AUTH_TICKET_EXPIRED", "CERTIFICATE_NOT_VALID"]) {
    const failure = ticketFault(soapFault(code), 500);
    assert.equal(failure.code, code);
    assert.equal(failure.wsseRequired, false);
  }
  const unknown = ticketFault(soapFault("Business rule rejected the selected profile"), 500);
  assert.equal(unknown.wsseRequired, false);
  assert.match(unknown.description, /selected profile/);
  assert.equal(ticketFault("Bad Gateway", 502).wsseRequired, false);
});

it("redacts authentication material in fault descriptions and ignores non-fault bodies", () => {
  const password = 'example-secret<&"';
  const ticket = '<authSign><state>synthetic-ticket</state></authSign>';
  const fault = ticketFault(soapFault(`Rejected ${password} ${ticket}`), 500, [password, ticket]);
  assert.equal(fault.description.includes(password), false);
  assert.equal(fault.description.includes("synthetic-ticket"), false);
  assert.equal(ticketFault(`<html>${password}</html>`, 500).description.includes(password), false);
  assert.equal(ticketFault(soapFault("<ds:Signature>partially-echoed-secret</ds:Signature>"), 500).description.includes("partially-echoed-secret"), false);
});

it("retries signed-ticket authorization with WSSE credentials without changing the signed XML", async () => {
  const originalFetch = globalThis.fetch;
  const config = { ...readEsfConfig(), esfEnv: "local" as const, baseUrl: "https://esf.test.invalid", sessionUrl: "https://esf.test.invalid/SessionService" };
  const signedTicket = '<authSign><state>exact &amp; signed</state><Signature>synthetic</Signature></authSign>';
  const password = 'cabinet-password<&"';
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), config.sessionUrl);
    calls++;
    const xml = String(options?.body);
    const root = parseXml(xml);
    assert.equal(textOf(findDeep(root, "signedAuthTicket")), signedTicket);
    assert.equal(findDeep(root, "createSessionSignedRequest")?.ns, "esf");
    assert.equal(textOf(findDeep(root, "tin")), "123456789012");
    if (calls === 1) {
      assert.equal(findDeep(root, "UsernameToken"), undefined);
      return new Response(soapFault("A security error was encountered when verifying the message"), { status: 500 });
    }
    const security = findDeep(root, "Security")!;
    assert.equal(security.ns, WSSE_NS);
    assert.equal(security.attrs["soapenv:mustUnderstand"], "1");
    assert.equal(textOf(findDeep(security, "Username")), "123456789013");
    assert.equal(textOf(findDeep(security, "Password")), password);
    return new Response(`<s:Envelope xmlns:s="${SOAP_NS}"><s:Body><createSessionResponse><sessionId>synthetic-session</sessionId></createSessionResponse></s:Body></s:Envelope>`);
  };
  try {
    const rejected = await createEsfSessionFromSignedTicket("123456789012", signedTicket, config);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.wsseRequired, true);
    const connected = await createEsfSessionFromSignedTicket("123456789012", signedTicket, config, { username: "123456789013", password });
    assert.equal(connected.ok, true);
    assert.equal(connected.sessionId, "synthetic-session");
    assert.equal(JSON.stringify(connected).includes(password), false);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

it("does not mistake HTTP errors or SOAP faults containing sessionId for a successful login", async () => {
  const originalFetch = globalThis.fetch;
  const config = { ...readEsfConfig(), esfEnv: "local" as const, baseUrl: "https://esf.test.invalid", sessionUrl: "https://esf.test.invalid/SessionService" };
  try {
    for (const [status, body] of [[502, "Bad Gateway"], [500, "<response><sessionId>echo</sessionId></response>"], [200, `<Envelope><Body><Fault><faultstring>Invalid</faultstring><sessionId>echo</sessionId></Fault></Body></Envelope>`]] as const) {
      globalThis.fetch = async () => new Response(body, { status });
      const result = await createEsfSessionFromSignedTicket("123456789012", "<signed/>", config);
      assert.equal(result.ok, false);
      assert.equal(result.sessionId, "");
    }
  } finally { globalThis.fetch = originalFetch; }
});

it("connection service forwards cabinet credentials on the ticket path and never persists them", async () => {
  const { connectEsf } = await import("./services/esfConnectionService.ts");
  const { makeTestGostCertificate } = await import("./testGostCertificate.ts");
  const oldFetch = globalThis.fetch;
  const envKeys = ["ESF_PROVIDER", "ESF_ENV", "ESF_ALLOW_LIVE_SEND", "ESF_TLS_INSECURE"];
  const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.ESF_PROVIDER = "live";
  process.env.ESF_ENV = "test";
  process.env.ESF_ALLOW_LIVE_SEND = "1";
  process.env.ESF_TLS_INSECURE = "0";
  const der = makeTestGostCertificate().replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const ticket = `<authSign><state>synthetic-secret-ticket</state><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${der}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></ds:Signature></authSign>`;
  const password = "synthetic-secret-password";
  let stored: any = null;
  const writes: any[] = [];
  const persist = async ({ data }: any) => { writes.push(data); return stored = { ...stored, ...data }; };
  const prisma: any = {
    tenantLegalProfile: { findUnique: async () => ({ bin: "123456789013", legalName: "Synthetic company", esfIntegrationEnabled: true }) },
    esfConnection: { findUnique: async () => stored, create: persist, update: persist },
    auditEvent: { create: async (data: any) => { writes.push(data); } },
  };
  const auth: any = { user: { id: "synthetic-owner" }, activeMembership: { role: "owner", tenantId: "synthetic-tenant" } };
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const root = parseXml(String(init?.body));
    assert.equal(textOf(findDeep(root, "signedAuthTicket")), ticket);
    if (requests === 1) return new Response(soapFault("A security error was encountered when verifying the message"), { status: 500 });
    assert.equal(textOf(findDeep(root, "Username")), "222222222220");
    assert.equal(textOf(findDeep(root, "Password")), password);
    return new Response("<Envelope><Body><sessionId>synthetic-session</sessionId></Body></Envelope>");
  };
  try {
    const initial = { signedAuthTicket: ticket };
    const failed = await connectEsf(prisma, auth, initial);
    assert.equal(failed.connection.status, "REAUTH_REQUIRED");
    assert.equal(failed.wsseRequired, true);
    assert.equal(stored.lastErrorCode, "esf_wsse_required");
    const retry = { signedAuthTicket: ticket, cabinetUsername: "222222222220", cabinetPassword: password };
    const success = await connectEsf(prisma, auth, retry);
    assert.equal(success.ok, true);
    assert.equal(success.connection.status, "CONNECTED");
    assert.equal(retry.signedAuthTicket, "");
    assert.equal(retry.cabinetPassword, "");
    assert.equal(JSON.stringify(writes).includes(password), false);
    assert.equal(JSON.stringify(writes).includes("synthetic-secret-ticket"), false);
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of envKeys) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
  }
});
