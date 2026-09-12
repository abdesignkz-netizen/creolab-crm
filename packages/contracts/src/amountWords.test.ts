import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { amountToKztWords } from "./amountWords.ts";

describe("amount words", () => {
  it("пишет 850000 тенге", () => {
    assert.equal(amountToKztWords(850000), "восемьсот пятьдесят тысяч тенге");
  });

  it("склоняет тысячу в женском роде", () => {
    assert.equal(amountToKztWords(2000), "две тысячи тенге");
  });

  it("добавляет тиыны", () => {
    assert.equal(amountToKztWords(10.5), "десять тенге пятьдесят тиынов");
  });
});
