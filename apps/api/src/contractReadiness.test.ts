import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessContractReadiness } from "./services/contractReadiness.ts";

describe("contract readiness", () => {
  it("требует компанию покупателя и позиции", () => {
    const result = assessContractReadiness({
      dealId: "deal-1",
      itemCount: 0,
      profile: {
        legalName: "ТОО CREOLAB",
        bin: "123456789013",
        legalAddress: "Алматы",
        directorName: "Иванов",
      },
      company: null,
    });
    assert.equal(result.ready, false);
    assert.deepEqual(result.missingFields, ["customer.company", "deal.items"]);
  });

  it("принимает ИИН продавца вместо БИН", () => {
    const result = assessContractReadiness({
      dealId: "deal-1",
      itemCount: 1,
      profile: {
        legalName: "ИП Селлер",
        bin: null,
        iin: "123456789013",
        legalAddress: "Алматы",
        directorName: "Иванов",
      },
      company: {
        name: "ИП Али",
        legalName: null,
        bin: null,
        iin: "222222222220",
        legalAddress: null,
        address: "Астана",
      },
    });
    assert.equal(result.ready, true);
  });

  it("принимает ИИН и обычный адрес покупателя", () => {
    const result = assessContractReadiness({
      dealId: "deal-1",
      itemCount: 1,
      profile: {
        legalName: "ТОО CREOLAB",
        bin: "123456789013",
        legalAddress: "Алматы",
        directorName: "Иванов",
      },
      company: {
        name: "ИП Али",
        legalName: null,
        bin: null,
        iin: "222222222220",
        legalAddress: null,
        address: "Астана",
      },
    });
    assert.equal(result.ready, true);
    assert.deepEqual(result.missingFields, []);
  });
});
