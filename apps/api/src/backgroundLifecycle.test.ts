import assert from "node:assert/strict";
import { it } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createBackgroundTaskGroup } from "./services/backgroundTaskGroup.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

it("stopping waits for accepted operations, blocks new work and is repeatable", async () => {
  const slow = gate(), events: string[] = [], jobs = createBackgroundTaskGroup(() => assert.fail("unexpected failure"));
  assert.equal(jobs.run("slow", async () => { events.push("start"); await slow.promise; events.push("commit"); }), true);
  const draining = jobs.drain().then(() => events.push("disconnected"));
  assert.equal(jobs.run("new", async () => { events.push("must not start"); }), false);
  await delay(5);
  assert.deepEqual(events, ["start"]);
  slow.release(); await draining; await jobs.drain();
  assert.deepEqual(events, ["start", "commit", "disconnected"]);
});

it("slow polls cannot pile up and independent reply lanes keep their own capacity", async () => {
  const slow = gate(), fast = gate(), jobs = createBackgroundTaskGroup(() => assert.fail("unexpected failure"));
  let slowCalls = 0, fastCalls = 0;
  for (let n = 0; n < 100; n++) jobs.run("scheduled", async () => { slowCalls++; await slow.promise; });
  for (let n = 0; n < 100; n++) jobs.run("reply", async () => { fastCalls++; await fast.promise; }, 2);
  await delay(5);
  assert.equal(slowCalls, 1); assert.equal(fastCalls, 2);
  fast.release(); await delay(5);
  assert.equal(jobs.run("reply", async () => { fastCalls++; }), true);
  slow.release(); await jobs.drain();
  assert.equal(slowCalls, 1); assert.equal(fastCalls, 3);
});

it("a rejected operation releases capacity, reports once and does not abort a sibling", async () => {
  const slow = gate(), failures: string[] = [], events: string[] = [];
  const jobs = createBackgroundTaskGroup((_error, name) => failures.push(name));
  jobs.run("failure", async () => { throw new Error("synthetic"); });
  jobs.run("slow", async () => { await slow.promise; events.push("finished"); });
  await delay(5);
  assert.deepEqual(failures, ["failure"]);
  assert.equal(jobs.run("failure", async () => { events.push("retry"); }), true);
  slow.release(); await jobs.drain();
  assert.deepEqual(events.sort(), ["finished", "retry"]);
});

it("synchronous throws are contained and empty shutdown completes", async () => {
  const failures: unknown[] = [], jobs = createBackgroundTaskGroup(error => failures.push(error));
  const error = new Error("sync operation failed");
  assert.equal(jobs.run("sync", () => { throw error; }), true);
  await jobs.drain(); assert.deepEqual(failures, [error]);
  await createBackgroundTaskGroup(() => {}).drain();
});

for (const mode of ["drain", "failure"] as const) {
  it(`real background scheduler handles SIGTERM and repeated SIGINT (${mode})`, { timeout: 25_000 }, async () => {
    const child = fork("scripts/check-background-shutdown.ts", [mode], {
      execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "", atDrain = false;
    const messages: string[] = [];
    child.stdout?.on("data", chunk => { output = (output + chunk).slice(-6000); });
    child.stderr?.on("data", chunk => { output = (output + chunk).slice(-6000); });
    child.on("message", message => { messages.push(String(message)); if (message === "draining") atDrain = true; });
    const closed = once(child, "close");
    try {
      for (let i = 0; i < 150 && !messages.includes("ready") && child.exitCode === null; i++) await delay(100);
      assert.ok(messages.includes("ready"), output);
      child.kill("SIGTERM");
      for (let i = 0; i < 50 && !atDrain && child.exitCode === null; i++) await delay(20);
      assert.ok(atDrain, output);
      child.kill("SIGINT");
      await delay(200);
      assert.equal(child.exitCode, null, "must not exit while an accepted DB operation is pending");
      child.send("release");
      const [code, signal] = await closed;
      assert.equal(code, mode === "failure" ? 1 : 0, output); assert.equal(signal, null);
      assert.equal(messages.filter(m => m === "draining").length, 1);
      assert.ok(messages.includes("drained"));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  });
}
