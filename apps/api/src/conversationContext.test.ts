import assert from "node:assert/strict";
import { parseScheduleHint } from "../src/services/conversationContextService.ts";

const now = new Date("2026-09-06T10:00:00+05:00");
const tz = "Asia/Almaty";

const tomorrow = parseScheduleHint("Давайте завтра в 16:00 по Meet", now, tz);
assert.equal(tomorrow.datePart, true);
assert.equal(tomorrow.timePart, true);
assert.ok(tomorrow.at);

const noTime = parseScheduleHint("Давайте завтра встретимся", now, tz);
assert.equal(noTime.datePart, true);
assert.equal(noTime.timePart, false);

const friday = parseScheduleHint("Давайте в пятницу в 15:00", now, tz);
assert.equal(friday.datePart, true);
assert.equal(friday.timePart, true);

console.log("conversationContext schedule parse: ok");
