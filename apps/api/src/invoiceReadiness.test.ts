import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessInvoiceReadiness } from "./services/invoiceReadiness.ts";

const profile = {
  legalName: "ТОО CREOLAB",
  bin: "123456789013",
  legalAddress: "Алматы",
  directorName: "Иванов",
  iban: "KZ86125KZT5004100100",
  bik: "KCJBKZKX",
};

const company = {
  name: "ИП Али",
  legalName: null,
  bin: null,
  iin: "222222222220",
  legalAddress: null,
  address: "Астана",
};

describe("invoice readiness", () => {
  it("требует подписанный договор и банковские реквизиты", () => {
    const result = assessInvoiceReadiness({
      dealId: "deal-1",
      itemCount: 1,
      profile: { ...profile, iban: null, bik: null },
      company,
    });
    assert.equal(result.ready, false);
    assert.ok(result.missingFields.includes("contract.signed"));
    assert.ok(result.missingFields.includes("organization.iban"));
    assert.ok(result.missingFields.includes("organization.bik"));
  });

  it("готов, если договор подписан и есть ИИК/БИК", () => {
    const result = assessInvoiceReadiness({
      dealId: "deal-1",
      itemCount: 1,
      signedContractId: "contract-1",
      profile,
      company,
    });
    assert.equal(result.ready, true);
    assert.deepEqual(result.missingFields, []);
    assert.equal(result.signedContractId, "contract-1");
  });
});
