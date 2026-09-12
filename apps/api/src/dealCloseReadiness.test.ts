import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessDealCloseReadiness } from "./services/dealCloseReadiness.ts";

describe("Deal close readiness after ESF", () => {
  it("ждёт отправленную и доставленную ЭСФ", () => {
    const empty = assessDealCloseReadiness({ dealId: "d1" });
    assert.equal(empty.ready, false);
    assert.ok(empty.missingFields.includes("esf.sent"));

    const sent = assessDealCloseReadiness({
      dealId: "d1",
      esfExternalId: "77",
      esfStatus: "SENT",
      esfExternalStatus: "CREATED",
    });
    assert.equal(sent.ready, false);
    assert.ok(sent.missingFields.includes("esf.accepted"));

    const delivered = assessDealCloseReadiness({
      dealId: "d1",
      esfExternalId: "77",
      esfStatus: "ACCEPTED",
      esfExternalStatus: "DELIVERED",
    });
    assert.equal(delivered.ready, true);
    assert.deepEqual(delivered.missingFields, []);
  });

  it("считает уже выигранную сделку готовой", () => {
    const won = assessDealCloseReadiness({ dealId: "d1", outcome: "won" });
    assert.equal(won.ready, true);
    assert.equal(won.alreadyClosed, true);
  });
});
