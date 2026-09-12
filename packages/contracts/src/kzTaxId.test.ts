import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidKzTaxId, normalizeKzTaxId } from "./kzTaxId.ts";

describe("kz tax id", () => {
  it("принимает БИН с верной контрольной цифрой", () => {
    assert.equal(isValidKzTaxId("123456789013"), true);
    assert.equal(normalizeKzTaxId("123 456 789 013"), "123456789013");
  });

  it("отклоняет короткий и неверный номер", () => {
    assert.equal(isValidKzTaxId("12345678901"), false);
    assert.equal(isValidKzTaxId("123456789012"), false);
    assert.equal(isValidKzTaxId(""), false);
  });
});
