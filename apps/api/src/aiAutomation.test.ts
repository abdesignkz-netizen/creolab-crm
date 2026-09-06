import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAutomationPolicy } from "./services/aiAutomationPolicyService.ts";
import { analyzeRequestHeuristic } from "./services/requestAnalysisService.ts";
import {
  DEFAULT_AI_AUTOMATION,
  MODE_FLAGS,
  applyModeToSettings,
  mergeAIAutomationIntoSettingsJson,
  parseAIAutomationSettings,
} from "./services/aiAutomationSettings.ts";

describe("AI automation policy", () => {
  it("maps UI modes to flags", () => {
    assert.deepEqual(MODE_FLAGS.MANUAL, {
      analyzeNewRequests: false,
      autoCreateAiTask: false,
      autoStartAiManager: false,
    });
    assert.deepEqual(MODE_FLAGS.ASSIST, {
      analyzeNewRequests: true,
      autoCreateAiTask: false,
      autoStartAiManager: false,
    });
    assert.deepEqual(MODE_FLAGS.CONFIRM, {
      analyzeNewRequests: true,
      autoCreateAiTask: true,
      autoStartAiManager: false,
    });
    assert.deepEqual(MODE_FLAGS.AUTO, {
      analyzeNewRequests: true,
      autoCreateAiTask: true,
      autoStartAiManager: true,
    });
  });

  it("safe default is CONFIRM", () => {
    const settings = parseAIAutomationSettings({});
    assert.equal(settings.defaultMode, "CONFIRM");
    assert.equal(settings.autoStartAiManager, false);
  });

  it("source rule beats global default", () => {
    const decision = decideAutomationPolicy({
      settingsJson: mergeAIAutomationIntoSettingsJson({}, DEFAULT_AI_AUTOMATION),
      sourceChannel: "manual",
    });
    assert.equal(decision.mode, "MANUAL");
    assert.equal(decision.analyze, false);
    assert.match(decision.reason, /источника/i);
  });

  it("client override beats source", () => {
    const decision = decideAutomationPolicy({
      settingsJson: mergeAIAutomationIntoSettingsJson(
        {},
        applyModeToSettings(DEFAULT_AI_AUTOMATION, "AUTO"),
      ),
      sourceChannel: "website_form",
      clientAiMode: "OFF",
    });
    assert.equal(decision.mode, "MANUAL");
    assert.equal(decision.clientOverride, "OFF");
  });

  it("doNotContact hard-blocks outbound", () => {
    const decision = decideAutomationPolicy({
      settingsJson: mergeAIAutomationIntoSettingsJson(
        {},
        applyModeToSettings(DEFAULT_AI_AUTOMATION, "AUTO"),
      ),
      sourceChannel: "website_form",
      doNotContact: true,
    });
    assert.equal(decision.mode, "MANUAL");
    assert.equal(decision.hardBlocked, true);
    assert.equal(decision.allowOutbound, false);
  });
});

describe("Request analysis heuristic", () => {
  it("prefers client text over landing for service", () => {
    const analysis = analyzeRequestHeuristic({
      name: "Александр",
      companyName: "ABC Construction",
      description:
        "Нужен корпоративный сайт строительной компании примерно на 15 страниц. Хотим запуститься в течение месяца.",
      landingPage: "/presentation",
      serviceCategory: "presentation",
      phoneNormalized: "+77011234567",
    });
    assert.equal(analysis.serviceCategory, "web");
    assert.ok(analysis.knownFields.some((f) => f.key === "structure"));
    assert.ok(analysis.knownFields.some((f) => f.key === "deadline"));
    assert.ok(analysis.missingFields.some((f) => f.key === "budget"));
    assert.match(analysis.taskTitle, /сайт/i);
    assert.notEqual(analysis.taskTitle, "Обработать новую заявку");
  });

  it("detects presentation from free text", () => {
    const analysis = analyzeRequestHeuristic({
      description: "Нужна инвестиционная презентация",
      landingPage: "/website",
    });
    assert.equal(analysis.serviceCategory, "presentation");
  });
});
