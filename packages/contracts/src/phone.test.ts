import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateClientPhone } from "./phone.ts";

describe("validateClientPhone", () => {
  it("принимает международный номер Казахстана", () => {
    const result = validateClientPhone("+7 701 000 00 01", "KZ");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.e164, "+77010000001");
      assert.equal(result.normalized, "77010000001");
    }
  });

  it("принимает локальный номер с регионом компании", () => {
    const result = validateClientPhone("87010000002", "KZ");
    assert.equal(result.ok, true);
  });

  it("отклоняет пустое значение", () => {
    const result = validateClientPhone("   ");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "missing_phone");
  });

  it("отклоняет шаблон из документации", () => {
    const result = validateClientPhone("<телефон_клиента_в_международном_формате>");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid_phone");
  });

  it("не считает email заменой телефона", () => {
    const result = validateClientPhone("demo@example.invalid");
    assert.equal(result.ok, false);
  });
});
