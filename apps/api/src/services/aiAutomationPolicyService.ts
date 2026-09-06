import {
  type AIAutomationSettings,
  type AutomationMode,
  MODE_FLAGS,
  parseAIAutomationSettings,
} from "./aiAutomationSettings.ts";

export type AutomationDecision = {
  mode: AutomationMode;
  analyze: boolean;
  createTask: boolean;
  autoStart: boolean;
  allowOutbound: boolean;
  reason: string;
  sourceRule?: string | null;
  serviceRule?: string | null;
  integrationRule?: string | null;
  clientOverride?: string | null;
  hardBlocked?: boolean;
};

export type PolicyInput = {
  settingsJson: unknown;
  sourceChannel?: string | null;
  sourceType?: string | null;
  source?: string | null;
  serviceCategory?: string | null;
  integrationId?: string | null;
  /** Integration.automationMode column */
  integrationAutomationMode?: string | null;
  /** Contact.attributionJson.aiAutomation or explicit OFF/HUMAN */
  clientAiMode?: string | null;
  /** Request-level override in fieldMeta */
  requestOverrideMode?: string | null;
  doNotContact?: boolean;
  isRepeatRequest?: boolean;
};

function resolveMode(
  settings: AIAutomationSettings,
  input: PolicyInput,
): { mode: AutomationMode; reason: string; meta: Partial<AutomationDecision> } {
  if (input.doNotContact) {
    return {
      mode: "MANUAL",
      reason: "Клиент в doNotContact — автоматический контакт запрещён",
      meta: { hardBlocked: true, clientOverride: "doNotContact" },
    };
  }

  const req = String(input.requestOverrideMode || "").toUpperCase();
  if (req === "MANUAL" || req === "ASSIST" || req === "CONFIRM" || req === "AUTO" || req === "OFF") {
    const mode = req === "OFF" ? "MANUAL" : (req as AutomationMode);
    return {
      mode,
      reason: `Переопределение заявки: ${mode}`,
      meta: { clientOverride: null },
    };
  }

  const client = String(input.clientAiMode || "").toUpperCase();
  if (client === "OFF" || client === "HUMAN" || client === "MANUAL") {
    return {
      mode: "MANUAL",
      reason: "Исключение для клиента: AI automation OFF",
      meta: { clientOverride: client },
    };
  }
  if (client === "ASSIST" || client === "CONFIRM" || client === "AUTO") {
    return {
      mode: client,
      reason: `Исключение для клиента: ${client}`,
      meta: { clientOverride: client },
    };
  }

  if (input.isRepeatRequest && !settings.processRepeatRequests) {
    return {
      mode: "CONFIRM",
      reason: "Повторная заявка — автообработка выключена, нужен CONFIRM",
      meta: {},
    };
  }

  if (input.integrationId && settings.integrationModes[input.integrationId]) {
    const mode = settings.integrationModes[input.integrationId];
    return {
      mode,
      reason: `Правило интеграции: ${mode}`,
      meta: { integrationRule: input.integrationId },
    };
  }

  // Integration.automationMode field (explicit on connector) beats source/service
  if (input.integrationAutomationMode) {
    const raw = String(input.integrationAutomationMode).toUpperCase();
    if (raw === "MANUAL" || raw === "ASSIST" || raw === "CONFIRM" || raw === "AUTO") {
      return {
        mode: raw,
        reason: `Режим интеграции: ${raw}`,
        meta: { integrationRule: input.integrationId || "integration.automationMode" },
      };
    }
  }

  if (input.serviceCategory && settings.serviceModes[input.serviceCategory]) {
    const mode = settings.serviceModes[input.serviceCategory];
    return {
      mode,
      reason: `Правило услуги «${input.serviceCategory}»: ${mode}`,
      meta: { serviceRule: input.serviceCategory },
    };
  }

  const sourceKeys = [input.sourceChannel, input.sourceType, input.source]
    .map((v) => String(v || "").toLowerCase())
    .filter(Boolean);
  for (const key of sourceKeys) {
    if (settings.sourceModes[key]) {
      const mode = settings.sourceModes[key];
      return {
        mode,
        reason: `Правило источника «${key}»: ${mode}`,
        meta: { sourceRule: key },
      };
    }
  }

  return {
    mode: settings.defaultMode,
    reason: `Глобальный режим: ${settings.defaultMode}`,
    meta: {},
  };
}

export function decideAutomationPolicy(input: PolicyInput): AutomationDecision {
  const settings = parseAIAutomationSettings(input.settingsJson);
  const { mode, reason, meta } = resolveMode(settings, input);
  const flags = MODE_FLAGS[mode];
  const allowOutbound =
    Boolean(settings.allowProactiveOutbound) && flags.autoStartAiManager && !meta.hardBlocked;

  return {
    mode,
    analyze: flags.analyzeNewRequests,
    createTask: flags.autoCreateAiTask,
    autoStart: flags.autoStartAiManager && allowOutbound,
    allowOutbound,
    reason,
    sourceRule: meta.sourceRule ?? null,
    serviceRule: meta.serviceRule ?? null,
    integrationRule: meta.integrationRule ?? null,
    clientOverride: meta.clientOverride ?? null,
    hardBlocked: Boolean(meta.hardBlocked),
  };
}

export type { AIAutomationSettings, AutomationMode };
