import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import {
  applyModeToSettings,
  mergeAIAutomationIntoSettingsJson,
  MODE_LABEL,
  parseAIAutomationSettings,
  parseScheduleWindow,
  DEFAULT_CUSTOM_SCHEDULE,
  DEFAULT_WORKING_HOURS,
  type AutomationMode,
  type AIAutomationSettings,
  type ScheduleWindow,
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
  // Prefer persisted tenant.workingHoursJson when present
  const fromTenant = parseScheduleWindow(tenant?.workingHoursJson, settings.workingHours);
  if (tenant?.workingHoursJson && typeof tenant.workingHoursJson === "object") {
    const keys = Object.keys(tenant.workingHoursJson as object);
    if (keys.length) settings.workingHours = fromTenant;
  }
  return {
    ...settings,
    timezone: tenant?.timezone || "Asia/Almaty",
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
  if (input.workingHours) {
    next.workingHours = parseScheduleWindow(input.workingHours, DEFAULT_WORKING_HOURS);
  }
  if (input.customSchedule) {
    next.customSchedule = parseScheduleWindow(input.customSchedule, DEFAULT_CUSTOM_SCHEDULE);
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
  const workingHoursJson = next.workingHours as unknown as Prisma.InputJsonValue;
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { settingsJson: settingsJson as Prisma.InputJsonObject, workingHoursJson },
  });

  return {
    ...next,
    timezone: tenant.timezone || "Asia/Almaty",
    modeLabel: MODE_LABEL[next.defaultMode],
    message: `Режим обработки новых заявок изменён на «${MODE_LABEL[next.defaultMode]}». Новые заявки будут обрабатываться по новым правилам. Уже запущенные AI-задачи не меняются.`,
  };
}

export type { ScheduleWindow };
