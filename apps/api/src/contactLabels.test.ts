import assert from "node:assert/strict";
import { it } from "node:test";
import { phoneFromContact } from "./services/contactLabels.ts";

it("does not display WhatsApp LIDs or other opaque thread IDs as phone numbers", () => {
  for (const externalThreadId of ["36322639085811@lid", "77019998877@lid", "77019998877:42@lid", "123456789012@g.us", "telegram:77019998877", "00000000-0000-0000-0000-000000000000"]) {
    assert.equal(phoneFromContact(null, { externalThreadId }), null, externalThreadId);
  }
});

it("displays real WhatsApp phone JIDs without a device suffix and retains legacy phone threads", () => {
  for (const externalThreadId of ["77019998877@s.whatsapp.net", "77019998877:42@s.whatsapp.net", "77019998877@c.us", "77019998877"]) {
    assert.equal(phoneFromContact(null, { externalThreadId }), "+7 701 999 88 77");
  }
});

it("prefers an explicitly stored phone over the transport identity", () => {
  assert.equal(phoneFromContact({ methods: [{ type: "phone", rawValue: "+7 701 222 33 44", primary: true }] }, { externalThreadId: "36322639085811@lid" }), "+7 701 222 33 44");
});
