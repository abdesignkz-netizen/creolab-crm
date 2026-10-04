import assert from "node:assert/strict";
import { it, mock } from "node:test";
import dns from "node:dns/promises";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { downloadPublicMedia } from "./lib/publicMedia.ts";

it("pins the DNS-validated address to HTTPS and preserves hostname certificate verification", async () => {
  let lookups = 0;
  mock.method(dns, "lookup", async () => { lookups++; return [{ address: "8.8.8.8", family: 4 }]; });
  mock.method(https, "request", (url, options, callback) => {
    assert.equal(url.hostname, "media.example");
    assert.equal(options.agent, false);
    assert.notEqual(options.rejectUnauthorized, false);
    options.lookup("media.example", {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, "8.8.8.8"); assert.equal(family, 4);
    });
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => queueMicrotask(() => {
      const res = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "image/png" } });
      callback(res); res.end(Buffer.from("image"));
    });
    return req;
  });
  syncBuiltinESMExports();
  try {
    const result = await downloadPublicMedia("https://media.example/file", 100);
    assert.equal(result.buffer.toString(), "image");
    assert.equal(result.contentType, "image/png");
    assert.equal(lookups, 1);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

it("rejects mixed public/private DNS answers before opening a connection", async () => {
  mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]);
  const request = mock.method(https, "request", () => { throw new Error("should_not_connect"); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(downloadPublicMedia("https://media.example/file", 100), /media_url_forbidden/);
    assert.equal(request.mock.callCount(), 0);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

it("rechecks redirect targets and refuses redirects into the server's private network", async () => {
  mock.method(dns, "lookup", async hostname => [{ address: hostname === "internal.example" ? "169.254.169.254" : "8.8.8.8", family: 4 }]);
  const request = mock.method(https, "request", (_url, _options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => queueMicrotask(() => callback(Object.assign(new PassThrough(), {
      statusCode: 302, headers: { location: "https://internal.example/credentials" },
    })));
    return req;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(downloadPublicMedia("https://media.example/file", 100), /media_url_forbidden/);
    assert.equal(request.mock.callCount(), 1);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

it("stops oversized streamed responses even without a Content-Length header", async () => {
  mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  mock.method(https, "request", (_url, _options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => queueMicrotask(() => {
      const res = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
      callback(res); res.write(Buffer.alloc(101));
    });
    return req;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(downloadPublicMedia("https://media.example/file", 100), /media_too_large/); }
  finally { mock.restoreAll(); syncBuiltinESMExports(); }
});
