import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAutomationPolicy } from "./services/aiAutomationPolicyService.ts";
import { analyzeRequestHeuristic, applyRefinedRequestAnalysis, sanitizeClientMessageDraft } from "./services/requestAnalysisService.ts";
import {
  DEFAULT_AI_AUTOMATION,
  MODE_FLAGS,
  applyModeToSettings,
  isWithinAiSchedule,
  mergeAIAutomationIntoSettingsJson,
  parseAIAutomationSettings,
} from "./services/aiAutomationSettings.ts";
import { classifyWhatsAppDeliveryError, WHATSAPP_NOT_REGISTERED } from "./services/whatsappChannel.ts";

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

  it("parses schedule windows and always mode", () => {
    const settings = parseAIAutomationSettings({
      aiAutomation: {
        scheduleMode: "working_hours",
        workingHours: { days: [1, 2, 3], start: "10:00", end: "12:00" },
      },
    });
    assert.equal(settings.scheduleMode, "working_hours");
    assert.deepEqual(settings.workingHours.days, [1, 2, 3]);
    assert.equal(isWithinAiSchedule(new Date("2026-09-07T03:00:00Z"), "Asia/Almaty", {
      scheduleMode: "always",
      workingHours: settings.workingHours,
      customSchedule: settings.customSchedule,
    }), true);
    // Monday 2026-09-07 11:00 Almaty = 06:00 UTC
    assert.equal(
      isWithinAiSchedule(new Date("2026-09-07T06:00:00Z"), "Asia/Almaty", settings),
      true,
    );
    // Monday 08:00 Almaty = 03:00 UTC — outside 10-12
    assert.equal(
      isWithinAiSchedule(new Date("2026-09-07T03:00:00Z"), "Asia/Almaty", settings),
      false,
    );
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

  it("reads stored AUTO and ignores leftover website_form CONFIRM", () => {
    const settings = parseAIAutomationSettings({
      aiAutomation: {
        defaultMode: "AUTO",
        sourceModes: { website_form: "CONFIRM", manual: "MANUAL" },
      },
    });
    assert.equal(settings.defaultMode, "AUTO");
    assert.equal(settings.sourceModes.website_form, undefined);
    const decision = decideAutomationPolicy({
      settingsJson: mergeAIAutomationIntoSettingsJson({}, settings),
      sourceChannel: "website_form",
    });
    assert.equal(decision.mode, "AUTO");
    assert.equal(decision.autoStart, true);
  });

  it("AUTO default applies to website form instead of factory CONFIRM", () => {
    const decision = decideAutomationPolicy({
      settingsJson: mergeAIAutomationIntoSettingsJson(
        {},
        applyModeToSettings(DEFAULT_AI_AUTOMATION, "AUTO"),
      ),
      sourceChannel: "website_form",
      sourceType: "website_form",
    });
    assert.equal(decision.mode, "AUTO");
    assert.equal(decision.autoStart, true);
    assert.equal(decision.allowOutbound, true);
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

describe("WhatsApp delivery errors", () => {
  it("recognizes an unregistered number", () => {
    const unregistered = classifyWhatsAppDeliveryError("Whatsapp number not exists. The number is not registered");
    assert.equal(unregistered.code, WHATSAPP_NOT_REGISTERED);
    assert.match(unregistered.message, /не зарегистрирован в WhatsApp/i);
  });

  it("maps a missing WhatsApp connection", () => {
    const missing = classifyWhatsAppDeliveryError("not_configured");
    assert.equal(missing.code, "NO_AUTOMATED_CHANNEL");
    assert.match(missing.message, /не подключ/i);
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

  it("builds client WhatsApp draft instead of internal briefing", () => {
    const analysis = analyzeRequestHeuristic({
      name: "аппап",
      description: "Нужен сайт для строительства",
      serviceCategory: "web",
      budgetMin: 77777,
      budgetMax: 77777,
      phoneNormalized: "77777777777",
    });
    assert.match(analysis.taskObjective, /Бюджет — 77777/);
    assert.match(analysis.taskObjective, /Услуга — web/);
    assert.doesNotMatch(analysis.clientMessageDraft, /^Уже известно:/);
    assert.match(analysis.clientMessageDraft, /Здравствуйте/i);
    assert.match(analysis.clientMessageDraft, /сайт для строительства/i);
    assert.doesNotMatch(analysis.clientMessageDraft, /77777777777/);
  });

  it("draft for a presentation request keeps the tender context", () => {
    const analysis = analyzeRequestHeuristic({
      name: "Алия",
      subject: "Презентация · Для тендеров",
      description: "Нужна презентация для тендера",
    });
    assert.match(analysis.clientMessageDraft, /Здравствуйте, Алия/i);
    assert.match(analysis.clientMessageDraft, /тендер/i);
    assert.doesNotMatch(analysis.clientMessageDraft, /^Уже известно:/);
  });

  it("uses LLM WhatsApp copy when the draft is valid", () => {
    const draft = analyzeRequestHeuristic({
      description: "Нужна презентация для тендера",
    });
    const merged = applyRefinedRequestAnalysis(
      draft,
      {
        clientMessageDraft:
          "Здравствуйте! Получили заявку на презентацию для тендера. Для какого конкурса она нужна и какой примерно объём?",
      },
      { description: "Нужна презентация для тендера" },
    );
    assert.match(merged.clientMessageDraft, /какого конкурса/i);
    assert.equal(sanitizeClientMessageDraft("{not a message}"), null);
  });

  it("detects presentation from free text", () => {
    const analysis = analyzeRequestHeuristic({
      description: "Нужна инвестиционная презентация",
      landingPage: "/website",
    });
    assert.equal(analysis.serviceCategory, "presentation");
  });
});
