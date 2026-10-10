import assert from "node:assert/strict";
import { it } from "node:test";
import { AI_MANAGER_GOALS, AI_MANAGER_ROLES, compileAiManagerDraft, emptyAiManagerDraft, getAiSetupScenarios } from "@creolab/contracts";

it("provides localized role goals and requires concrete completion criteria", () => {
  for (const role of AI_MANAGER_ROLES) {
    const goals = AI_MANAGER_GOALS.filter(goal => goal.roles.includes(role));
    assert.ok(goals.length, role);
    for (const goal of goals) for (const lang of ["ru", "kk", "en"] as const) {
      for (const key of ["label", "goal", "questions", "completion", "successCriteria"] as const) assert.ok(goal[key][lang].trim());
      const draft = emptyAiManagerDraft("Компания"); draft.primaryRole = role;
      Object.assign(draft.conversation, { goalPreset: goal.id, goal: goal.goal[lang], questions: goal.questions[lang], completion: goal.completion[lang], successCriteria: goal.successCriteria[lang] });
      assert.ok(!compileAiManagerDraft(draft).issues.some(issue => issue.field.startsWith("conversation")), `${role}:${goal.id}:${lang}`);
    }
  }
  const draft = emptyAiManagerDraft(); draft.primaryRole = "sales"; draft.conversation.goal = "продавать";
  const codes = compileAiManagerDraft(draft).issues.map(issue => issue.code);
  for (const code of ["goal_too_vague", "sales_questions", "completion", "success_criteria"]) assert.ok(codes.includes(code));
  draft.offerings = [{ id: "one", name: "Дизайн", description: "Презентация", price: "", includes: "", timing: "", restrictions: "" }];
  assert.ok(compileAiManagerDraft(draft).issues.some(issue => issue.code === "offering_price" && issue.level === "error"));
});
it("keeps Russian and Kazakh test prompts independent of UI locale and adds sales checks", () => {
  const draft = emptyAiManagerDraft();
  let cases = getAiSetupScenarios(draft);
  assert.deepEqual(cases.filter(item => item.required).map(item => item.id), ["goal_ru", "goal_kk", "unknown_fact", "off_topic"]);
  for (const lang of ["ru", "kk", "en"] as const) {
    assert.match(cases.find(item => item.id === "goal_ru")!.message[lang], /Здравствуйте/);
    assert.match(cases.find(item => item.id === "goal_kk")!.message[lang], /Сәлеметсіз/);
  }
  draft.additionalRoles = ["sales"];
  cases = getAiSetupScenarios(draft);
  assert.equal(cases.find(item => item.id === "objection")?.required, true);
  assert.equal(cases.find(item => item.id === "handoff")?.required, false);
});
it("accepts old questionnaires without new optional fields as incomplete drafts", () => {
  const draft = emptyAiManagerDraft();
  delete (draft.conversation as any).successCriteria;
  delete (draft.conversation as any).goalPreset;
  assert.ok(compileAiManagerDraft(draft).issues.some(issue => issue.code === "success_criteria"));
});
