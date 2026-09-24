import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { request as httpRequest, type Server } from "node:http";
import express from "express";
import { createLegacyDomainRedirect } from "./lib/legacyDomainRedirect.ts";

const settings = {
  appBaseUrl: "https://bsqr.kz",
  legacyAppOrigin: "https://crm.creolab.kz",
  legacyRedirectMode: "ui",
};

for (const mode of ["off", "ui", "all"]) {
  describe(`legacy domain redirect: ${mode}`, () => {
    let server: Server;
    let base: string;
    before(async () => {
      const app = express();
      app.set("trust proxy", 1);
      app.use(createLegacyDomainRedirect({ ...settings, legacyRedirectMode: mode }));
      app.use(express.text({ type: "*/*" }));
      app.use((req, res) => res.json({ method: req.method, url: req.originalUrl, body: req.body }));
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server.once("listening", resolve));
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    after(() => new Promise<void>(resolve => server.close(() => resolve())));
    async function request(path: string, init: RequestInit = {}, host = "crm.creolab.kz") {
      // Node fetch owns its Host header; use HTTP directly to exercise custom-domain routing.
      return new Promise<Response>((resolve, reject) => {
        const req = httpRequest(base + path, { method: init.method || "GET", headers: { Host: host, ...(init.headers as Record<string, string>) } }, res => {
          const chunks: Buffer[] = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as Record<string, string> })));
        });
        req.on("error", reject);
        req.end(init.body || undefined);
      });
    }
    it("preserves root, deep paths, encoded path and query parameters", async () => {
      for (const path of ["/", "/login", "/settings/profile?tab=security", "/sign/abc%2Fdef?x=a%2Bb&x=2", "/sign/avr/token", "/verify/avr/id", "//untrusted.example/path?next=https%3A%2F%2Fevil.example"]) {
        const r = await request(path);
        assert.equal(r.status, mode === "off" ? 200 : 301);
        assert.equal(r.headers.get("location"), mode === "off" ? null : settings.appBaseUrl + path);
      }
      const head = await request("/deals?q=one", { method: "HEAD" });
      assert.equal(head.status, mode === "off" ? 200 : 301);
    });
    it("does not redirect the primary, marketing, Render or lookalike hosts", async () => {
      for (const host of ["bsqr.kz", "lead.bsqr.kz", "creolab.kz", "creolab-crm.onrender.com", "crm.creolab.kz.evil.example"]) {
        const r = await request("/login", { headers: { Origin: settings.legacyAppOrigin, "X-Forwarded-Host": "crm.creolab.kz" } }, host);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("location"), null);
      }
    });
    it("keeps health probes reachable on the legacy host", async () => {
      for (const path of ["/health", "/ready?probe=1"]) assert.equal((await request(path)).status, 200);
    });
    it("keeps OAuth callbacks and anonymous signing API reachable during transition", async () => {
      for (const path of ["/api/v1/integrations/google/callback?code=test&state=tenant", "/public/sign/token?x=1", "/public/avr-sign/token", "/.well-known/assetlinks.json"]) {
        const r = await request(path);
        assert.equal(r.status, mode === "all" ? 301 : 200);
        if (mode !== "all") assert.equal((await r.json()).url, path);
      }
    });
    it("preserves webhook methods and payloads until final cutover", async () => {
      for (const path of ["/public/forms/key/submissions", "/api/v1/integrations/seller-events/id", "/api/integrations/ai-control/execute", "/api/v1/auth/login"]) {
        const payload = '{"event":"test","tenant":"one"}';
        const r = await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
        assert.equal(r.status, mode === "all" ? 301 : 200);
        if (mode !== "all") assert.deepEqual(await r.json(), { method: "POST", url: path, body: payload });
      }
      assert.equal((await request("/api/v1/tasks", { method: "OPTIONS" })).status, mode === "all" ? 301 : 200);
    });
  });
}

it("rejects unsafe or looping redirect configuration", () => {
  for (const appBaseUrl of ["http://bsqr.kz", "https://bsqr.kz/path", "https://user:pass@bsqr.kz", "https://bsqr.kz?x=1", "https://bsqr.kz#part", settings.legacyAppOrigin]) {
    assert.throws(() => createLegacyDomainRedirect({ ...settings, appBaseUrl }));
  }
  assert.throws(() => createLegacyDomainRedirect({ ...settings, legacyAppOrigin: "" }));
  assert.throws(() => createLegacyDomainRedirect({ ...settings, legacyRedirectMode: "unknown" }));
  assert.doesNotThrow(() => createLegacyDomainRedirect({ ...settings, legacyAppOrigin: "", legacyRedirectMode: "off" }));
});
