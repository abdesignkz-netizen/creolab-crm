import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { EsfNcaLayerClient } from "../../web/src/lib/signing/esfNcaLayerClient.ts";
import { ESF_NCALAYER_SERVICE, NCALAYER_ACCESSORY_GET_BUNDLES, NCALAYER_ACCESSORY_GET_SERVICES } from "@creolab/contracts";

const originalWebSocket = globalThis.WebSocket;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let frames: Record<string, unknown>[];
let active = false;
let signCode = "200";
let signMessage = "action.canceled";
let unavailable = false;
const timers = new Set<ReturnType<typeof setTimeout>>();
class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { queueMicrotask(() => unavailable ? this.onerror?.() : this.onmessage?.({ data: '{"version":"test"}' })); }
  send(data: string) {
    assert.equal(active, false, "A second request must not overwrite a pending response handler");
    active = true;
    const frame = JSON.parse(data);
    frames.push(frame);
    queueMicrotask(() => {
      active = false;
      const response = frame.method === NCALAYER_ACCESSORY_GET_BUNDLES
        ? { result: { "com.osdkz.esf.signer": "1.2" } }
        : frame.method === NCALAYER_ACCESSORY_GET_SERVICES
          ? { result: [ESF_NCALAYER_SERVICE] }
          : { code: signCode, message: signCode === "200" ? null : signMessage, responseObject: signCode==="200" ? { signature: "c2ln", pem: "SIGN-PEM", keyInfo: { algorithm: "GOST" } } : {} };
      this.onmessage?.({ data: JSON.stringify(response) });
    });
  }
  close() { this.readyState = 3; }
}
beforeEach(() => {
  frames = []; active = false; signCode = "200"; signMessage="action.canceled"; unavailable=false;
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeWebSocket });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: (fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout,
  } });
});
afterEach(() => {
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: originalWebSocket });
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  timers.forEach(clearTimeout); timers.clear();
});

describe("NCALayer single-response transport", () => {
  it("reports an unavailable local NCALayer without sending sign requests",async()=>{
    unavailable=true;const client=new EsfNcaLayerClient();
    assert.equal(await client.isAvailable(),false);assert.equal(frames.length,0);client.disconnect();
  });
  it("rejects wrong PIN feedback without returning a signature or sending a PIN",async()=>{
    signCode="500";signMessage="Неверный PIN";const client=new EsfNcaLayerClient();
    await assert.rejects(client.signPlainData("<awp/>"),(error:any)=>error.code==="SIGNATURE_FAILED"&&/PIN/.test(error.message));
    assert.ok(frames.every(f=>!("pin" in f)&&!("password" in f)));client.disconnect();
  });
  it("detects the official module without overlapping probe requests", async () => {
    const client = new EsfNcaLayerClient();
    const probe = await client.probe();
    assert.equal(probe.officialModuleInstalled, true);
    assert.equal(probe.serviceName, ESF_NCALAYER_SERVICE);
    assert.deepEqual(frames.map(f => f.method), [NCALAYER_ACCESSORY_GET_BUNDLES, NCALAYER_ACCESSORY_GET_SERVICES]);
    client.disconnect();
  });
  it("signs the exact XML after probing and does not invoke AUTH", async () => {
    const client = new EsfNcaLayerClient();
    const xml = '<awp>Кириллица\r\n  &amp;</awp>\n';
    const signed = await client.signPlainData(xml);
    assert.equal(signed.publicCertificate, "SIGN-PEM");
    assert.equal(frames.at(-1)?.data, xml);
    assert.equal(frames.at(-1)?.method, "signPlainData");
    assert.ok(!frames.some(f => f.method === "auth"));
    client.disconnect();
  });
  it("preserves cancellation instead of treating it as a signature", async () => {
    signCode = "500";
    const client = new EsfNcaLayerClient();
    await assert.rejects(client.signPlainData("<awp/>"), (error: any) => error.code === "USER_CANCELLED");
    client.disconnect();
  });
});
