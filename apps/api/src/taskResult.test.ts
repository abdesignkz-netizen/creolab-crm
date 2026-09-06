import assert from "node:assert/strict";
import { analyzeTaskResultNextActions } from "./services/taskResultAnalysisService.ts";

const r = await analyzeTaskResultNextActions({
  taskType: "meeting",
  resultCode: "agreed",
  resultText: "Обсудили структуру. Всё подходит. Клиент попросил финальное КП завтра до обеда.",
});

assert.ok(r.suggestions.length >= 1);
assert.ok(r.suggestions.some((s) => s.type === "proposal"));
console.log("result next-action analysis: ok", r.suggestions.map((s) => s.title));
