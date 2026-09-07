import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { badgeHint } from "./services/navBadgesService.ts";

describe("nav badge hints", () => {
  it("explains a Situation total as a breakdown, not a bare number", () => {
    const hint = badgeHint(4, ["1 диалог без ответа", "1 просроченная задача", "2 новые или ждущие заявки"]);
    assert.match(hint, /4 пункта требуют внимания/);
    assert.match(hint, /диалог без ответа/);
    assert.match(hint, /просроченная задача/);
    assert.match(hint, /заявки/);
  });

  it("returns empty hint when there is nothing to notify", () => {
    assert.equal(badgeHint(0, ["1 диалог без ответа"]), "");
  });
});
