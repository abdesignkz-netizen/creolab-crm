import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessAvrReadiness } from "./services/avrReadiness.ts";

const profile = {
  legalName: "ТОО CREOLAB",
  bin: "123456789013",
  legalAddress: "Алматы",
  directorName: "Иванов",
};

const company = {
  name: "ИП Али",
  legalName: null,
  bin: null,
  iin: "222222222220",
  legalAddress: null,
  address: "Астана",
};

describe("avr readiness", () => {
  it("требует подписанный договор с номером и датой", () => {
    const result = assessAvrReadiness({
      dealId: "deal-1",
      itemCount: 1,
      profile,
      company,
    });
    assert.equal(result.ready, false);
    assert.ok(result.missingFields.includes("contract.signed"));
  });

  it("готов, если договор подписан и есть позиции", () => {
    const result = assessAvrReadiness({
      dealId: "deal-1",
      itemCount: 1,
      signedContractId: "contract-1",
      contractNumber: "DOG-2026-0001",
      contractDate: new Date("2026-09-12"),
      profile,
      company,
    });
    assert.equal(result.ready, true);
    assert.deepEqual(result.missingFields, []);
  });
});
