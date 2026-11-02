import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import { createApiClient } from "../../../packages/api-client/src/index.ts";

afterEach(() => mock.restoreAll());
function client() {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { calls, api: createApiClient({ baseUrl: "https://local-api.example.test", getTenantId: () => "fixture-company" }) };
}
it("uses distinct Control settings and board endpoints and preserves paging/filter values", async () => {
  const { api, calls } = client();
  await api.controlSettings(); await api.controlBoard(); await api.salesControl({ filter: "urgent", offset: 0, limit: 50 });
  await api.workspaceAudit({ query: "Айбек & партнёры", offset: 0, empty: "", absent: undefined });
  await api.controlHistory(); await api.analyticsDashboard({ currency: "KZT", period: "this_month" }); await api.analyticsTrend({ metric: "revenue" });
  assert.deepEqual(calls.slice(0, 3).map(c => c.url.pathname), ["/api/v1/workspace/control", "/api/v1/workspace/control/board", "/api/v1/sales/control"]);
  assert.deepEqual(Object.fromEntries(calls[2].url.searchParams), { filter: "urgent", offset: "0", limit: "50" });
  assert.deepEqual(Object.fromEntries(calls[3].url.searchParams), { query: "Айбек & партнёры", offset: "0" });
  assert.equal(calls[4].url.search, ""); assert.equal(calls[5].url.searchParams.get("period"), "this_month"); assert.equal(calls[6].url.searchParams.get("metric"), "revenue");
  assert.ok(calls.every(c => new Headers(c.init.headers).get("x-tenant-id") === "fixture-company"));
});
it("encodes the retry target and sends the same confirmation key unchanged on a repeated request", async () => {
  const { api, calls } = client();
  const body = { requestId: "8a9b252e-5277-4d18-8c61-a956451b2f05", failedAt: "2026-11-01T05:00:00.000Z", confirmed: true as const };
  await api.outboxFailures(25); await api.retryOutboxFailure("context:message/1", body); await api.retryOutboxFailure("context:message/1", body);
  assert.equal(calls[0].url.searchParams.get("offset"), "25");
  for (const call of calls.slice(1)) {
    assert.equal(call.url.pathname, "/api/v1/workspace/outbox/context%3Amessage%2F1/retry"); assert.equal(call.init.method, "POST");
    assert.deepEqual(JSON.parse(String(call.init.body)), body);
  }
});
