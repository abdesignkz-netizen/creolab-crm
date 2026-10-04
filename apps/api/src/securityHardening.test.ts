import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { PrismaClient } from "@creolab/db";
import * as XLSX from "xlsx";
import { config } from "./config.ts";
import { protectBrowserMutation, securityHeaders } from "./lib/httpSecurity.ts";
import { assertProductionSecurity } from "./lib/productionSecurity.ts";
import { MemoryRateLimitStore } from "./lib/rateLimit.ts";
import { resolveUploadPath, uploadsRoot } from "./lib/storage.ts";
import { isPublicMediaAddress, publicMediaUrl, downloadPublicMedia } from "./lib/publicMedia.ts";
import { errorBody } from "./errors.ts";
import { ensurePlatformAdmin } from "./services/platformAdminBootstrap.ts";
import { parseContactImportFile } from "./services/contactImportParse.ts";
import { logServerError } from "./lib/redact.ts";

let server: Server;
let base: string;
before(async () => {
  const app = express();
  app.use(securityHeaders, protectBrowserMutation, express.json({ limit: "1kb" }));
  app.post("/api/test", (_req, res) => res.json({ ok: true }));
  app.get("/api/test", (_req, res) => res.json({ ok: true }));
  app.use(((error, _req, res, _next) => {
    const mapped = errorBody(error, "test-request");
    res.status(mapped.status).json(mapped.body);
  }) as express.ErrorRequestHandler);
  await new Promise<void>(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

it("blocks cross-site mutations, including same-site hostile subdomains and null origins", async () => {
  for (const headers of [
    { origin: "https://evil.example" }, { origin: "https://bsqr.kz.evil.example" },
    { origin: "https://lead.bsqr.kz" }, { origin: "null" },
    { referer: "https://evil.example/form" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" },
  ]) {
    const response = await fetch(`${base}/api/test`, { method: "POST", headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal((await response.json()).code, "untrusted_origin");
  }
});

it("accepts the configured frontend and native/server clients", async () => {
  for (const headers of [{ origin: new URL(config.appBaseUrl).origin }, { referer: `${config.appBaseUrl}/login` }, {}]) {
    const response = await fetch(`${base}/api/test`, { method: "POST", headers });
    assert.equal(response.status, 200);
  }
});

it("does not cache private responses and restricts script execution and embedding", async () => {
  const response = await fetch(`${base}/api/test`);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const csp = response.headers.get("content-security-policy") || "";
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(csp, /wss:\/\/127\.0\.0\.1:13579/);
});

it("returns safe parser errors instead of exposing request contents", async () => {
  for (const [body, expected] of [["{ secret: sensitive }", 400], [JSON.stringify({ secret: "x".repeat(2000) }), 413]] as const) {
    const response = await fetch(`${base}/api/test`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /sensitive|secret/);
  }
});

it("prevents traversal and symlink escapes while preserving files inside the storage root", async () => {
  const original = config.storageDir;
  const scratch = await mkdtemp(path.join(tmpdir(), "basqar-storage-security-"));
  config.storageDir = scratch;
  try {
    await mkdir(uploadsRoot(), { recursive: true });
    await symlink(tmpdir(), path.join(uploadsRoot(), "escape"));
    for (const key of ["../secret", "/etc/passwd", "a/../../secret", "escape/secret", "", ".", "a\\..\\secret", "a\0b"]) {
      assert.throws(() => resolveUploadPath(key), /Недопустимый/);
    }
    const expected = path.join(uploadsRoot(), "tenant", "file.pdf");
    assert.equal(resolveUploadPath("tenant/file.pdf"), expected);
    assert.equal(resolveUploadPath(expected), expected);
  } finally { config.storageDir = original; await rm(scratch, { recursive: true, force: true }); }
});

it("bounds rate-limit memory without letting new keys reset active limits", () => {
  let now = 100;
  const limiter = new MemoryRateLimitStore(2, () => now);
  assert(limiter.hit("target", 1, 100).allowed);
  assert(!limiter.hit("target", 1, 100).allowed);
  assert(limiter.hit("other", 1, 100).allowed);
  assert(!limiter.hit("flood", 1, 100).allowed);
  assert(!limiter.hit("target", 1, 100).allowed);
  now = 201;
  assert(limiter.hit("new", 1, 100).allowed);
  assert(limiter.hit("target", 1, 100).allowed);
});

it("blocks internal, mapped, transition and reserved IPs used for remote media", async () => {
  for (const ip of ["127.2.3.4", "10.0.0.1", "169.254.169.254", "100.100.100.200", "172.31.255.255", "192.168.1.1", "0.0.0.0", "224.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "2002:7f00:1::", "2001:db8::1"]) {
    assert.equal(isPublicMediaAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert(isPublicMediaAddress(ip), ip);
  for (const url of ["http://example.com/a", "https://127.1/a", "https://2130706433/a", "https://[::1]/a", "https://localhost/a", "https://user:pass@example.com/a", "https://example.com:8080/a"]) {
    assert.throws(() => publicMediaUrl(url));
    await assert.rejects(downloadPublicMedia(url, 1024));
  }
});

it("rejects unsafe production configuration without disclosing secrets", () => {
  const env = Object.fromEntries(["SESSION_SECRET", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "ENCRYPTION_KEY"].map(key => [key, randomBytes(32).toString("hex")])) as NodeJS.ProcessEnv;
  env.NODE_ENV = "production";
  assert.doesNotThrow(() => assertProductionSecurity(env));
  for (const patch of [{ SESSION_SECRET: "dev-session-secret-change" }, { ENCRYPTION_KEY: "replace-with-32-byte-base64-or-hex" }, { JWT_ACCESS_SECRET: env.SESSION_SECRET }, { ENCRYPTION_KEY: "" }, { TRUST_PROXY_DEBUG: "1" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { APP_BASE_URL: "http://example.com" }]) {
    assert.throws(() => assertProductionSecurity({ ...env, ...patch }));
  }
});

it("bootstrap never promotes an existing user, resets passwords or reactivates a disabled admin", async () => {
  const savedEmail = process.env.PLATFORM_ADMIN_EMAIL;
  const savedPassword = process.env.PLATFORM_ADMIN_PASSWORD;
  let calls = 0;
  const fake = (platformAdmin: boolean) => ({ user: { findUnique: async () => ({ platformAdmin, status: "disabled" }),
    update: async () => { calls++; }, create: async () => { calls++; } } }) as unknown as PrismaClient;
  try {
    process.env.PLATFORM_ADMIN_EMAIL = "admin@example.test";
    process.env.PLATFORM_ADMIN_PASSWORD = "a-new-password-123!";
    await assert.rejects(ensurePlatformAdmin(fake(false)), /non-administrator/);
    assert.equal((await ensurePlatformAdmin(fake(true))).updated, false);
    delete process.env.PLATFORM_ADMIN_PASSWORD;
    assert.equal((await ensurePlatformAdmin(fake(false))).created, false);
    assert.equal(calls, 0);
  } finally {
    if (savedEmail === undefined) delete process.env.PLATFORM_ADMIN_EMAIL; else process.env.PLATFORM_ADMIN_EMAIL = savedEmail;
    if (savedPassword === undefined) delete process.env.PLATFORM_ADMIN_PASSWORD; else process.env.PLATFORM_ADMIN_PASSWORD = savedPassword;
  }
});

it("keeps both Excel import formats working after the security upgrade", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Имя", "Телефон"], ["Клиент", "+77011234567"]]), "Contacts");
  for (const format of ["xlsx", "xls"] as const) {
    const data = XLSX.write(workbook, { type: "buffer", bookType: format });
    const parsed = parseContactImportFile(`contacts.${format}`, data.toString("base64"));
    assert.equal(parsed.summary.totalRows, 1);
    assert.equal(parsed.summary.withPhone, 1);
  }
});

it("does not log database or provider secrets in production exceptions", () => {
  const env = process.env.NODE_ENV;
  const logger = console.error;
  const lines: unknown[] = [];
  try {
    process.env.NODE_ENV = "production";
    console.error = (...args) => { lines.push(args); };
    logServerError(new Error("https://provider/?token=private-token customer-private-data"), "request-123");
    assert.doesNotMatch(JSON.stringify(lines), /private-token|customer-private-data/);
    assert.match(JSON.stringify(lines), /request-123/);
  } finally { console.error = logger; if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env; }
});
