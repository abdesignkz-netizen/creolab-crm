import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enumerateBucketKeys,
  formatBucketLabel,
  isoWeekKeyFromYmd,
  zonedLocalToUtc,
} from "./services/periodRange.ts";

describe("period buckets for analytics trend", () => {
  it("enumerates each day of the range and formats Russian labels", () => {
    const from = zonedLocalToUtc("Asia/Almaty", 2026, 9, 1);
    const to = zonedLocalToUtc("Asia/Almaty", 2026, 9, 8);
    const keys = enumerateBucketKeys(from, to, "day", "Asia/Almaty");
    assert.deepEqual(keys, [
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
      "2026-09-07",
    ]);
    assert.match(formatBucketLabel("2026-09-07", "day"), /7/);
    assert.match(formatBucketLabel("2026-09-07", "day"), /сен/i);
  });

  it("builds ISO week keys", () => {
    assert.equal(isoWeekKeyFromYmd({ year: 2026, month: 9, day: 7 }), "2026-W37");
  });
});
