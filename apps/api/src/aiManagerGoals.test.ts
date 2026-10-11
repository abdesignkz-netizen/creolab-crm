import assert from "node:assert/strict";
import { it } from "node:test";
import { aiManagerDraftKey, applyAiManagerGoal, AI_MANAGER_GOALS, AI_MANAGER_ROLES, compileAiManagerDraft, emptyAiManagerDraft, getAiSetupScenarios } from "@creolab/contracts";

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

it("does not label preserved custom flow as a newly selected preset", () => {
  const draft = emptyAiManagerDraft();
  const goal = AI_MANAGER_GOALS.find(goal => goal.id === "booking_request")!;
  draft.conversation.goal = "Сохранить мой особый процесс";
  const partial = applyAiManagerGoal(draft.conversation, goal, "ru", false);
  assert.equal(partial.goalPreset, "custom"); assert.equal(partial.goal, draft.conversation.goal);
  assert.equal(partial.completion, goal.completion.ru);
  const full = applyAiManagerGoal(partial, goal, "ru", true);
  assert.equal(full.goalPreset, goal.id); assert.equal(full.goal, goal.goal.ru);
  draft.conversation = full;
  assert.ok(compileAiManagerDraft(draft).issues.some(issue => issue.code === "goal_role_mismatch"));
  draft.primaryRole = "booking";
  assert.ok(!compileAiManagerDraft(draft).issues.some(issue => issue.code === "goal_role_mismatch"));
});
it("warns about legacy integration commands without deleting business facts", () => {
  const draft = emptyAiManagerDraft(); draft.additionalInstructions = "Цена: 1000 тенге. manager_event=handoff означает создание заявки. send_asset=brochure";
  const result = compileAiManagerDraft(draft);
  assert.ok(result.issues.some(issue => issue.code === "legacy_protocol"));
  assert.ok(result.prompt.includes(draft.additionalInstructions));
});

it("does not mark a saved questionnaire dirty when JSONB changes key order", () => {
  const draft = emptyAiManagerDraft("Демо");
  const reordered = Object.fromEntries(Object.entries(draft).reverse()) as typeof draft;
  reordered.conversation = Object.fromEntries(Object.entries(draft.conversation).reverse()) as typeof draft.conversation;
  assert.notEqual(JSON.stringify(draft), JSON.stringify(reordered));
  assert.equal(aiManagerDraftKey(draft), aiManagerDraftKey(reordered));
  reordered.conversation.goal = "Изменённая цель";
  assert.notEqual(aiManagerDraftKey(draft), aiManagerDraftKey(reordered));
});
