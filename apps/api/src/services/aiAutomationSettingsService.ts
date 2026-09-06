import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import {
  applyModeToSettings,
  mergeAIAutomationIntoSettingsJson,
  MODE_LABEL,
  parseAIAutomationSettings,
  type AutomationMode,
  type AIAutomationSettings,
} from "./aiAutomationSettings.ts";

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) {
    throw new ApiError(403, "no_tenant", "Нет активной компании");
  }
  return auth.activeMembership;
}

export async function getAIAutomationSettings(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const tenant = await prisma.tenant.findUnique({ where: { id: membership.tenantId } });
  const settings = parseAIAutomationSettings(tenant?.settingsJson);
  return {
    ...settings,
    modeLabel: MODE_LABEL[settings.defaultMode],
    modes: (Object.keys(MODE_LABEL) as AutomationMode[]).map((mode) => ({
      mode,
      label: MODE_LABEL[mode],
    })),
  };
}

export async function updateAIAutomationSettings(
  prisma: PrismaClient,
  auth: AuthContext,
  input: Partial<AIAutomationSettings> & { defaultMode?: AutomationMode },
) {
  const membership = requireTenant(auth);
  const tenant = await prisma.tenant.findUnique({ where: { id: membership.tenantId } });
  if (!tenant) throw new ApiError(404, "not_found", "Компания не найдена");

  let next = parseAIAutomationSettings(tenant.settingsJson);
  if (input.defaultMode) {
    next = applyModeToSettings(next, input.defaultMode);
  }
  if (typeof input.analyzeNewRequests === "boolean") next.analyzeNewRequests = input.analyzeNewRequests;
  if (typeof input.autoCreateAiTask === "boolean") next.autoCreateAiTask = input.autoCreateAiTask;
  if (typeof input.autoStartAiManager === "boolean") next.autoStartAiManager = input.autoStartAiManager;
  if (typeof input.allowProactiveOutbound === "boolean") {
    next.allowProactiveOutbound = input.allowProactiveOutbound;
  }
  if (typeof input.processRepeatRequests === "boolean") {
    next.processRepeatRequests = input.processRepeatRequests;
  }
  if (input.firstContactSlaMinutes && [5, 10, 15, 30, 60].includes(Number(input.firstContactSlaMinutes))) {
    next.firstContactSlaMinutes = Number(input.firstContactSlaMinutes) as AIAutomationSettings["firstContactSlaMinutes"];
  }
  if (input.scheduleMode === "always" || input.scheduleMode === "working_hours" || input.scheduleMode === "custom") {
    next.scheduleMode = input.scheduleMode;
  }
  if (input.sourceModes && typeof input.sourceModes === "object") {
    next.sourceModes = { ...next.sourceModes, ...input.sourceModes };
  }
  if (input.serviceModes && typeof input.serviceModes === "object") {
    next.serviceModes = { ...next.serviceModes, ...input.serviceModes };
  }
  if (input.integrationModes && typeof input.integrationModes === "object") {
    next.integrationModes = { ...next.integrationModes, ...input.integrationModes };
  }

  const settingsJson = mergeAIAutomationIntoSettingsJson(tenant.settingsJson, next);
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { settingsJson },
  });

  return {
    ...next,
    modeLabel: MODE_LABEL[next.defaultMode],
    message: `Режим обработки новых заявок изменён на «${MODE_LABEL[next.defaultMode]}». Новые заявки будут обрабатываться по новым правилам. Уже запущенные AI-задачи не меняются.`,
  };
}
