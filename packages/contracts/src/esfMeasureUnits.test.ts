import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ESF_DEFAULT_MEASURE_UNIT_CODE,
  ESF_MEASURE_UNITS,
  esfMeasureUnitShortLabel,
  esfMeasureUnitSymbol,
  resolveEsfMeasureUnitCode,
} from "./esfMeasureUnits.ts";

describe("ESF measure units", () => {
  it("maps portal aliases and numeric codes to OKEI", () => {
    assert.equal(resolveEsfMeasureUnitCode("услуга"), "796");
    assert.equal(resolveEsfMeasureUnitCode("шт"), "796");
    assert.equal(resolveEsfMeasureUnitCode("час"), "356");
    assert.equal(resolveEsfMeasureUnitCode("796"), "796");
    assert.equal(resolveEsfMeasureUnitCode("6"), "006");
    assert.equal(resolveEsfMeasureUnitCode("123"), "123");
    assert.equal(resolveEsfMeasureUnitCode(""), ESF_DEFAULT_MEASURE_UNIT_CODE);
    assert.equal(esfMeasureUnitSymbol("услуга"), "шт");
    assert.equal(esfMeasureUnitShortLabel("час"), "ч (356)");
  });

  it("keeps unique OKEI codes", () => {
    const codes = ESF_MEASURE_UNITS.map((unit) => unit.code);
    assert.equal(new Set(codes).size, codes.length);
  });
});
