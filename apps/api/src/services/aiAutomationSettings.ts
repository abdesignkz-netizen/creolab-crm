/** AI Manager automation for new requests — Tenant.settingsJson.aiAutomation */

export type AutomationMode = "MANUAL" | "ASSIST" | "CONFIRM" | "AUTO";

export type FirstContactSlaMinutes = 5 | 10 | 15 | 30 | 60;

export type ScheduleMode = "always" | "working_hours" | "custom";

export type AIAutomationSettings = {
  defaultMode: AutomationMode;
  analyzeNewRequests: boolean;
  autoCreateAiTask: boolean;
  autoStartAiManager: boolean;
  allowProactiveOutbound: boolean;
  processRepeatRequests: boolean;
  firstContactSlaMinutes: FirstContactSlaMinutes;
  scheduleMode: ScheduleMode;
  /** sourceChannel / sourceType → mode override */
  sourceModes: Record<string, AutomationMode>;
  /** serviceCategory → mode override */
  serviceModes: Record<string, AutomationMode>;
  /** integrationId → mode override */
  integrationModes: Record<string, AutomationMode>;
};

export const MODE_FLAGS: Record<
  AutomationMode,
  { analyzeNewRequests: boolean; autoCreateAiTask: boolean; autoStartAiManager: boolean }
> = {
  MANUAL: { analyzeNewRequests: false, autoCreateAiTask: false, autoStartAiManager: false },
  ASSIST: { analyzeNewRequests: true, autoCreateAiTask: false, autoStartAiManager: false },
  CONFIRM: { analyzeNewRequests: true, autoCreateAiTask: true, autoStartAiManager: false },
  AUTO: { analyzeNewRequests: true, autoCreateAiTask: true, autoStartAiManager: true },
};

export const MODE_LABEL: Record<AutomationMode, string> = {
  MANUAL: "Ручной",
  ASSIST: "AI-подсказки",
  CONFIRM: "AI после подтверждения",
  AUTO: "Полный автомат",
};

/** Safe default: analyze + prepare task, no proactive outbound */
export const DEFAULT_AI_AUTOMATION: AIAutomationSettings = {
  defaultMode: "CONFIRM",
  ...MODE_FLAGS.CONFIRM,
  allowProactiveOutbound: true,
  processRepeatRequests: true,
  firstContactSlaMinutes: 15,
  scheduleMode: "always",
  sourceModes: {
    manual: "MANUAL",
    website_form: "CONFIRM",
    form: "CONFIRM",
    website_ai: "CONFIRM",
    website: "CONFIRM",
    google_lead_form: "CONFIRM",
    api: "ASSIST",
    webhook: "CONFIRM",
  },
  serviceModes: {},
  integrationModes: {},
};

function isMode(value: unknown): value is AutomationMode {
  return value === "MANUAL" || value === "ASSIST" || value === "CONFIRM" || value === "AUTO";
}

function parseModeMap(raw: unknown): Record<string, AutomationMode> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, AutomationMode> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isMode(value)) out[key] = value;
  }
  return out;
}

export function modeFromFlags(flags: {
  analyzeNewRequests: boolean;
  autoCreateAiTask: boolean;
  autoStartAiManager: boolean;
}): AutomationMode {
  if (!flags.analyzeNewRequests) return "MANUAL";
  if (!flags.autoCreateAiTask) return "ASSIST";
  if (!flags.autoStartAiManager) return "CONFIRM";
  return "AUTO";
}

export function parseAIAutomationSettings(raw: unknown): AIAutomationSettings {
  const base: AIAutomationSettings = {
    ...DEFAULT_AI_AUTOMATION,
    sourceModes: { ...DEFAULT_AI_AUTOMATION.sourceModes },
    serviceModes: { ...DEFAULT_AI_AUTOMATION.serviceModes },
    integrationModes: { ...DEFAULT_AI_AUTOMATION.integrationModes },
  };
  if (!raw || typeof raw !== "object") return base;
  const block = (raw as { aiAutomation?: Record<string, unknown> }).aiAutomation;
  if (!block || typeof block !== "object") return base;

  if (isMode(block.defaultMode)) {
    base.defaultMode = block.defaultMode;
    Object.assign(base, MODE_FLAGS[block.defaultMode]);
  }
  if (typeof block.analyzeNewRequests === "boolean") base.analyzeNewRequests = block.analyzeNewRequests;
  if (typeof block.autoCreateAiTask === "boolean") base.autoCreateAiTask = block.autoCreateAiTask;
  if (typeof block.autoStartAiManager === "boolean") base.autoStartAiManager = block.autoStartAiManager;
  if (typeof block.allowProactiveOutbound === "boolean") {
    base.allowProactiveOutbound = block.allowProactiveOutbound;
  }
  if (typeof block.processRepeatRequests === "boolean") {
    base.processRepeatRequests = block.processRepeatRequests;
  }
  if ([5, 10, 15, 30, 60].includes(Number(block.firstContactSlaMinutes))) {
    base.firstContactSlaMinutes = Number(block.firstContactSlaMinutes) as FirstContactSlaMinutes;
  }
  if (block.scheduleMode === "always" || block.scheduleMode === "working_hours" || block.scheduleMode === "custom") {
    base.scheduleMode = block.scheduleMode;
  }
  base.sourceModes = { ...base.sourceModes, ...parseModeMap(block.sourceModes) };
  base.serviceModes = { ...base.serviceModes, ...parseModeMap(block.serviceModes) };
  base.integrationModes = { ...base.integrationModes, ...parseModeMap(block.integrationModes) };

  // Keep mode label consistent with flags if flags were overridden explicitly
  base.defaultMode = modeFromFlags(base);
  return base;
}

export function applyModeToSettings(
  settings: AIAutomationSettings,
  mode: AutomationMode,
): AIAutomationSettings {
  return {
    ...settings,
    defaultMode: mode,
    ...MODE_FLAGS[mode],
  };
}

export function mergeAIAutomationIntoSettingsJson(
  current: unknown,
  next: AIAutomationSettings,
): Record<string, unknown> {
  const base =
    current && typeof current === "object" ? { ...(current as Record<string, unknown>) } : {};
  base.aiAutomation = {
    defaultMode: next.defaultMode,
    analyzeNewRequests: next.analyzeNewRequests,
    autoCreateAiTask: next.autoCreateAiTask,
    autoStartAiManager: next.autoStartAiManager,
    allowProactiveOutbound: next.allowProactiveOutbound,
    processRepeatRequests: next.processRepeatRequests,
    firstContactSlaMinutes: next.firstContactSlaMinutes,
    scheduleMode: next.scheduleMode,
    sourceModes: next.sourceModes,
    serviceModes: next.serviceModes,
    integrationModes: next.integrationModes,
  };
  return base;
}
