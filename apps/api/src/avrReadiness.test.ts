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
  it("предупреждает об отсутствии договора без блокировки", () => {
    const result = assessAvrReadiness({
      dealId: "deal-1",
      itemCount: 1,
      profile,
      company,
    });
    assert.equal(result.ready, true);
    assert.deepEqual(result.missingFields, []);
    assert.match(result.warnings[0], /не загружен/);
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
  it("неподписанный договор остаётся предупреждением, а реквизиты обязательны",()=>{
    const input={dealId:"deal-1",contractId:"draft-1",contractNumber:"DRAFT-1",contractDate:new Date(),itemCount:1,profile,company};
    const result=assessAvrReadiness(input);
    assert.equal(result.ready,true);assert.match(result.warnings[0],/не подписан/);assert.equal(result.contractId,"draft-1");
    const missing=assessAvrReadiness({...input,contractNumber:"",company:null});
    assert.equal(missing.ready,false);assert.ok(missing.missingFields.includes("contract.number"));assert.ok(missing.missingFields.includes("customer.company"));
  });

});
