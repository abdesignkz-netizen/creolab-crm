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

export type OffHoursBehavior = "continue" | "accept_no_process" | "no_reply";
export type ConversationHoursMode = "always" | "schedule";
export type HandoffAfterMode = "human" | "assist";

export const HANDOFF_TRIGGER_KEYS = [
  "CLIENT_REQUESTED_HUMAN",
  "COMPLAINT",
  "LOW_CONFIDENCE",
  "CUSTOM_PRICING",
  "CONTRACT",
  "PAYMENT",
  "OTHER",
] as const;
export type HandoffTriggerKey = (typeof HANDOFF_TRIGGER_KEYS)[number];

export type DayHours = {
  enabled: boolean;
  start: string;
  end: string;
};

export type ConversationHoursSettings = {
  mode: ConversationHoursMode;
  days: Record<number, DayHours>;
  offHoursBehavior: OffHoursBehavior;
};

export type HandoffSettings = {
  triggers: Record<HandoffTriggerKey, boolean>;
  afterMode: HandoffAfterMode;
};

export type FollowUpSettings = {
  enabled: boolean;
  delaysMinutes: number[];
  maxAttempts: number;
  skipIfRefused: boolean;
  skipIfHandedToHuman: boolean;
  skipIfDealClosed: boolean;
  skipIfClientReplied: boolean;
  respectWorkingHours: boolean;
};

export type AIAutomationSettings = {
  /** Conversation intelligence permissions, independent of permission to send replies. */
  crm: CrmAutomationSettings;
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
  /** Defaults keep current behaviour: no auto-handoff, follow-up off, 24/7. */
  handoff: HandoffSettings;
  followUp: FollowUpSettings;
  conversationHours: ConversationHoursSettings;
};

export type CrmAutomationSettings = {
  enabled: boolean;
  inHumanMode: boolean;
  updateContact: boolean;
  updateInquiry: boolean;
  updateDealAmount: boolean;
  updateDealStage: boolean;
  updateNextAction: boolean;
  detectAgreements: boolean;
  createTasks: boolean;
};

export const DEFAULT_CRM_AUTOMATION: CrmAutomationSettings = {
  enabled: false,
  inHumanMode: true,
  updateContact: true,
  updateInquiry: true,
  updateDealAmount: true,
  updateDealStage: false,
  updateNextAction: true,
  detectAgreements: true,
  createTasks: true,
};

export function parseCrmAutomation(raw: unknown): CrmAutomationSettings {
  const result = { ...DEFAULT_CRM_AUTOMATION };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(result) as Array<keyof CrmAutomationSettings>) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "boolean") result[key] = value;
    }
  }
  return result;
}

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
  MANUAL: "Вручную",
  ASSIST: "Только подсказка",
  CONFIRM: "После подтверждения",
  AUTO: "Сам пишет клиенту",
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

export const DEFAULT_DAY_HOURS: Record<number, DayHours> = {
  1: { enabled: true, start: "09:00", end: "20:00" },
  2: { enabled: true, start: "09:00", end: "20:00" },
  3: { enabled: true, start: "09:00", end: "20:00" },
  4: { enabled: true, start: "09:00", end: "20:00" },
  5: { enabled: true, start: "09:00", end: "20:00" },
  6: { enabled: true, start: "10:00", end: "18:00" },
  0: { enabled: false, start: "10:00", end: "18:00" },
};

export const DEFAULT_HANDOFF: HandoffSettings = {
  triggers: {
    CLIENT_REQUESTED_HUMAN: false,
    COMPLAINT: false,
    LOW_CONFIDENCE: false,
    CUSTOM_PRICING: false,
    CONTRACT: false,
    PAYMENT: false,
    OTHER: false,
  },
  afterMode: "human",
};

export const DEFAULT_FOLLOW_UP: FollowUpSettings = {
  enabled: false,
  delaysMinutes: [120, 1440, 4320],
  maxAttempts: 3,
  skipIfRefused: true,
  skipIfHandedToHuman: true,
  skipIfDealClosed: true,
  skipIfClientReplied: true,
  respectWorkingHours: true,
};

export const DEFAULT_CONVERSATION_HOURS: ConversationHoursSettings = {
  mode: "always",
  days: { ...DEFAULT_DAY_HOURS },
  offHoursBehavior: "accept_no_process",
};

export function cloneDayHours(source: Record<number, DayHours> = DEFAULT_DAY_HOURS): Record<number, DayHours> {
  const out: Record<number, DayHours> = {};
  for (const key of [0, 1, 2, 3, 4, 5, 6]) {
    const row = source[key] || DEFAULT_DAY_HOURS[key];
    out[key] = { enabled: Boolean(row.enabled), start: row.start, end: row.end };
  }
  return out;
}

