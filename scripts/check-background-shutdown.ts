import assert from "node:assert/strict";
import { createPrismaClient, disconnectPrismaClient } from "../packages/db/src/client.ts";
import { assertTestDatabase } from "../apps/api/src/testSupport/testDatabase.ts";
import { startBackgroundJobs } from "../apps/api/src/services/backgroundJobs.ts";
import { installShutdownHandler } from "../apps/api/src/lib/shutdown.ts";

assertTestDatabase();
assert.ok(process.send, "Run only through backgroundLifecycle.test.ts");
const mode = process.argv[2];
assert.ok(["drain", "failure"].includes(mode));
const db = await createPrismaClient({ registerSignalHandlers: false });
let reached!: () => void, release!: () => void;
const blocked = new Promise<void>(resolve => { reached = resolve; });
const pending = new Promise<void>(resolve => { release = resolve; });
process.on("message", message => { if (message === "release") release(); });
// Hold a real scheduler poll at a DB boundary so SIGTERM is delivered in flight.
const proxy = new Proxy(db, { get(target, key) {
  if (key !== "outboxEvent") return Reflect.get(target, key);
  return new Proxy(target.outboxEvent, { get(delegate, field) {
    if (field !== "findMany") return Reflect.get(delegate, field);
    return async (...args: Parameters<typeof delegate.findMany>) => {
      reached(); await pending;
      return delegate.findMany(...args);
    };
  } });
} });
process.env.NODE_ENV = "production";
const stop = startBackgroundJobs(proxy, { keepAlive: true });
installShutdownHandler(async () => {
  process.send!("draining");
  await stop();
  process.send!("drained");
  await disconnectPrismaClient();
  if (mode === "failure") throw new Error("synthetic cleanup failure");
});
await blocked;
process.send!("ready");
