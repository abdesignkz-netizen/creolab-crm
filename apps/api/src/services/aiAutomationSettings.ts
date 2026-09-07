/** AI Manager automation for new requests — Tenant.settingsJson.aiAutomation */

export type AutomationMode = "MANUAL" | "ASSIST" | "CONFIRM" | "AUTO";

export type FirstContactSlaMinutes = 5 | 10 | 15 | 30 | 60;

export type ScheduleMode = "always" | "working_hours" | "custom";

/** JS weekday: 0=Sun … 6=Sat */
export type ScheduleWindow = {
  days: number[];
  start: string; // HH:MM
  end: string; // HH:MM
};

export type AIAutomationSettings = {
  defaultMode: AutomationMode;
  analyzeNewRequests: boolean;
  autoCreateAiTask: boolean;
  autoStartAiManager: boolean;
  allowProactiveOutbound: boolean;
  processRepeatRequests: boolean;
  firstContactSlaMinutes: FirstContactSlaMinutes;
  scheduleMode: ScheduleMode;
  workingHours: ScheduleWindow;
  customSchedule: ScheduleWindow;
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

export const DEFAULT_WORKING_HOURS: ScheduleWindow = {
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
};

export const DEFAULT_CUSTOM_SCHEDULE: ScheduleWindow = {
  days: [1, 2, 3, 4, 5, 6],
  start: "10:00",
  end: "20:00",
};

/** Safe default: analyze + prepare task, no proactive outbound */
export const DEFAULT_AI_AUTOMATION: AIAutomationSettings = {
  defaultMode: "CONFIRM",
  ...MODE_FLAGS.CONFIRM,
  allowProactiveOutbound: true,
  processRepeatRequests: true,
  firstContactSlaMinutes: 15,
  scheduleMode: "always",
  workingHours: { ...DEFAULT_WORKING_HOURS, days: [...DEFAULT_WORKING_HOURS.days] },
  customSchedule: { ...DEFAULT_CUSTOM_SCHEDULE, days: [...DEFAULT_CUSTOM_SCHEDULE.days] },
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

function parseTimeHm(value: unknown, fallback: string) {
  const raw = String(value || "").trim();
  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    const [h, m] = raw.split(":").map(Number);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }
  return fallback;
}

export function parseScheduleWindow(raw: unknown, fallback: ScheduleWindow): ScheduleWindow {
  if (!raw || typeof raw !== "object") {
    return { days: [...fallback.days], start: fallback.start, end: fallback.end };
  }
  const obj = raw as Record<string, unknown>;
  const daysRaw = Array.isArray(obj.days) ? obj.days : fallback.days;
  const days = [...new Set(daysRaw.map((d) => Number(d)).filter((d) => d >= 0 && d <= 6))].sort(
    (a, b) => a - b,
  );
  return {
    days: days.length ? days : [...fallback.days],
    start: parseTimeHm(obj.start, fallback.start),
    end: parseTimeHm(obj.end, fallback.end),
  };
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
    workingHours: { ...DEFAULT_WORKING_HOURS, days: [...DEFAULT_WORKING_HOURS.days] },
    customSchedule: { ...DEFAULT_CUSTOM_SCHEDULE, days: [...DEFAULT_CUSTOM_SCHEDULE.days] },
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
  base.workingHours = parseScheduleWindow(block.workingHours, DEFAULT_WORKING_HOURS);
  base.customSchedule = parseScheduleWindow(block.customSchedule, DEFAULT_CUSTOM_SCHEDULE);
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
    workingHours: next.workingHours,
    customSchedule: next.customSchedule,
    sourceModes: next.sourceModes,
    serviceModes: next.serviceModes,
    integrationModes: next.integrationModes,
  };
  return base;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function localPartsInTimezone(now: Date, timeZone: string): { weekday: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "Asia/Almaty",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(now);
  const weekdayName = parts.find((p) => p.type === "weekday")?.value || "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value || "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value || "0");
  const weekday = WEEKDAY_SHORT.indexOf(weekdayName as (typeof WEEKDAY_SHORT)[number]);
  return {
    weekday: weekday >= 0 ? weekday : 1,
    minutes: hour * 60 + minute,
  };
}

function hmToMinutes(hm: string) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

export function isWithinScheduleWindow(now: Date, timeZone: string, window: ScheduleWindow): boolean {
  const { weekday, minutes } = localPartsInTimezone(now, timeZone);
  if (!window.days.includes(weekday)) return false;
  const start = hmToMinutes(window.start);
  const end = hmToMinutes(window.end);
  if (end <= start) {
    // overnight window e.g. 22:00–06:00
    return minutes >= start || minutes < end;
  }
  return minutes >= start && minutes < end;
}

export function isWithinAiSchedule(
  now: Date,
  timeZone: string,
  settings: Pick<AIAutomationSettings, "scheduleMode" | "workingHours" | "customSchedule">,
): boolean {
  if (settings.scheduleMode === "always") return true;
  const window =
    settings.scheduleMode === "custom" ? settings.customSchedule : settings.workingHours;
  return isWithinScheduleWindow(now, timeZone, window);
}