/** Safe default: analyze + prepare task, no proactive outbound */
export const DEFAULT_AI_AUTOMATION: AIAutomationSettings = {
  crm: { ...DEFAULT_CRM_AUTOMATION },
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
  handoff: {
    triggers: { ...DEFAULT_HANDOFF.triggers },
    afterMode: DEFAULT_HANDOFF.afterMode,
  },
  followUp: { ...DEFAULT_FOLLOW_UP, delaysMinutes: [...DEFAULT_FOLLOW_UP.delaysMinutes] },
  conversationHours: { ...DEFAULT_CONVERSATION_HOURS, days: cloneDayHours() },
};

/** Inbound form sources that follow the global mode when the operator chooses AUTO. */
export const FORM_SOURCES_FOLLOWING_AUTO = [
  "website_form",
  "form",
  "website",
  "website_ai",
  "google_lead_form",
  "webhook",
] as const;

function followAutoForFormSources(sourceModes: Record<string, AutomationMode>, mode: AutomationMode) {
  if (mode !== "AUTO") return sourceModes;
  const next = { ...sourceModes };
  for (const key of FORM_SOURCES_FOLLOWING_AUTO) {
    if (next[key] === "CONFIRM") delete next[key];
  }
  return next;
}

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

function parseHandoffSettings(raw: unknown): HandoffSettings {
  const out: HandoffSettings = {
    triggers: { ...DEFAULT_HANDOFF.triggers },
    afterMode: DEFAULT_HANDOFF.afterMode,
  };
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  if (obj.afterMode === "human" || obj.afterMode === "assist") out.afterMode = obj.afterMode;
  const triggers = obj.triggers && typeof obj.triggers === "object" ? (obj.triggers as Record<string, unknown>) : obj;
  for (const key of HANDOFF_TRIGGER_KEYS) {
    if (typeof triggers[key] === "boolean") out.triggers[key] = triggers[key];
  }
  return out;
}

function parseDelayMinutes(raw: unknown): number[] {
  const source = Array.isArray(raw) ? raw : DEFAULT_FOLLOW_UP.delaysMinutes;
  const parsed = source
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item >= 15 && item <= 60 * 24 * 30)
    .slice(0, 5);
  return parsed.length ? parsed : [...DEFAULT_FOLLOW_UP.delaysMinutes];
}

function parseFollowUpSettings(raw: unknown): FollowUpSettings {
  const out: FollowUpSettings = { ...DEFAULT_FOLLOW_UP, delaysMinutes: [...DEFAULT_FOLLOW_UP.delaysMinutes] };
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.enabled === "boolean") out.enabled = obj.enabled;
  if (obj.delaysMinutes) out.delaysMinutes = parseDelayMinutes(obj.delaysMinutes);
  const max = Number(obj.maxAttempts);
  if (Number.isFinite(max) && max >= 1 && max <= 5) out.maxAttempts = Math.floor(max);
  for (const key of ["skipIfRefused", "skipIfHandedToHuman", "skipIfDealClosed", "skipIfClientReplied", "respectWorkingHours"] as const) {
    if (typeof obj[key] === "boolean") out[key] = obj[key];
  }
  if (out.delaysMinutes.length < out.maxAttempts) {
    const last = out.delaysMinutes[out.delaysMinutes.length - 1] || 1440;
    while (out.delaysMinutes.length < out.maxAttempts) out.delaysMinutes.push(last);
  }
  return out;
}

function parseConversationHours(raw: unknown): ConversationHoursSettings {
  const out: ConversationHoursSettings = {
    mode: "always",
    days: cloneDayHours(),
    offHoursBehavior: "accept_no_process",
  };
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  if (obj.mode === "always" || obj.mode === "schedule") out.mode = obj.mode;
  if (obj.offHoursBehavior === "continue" || obj.offHoursBehavior === "accept_no_process" || obj.offHoursBehavior === "no_reply") {
    out.offHoursBehavior = obj.offHoursBehavior;
  }
  const daysRaw = obj.days && typeof obj.days === "object" ? (obj.days as Record<string, unknown>) : {};
  for (const key of [0, 1, 2, 3, 4, 5, 6]) {
    const row = daysRaw[String(key)] ?? daysRaw[key];
    if (!row || typeof row !== "object") continue;
    const day = row as Record<string, unknown>;
    out.days[key] = {
      enabled: typeof day.enabled === "boolean" ? day.enabled : DEFAULT_DAY_HOURS[key].enabled,
      start: parseTimeHm(day.start, DEFAULT_DAY_HOURS[key].start),
      end: parseTimeHm(day.end, DEFAULT_DAY_HOURS[key].end),
    };
  }
  return out;
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
    crm: { ...DEFAULT_CRM_AUTOMATION },
    workingHours: { ...DEFAULT_WORKING_HOURS, days: [...DEFAULT_WORKING_HOURS.days] },
    customSchedule: { ...DEFAULT_CUSTOM_SCHEDULE, days: [...DEFAULT_CUSTOM_SCHEDULE.days] },
    sourceModes: { ...DEFAULT_AI_AUTOMATION.sourceModes },
    serviceModes: { ...DEFAULT_AI_AUTOMATION.serviceModes },
    integrationModes: { ...DEFAULT_AI_AUTOMATION.integrationModes },
    handoff: {
      triggers: { ...DEFAULT_HANDOFF.triggers },
      afterMode: DEFAULT_HANDOFF.afterMode,
    },
    followUp: { ...DEFAULT_FOLLOW_UP, delaysMinutes: [...DEFAULT_FOLLOW_UP.delaysMinutes] },
    conversationHours: { ...DEFAULT_CONVERSATION_HOURS, days: cloneDayHours() },
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
  base.handoff = parseHandoffSettings(block.handoff);
  base.crm = parseCrmAutomation(block.crm);
  base.followUp = parseFollowUpSettings(block.followUp);
  base.conversationHours = parseConversationHours(block.conversationHours);

  // Keep mode label consistent with flags if flags were overridden explicitly
  base.defaultMode = modeFromFlags(base);
  base.sourceModes = followAutoForFormSources(base.sourceModes, base.defaultMode);
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
    sourceModes: followAutoForFormSources(settings.sourceModes, mode),
  };
}

