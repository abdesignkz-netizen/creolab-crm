import assert from "node:assert/strict";
import { before, after, it } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, server: Server, url: string, scratch: string;
const cwd = process.cwd();
before(async () => {
  db = await createPrismaClient();
  scratch = await mkdtemp(path.join(tmpdir(), "basqar-web-delivery-"));
  const dist = path.join(scratch, "apps/web/dist");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), '<html><div id="root">Current application</div></html>');
  await writeFile(path.join(dist, "assets/current.js"), 'export const version = "current";');
  process.chdir(scratch);
  const app = createApp(db);
  process.chdir(cwd);
  server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  process.chdir(cwd);
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (db) await db.$disconnect();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

it("checkout and index HTML are never cached across deployments", async () => {
  for (const route of ["/billing/checkout/test-order", "/index.html", "/"]) {
    const response = await fetch(url + route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(await response.text(), /Current application/);
  }
});

it("an obsolete checkout chunk returns 404, never a successful HTML response", async () => {
  const missing = await fetch(url + "/assets/BillingCheckoutPage-obsolete.js");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await missing.text(), /Current application/);
  const current = await fetch(url + "/assets/current.js");
  assert.equal(current.status, 200);
  assert.match(current.headers.get("content-type") || "", /javascript/);
  assert.match(await current.text(), /version = "current"/);
});