export function mergeAIAutomationIntoSettingsJson(
  current: unknown,
  next: AIAutomationSettings,
): Record<string, unknown> {
  const base =
    current && typeof current === "object" ? { ...(current as Record<string, unknown>) } : {};
  base.aiAutomation = {
    crm: next.crm,
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
    handoff: next.handoff,
    followUp: next.followUp,
    conversationHours: next.conversationHours,
  };
  return base;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function normalizeCompanyTimezone(value: unknown, fallback = "Asia/Almaty") {
  const tz = String(value || "").trim().slice(0, 80);
  if (!tz) return fallback;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return fallback;
  }
}

function localPartsInTimezone(now: Date, timeZone: string): { weekday: number; minutes: number } {
  const zone = normalizeCompanyTimezone(timeZone);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
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
  settings: Pick<
    AIAutomationSettings,
    "scheduleMode" | "workingHours" | "customSchedule" | "conversationHours"
  >,
): boolean {
  if (settings.conversationHours?.mode === "schedule") {
    if (settings.conversationHours.offHoursBehavior === "continue") return true;
    return isWithinConversationHours(now, timeZone, settings.conversationHours);
  }
  if (settings.scheduleMode === "always") return true;
  const window =
    settings.scheduleMode === "custom" ? settings.customSchedule : settings.workingHours;
  return isWithinScheduleWindow(now, timeZone, window);
}

export function isWithinConversationHours(
  now: Date,
  timeZone: string,
  hours: ConversationHoursSettings,
): boolean {
  if (hours.mode !== "schedule") return true;
  const { weekday, minutes } = localPartsInTimezone(now, timeZone);
  const day = hours.days[weekday] || DEFAULT_DAY_HOURS[weekday];
  if (!day?.enabled) return false;
  const start = hmToMinutes(day.start);
  const end = hmToMinutes(day.end);
  if (end <= start) return minutes >= start || minutes < end;
  return minutes >= start && minutes < end;
}

export function nextWorkingInstant(now: Date, timeZone: string, hours: ConversationHoursSettings): Date {
  if (hours.mode !== "schedule" || hours.offHoursBehavior === "continue") return now;
  if (isWithinConversationHours(now, timeZone, hours)) return now;
  for (let offset = 0; offset < 8; offset += 1) {
    const probe = new Date(now.getTime() + offset * 86400000);
    const { weekday } = localPartsInTimezone(probe, timeZone);
    const day = hours.days[weekday] || DEFAULT_DAY_HOURS[weekday];
    if (!day?.enabled) continue;
    const start = hmToMinutes(day.start);
    const atStart = dateAtTimezoneMinutes(probe, timeZone, start);
    if (atStart.getTime() > now.getTime()) return atStart;
  }
  return new Date(now.getTime() + 60 * 60 * 1000);
}

function dateAtTimezoneMinutes(day: Date, timeZone: string, minutes: number) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const utcGuess = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute, 0, 0));
  const { minutes: localMinutes } = localPartsInTimezone(utcGuess, timeZone);
  const delta = localMinutes - minutes;
  return new Date(utcGuess.getTime() - delta * 60_000);
}

export function offHoursBlocksOutbound(settings: Pick<AIAutomationSettings, "conversationHours">): boolean {
  return settings.conversationHours?.mode === "schedule" && settings.conversationHours.offHoursBehavior !== "continue";
}

export function offHoursBlocksAnalysis(settings: Pick<AIAutomationSettings, "conversationHours">): boolean {
  return settings.conversationHours?.mode === "schedule" && settings.conversationHours.offHoursBehavior === "no_reply";
}
