import { z } from "zod";

export const CONTROL_SOURCES = ["WHATSAPP", "TELEGRAM", "CRM_CHAT", "MOBILE", "API"] as const;
export type ControlSource = (typeof CONTROL_SOURCES)[number];

export const CONTROL_RISK_LEVELS = ["READ", "LOW_WRITE", "MEDIUM_WRITE", "HIGH_RISK"] as const;
export type ControlRiskLevel = (typeof CONTROL_RISK_LEVELS)[number];

export const CONTROL_ACTIONS = [
  "GET_BUSINESS_SUMMARY",
  "GET_SITUATION",
  "GET_LEADS_STATS",
  "GET_DEALS_STATS",
  "GET_REVENUE_STATS",
  "GET_PIPELINE_SUMMARY",
  "GET_STUCK_DEALS",
  "GET_OVERDUE_TASKS",
  "GET_TASKS",
  "GET_TODAY_TASKS",
  "GET_CLIENTS",
  "FIND_CLIENT",
  "GET_CLIENT_DETAILS",
  "GET_DEAL",
  "FIND_DEAL",
  "GET_MANAGER_PERFORMANCE",
  "GET_TEAM_STATUS",
  "GET_RECENT_LEADS",
  "GET_RECENT_DEALS",
  "GET_CONVERSATION_SUMMARY",
  "GENERATE_REPORT",
  "CREATE_TASK",
  "UPDATE_TASK",
  "COMPLETE_TASK",
  "ASSIGN_TASK",
  "CREATE_LEAD",
  "UPDATE_LEAD",
  "CREATE_DEAL",
  "UPDATE_DEAL",
  "MOVE_DEAL_STAGE",
  "ASSIGN_DEAL",
  "ADD_DEAL_NOTE",
  "UPDATE_CLIENT",
  "CREATE_CLIENT",
  "ASSIGN_CLIENT",
  "CREATE_FOLLOW_UP",
  "BULK_ASSIGN_DEALS",
  "BULK_UPDATE_LEADS",
  "BULK_CREATE_TASKS",
  "BULK_SEND_MESSAGE",
  "BULK_MOVE_DEALS",
  "EXPORT_REPORT",
  "ARCHIVE_CLIENT",
  "DELETE_CLIENT",
] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export const CONTROL_ACTION_META: Record<
  ControlAction,
  {
    riskLevel: ControlRiskLevel;
    financial?: boolean;
    team?: boolean;
    bulk?: boolean;
    label: string;
  }
> = {
  GET_BUSINESS_SUMMARY: { riskLevel: "READ", financial: true, label: "Сводка по бизнесу" },
  GET_SITUATION: { riskLevel: "READ", label: "Ситуация" },
  GET_LEADS_STATS: { riskLevel: "READ", label: "Статистика заявок" },
  GET_DEALS_STATS: { riskLevel: "READ", financial: true, label: "Статистика сделок" },
  GET_REVENUE_STATS: { riskLevel: "READ", financial: true, label: "Выручка" },
  GET_PIPELINE_SUMMARY: { riskLevel: "READ", financial: true, label: "Воронка" },
  GET_STUCK_DEALS: { riskLevel: "READ", label: "Застрявшие сделки" },
  GET_OVERDUE_TASKS: { riskLevel: "READ", label: "Просроченные задачи" },
  GET_TASKS: { riskLevel: "READ", label: "Задачи" },
  GET_TODAY_TASKS: { riskLevel: "READ", label: "Задачи на сегодня" },
  GET_CLIENTS: { riskLevel: "READ", label: "Клиенты" },
  FIND_CLIENT: { riskLevel: "READ", label: "Поиск клиента" },
  GET_CLIENT_DETAILS: { riskLevel: "READ", label: "Карточка клиента" },
  GET_DEAL: { riskLevel: "READ", label: "Сделка" },
  FIND_DEAL: { riskLevel: "READ", label: "Поиск сделки" },
  GET_MANAGER_PERFORMANCE: { riskLevel: "READ", team: true, financial: true, label: "Эффективность менеджеров" },
  GET_TEAM_STATUS: { riskLevel: "READ", team: true, label: "Команда" },
  GET_RECENT_LEADS: { riskLevel: "READ", label: "Последние заявки" },
  GET_RECENT_DEALS: { riskLevel: "READ", label: "Последние сделки" },
  GET_CONVERSATION_SUMMARY: { riskLevel: "READ", label: "Сводка диалога" },
  GENERATE_REPORT: { riskLevel: "READ", financial: true, label: "Отчёт" },
  CREATE_TASK: { riskLevel: "LOW_WRITE", label: "Создать задачу" },
  UPDATE_TASK: { riskLevel: "LOW_WRITE", label: "Изменить задачу" },
  COMPLETE_TASK: { riskLevel: "LOW_WRITE", label: "Закрыть задачу" },
  ASSIGN_TASK: { riskLevel: "MEDIUM_WRITE", label: "Назначить задачу" },
  CREATE_LEAD: { riskLevel: "MEDIUM_WRITE", label: "Создать заявку" },
  UPDATE_LEAD: { riskLevel: "MEDIUM_WRITE", label: "Изменить заявку" },
  CREATE_DEAL: { riskLevel: "MEDIUM_WRITE", label: "Создать сделку" },
  UPDATE_DEAL: { riskLevel: "MEDIUM_WRITE", label: "Изменить сделку" },
  MOVE_DEAL_STAGE: { riskLevel: "MEDIUM_WRITE", label: "Сменить этап сделки" },
  ASSIGN_DEAL: { riskLevel: "MEDIUM_WRITE", label: "Назначить сделку" },
  ADD_DEAL_NOTE: { riskLevel: "LOW_WRITE", label: "Заметка по сделке" },
  UPDATE_CLIENT: { riskLevel: "MEDIUM_WRITE", label: "Изменить клиента" },
  CREATE_CLIENT: { riskLevel: "MEDIUM_WRITE", label: "Создать клиента" },
  ASSIGN_CLIENT: { riskLevel: "MEDIUM_WRITE", label: "Назначить клиента" },
  CREATE_FOLLOW_UP: { riskLevel: "LOW_WRITE", label: "Создать follow-up" },
  BULK_ASSIGN_DEALS: { riskLevel: "HIGH_RISK", bulk: true, label: "Массово назначить сделки" },
  BULK_UPDATE_LEADS: { riskLevel: "HIGH_RISK", bulk: true, label: "Массово изменить заявки" },
  BULK_CREATE_TASKS: { riskLevel: "HIGH_RISK", bulk: true, label: "Массово создать задачи" },
  BULK_SEND_MESSAGE: { riskLevel: "HIGH_RISK", bulk: true, label: "Массовая рассылка" },
  BULK_MOVE_DEALS: { riskLevel: "HIGH_RISK", bulk: true, label: "Массово сменить этап" },
  EXPORT_REPORT: { riskLevel: "HIGH_RISK", bulk: true, financial: true, label: "Экспорт отчёта" },
  ARCHIVE_CLIENT: { riskLevel: "HIGH_RISK", label: "Архивировать клиента" },
  DELETE_CLIENT: { riskLevel: "HIGH_RISK", label: "Удалить клиента" },
};

export const controlExecuteSchema = z.object({
  externalIdentity: z.string().trim().min(1).max(80),
  source: z.enum(CONTROL_SOURCES).default("WHATSAPP"),
  action: z.enum(CONTROL_ACTIONS),
  params: z.record(z.string(), z.unknown()).optional().default({}),
  requestId: z.string().trim().min(8).max(120),
  tenantId: z.string().trim().max(80).optional(),
});

export const controlConfirmSchema = z.object({
  confirmationId: z.string().uuid(),
  externalIdentity: z.string().trim().min(1).max(80),
  source: z.enum(CONTROL_SOURCES).default("WHATSAPP"),
  requestId: z.string().trim().min(8).max(120).optional(),
  tenantId: z.string().trim().max(80).optional(),
});

export const controlVerifySchema = z.object({
  externalIdentity: z.string().trim().min(1).max(80),
  code: z.string().trim().min(4).max(12),
  source: z.enum(CONTROL_SOURCES).default("WHATSAPP"),
  tenantId: z.string().trim().max(80).optional(),
});

export const controlAccessPatchSchema = z.object({
  enabled: z.boolean().optional(),
  allowedSources: z.array(z.enum(CONTROL_SOURCES)).max(8).optional(),
  allowedActions: z.array(z.enum(CONTROL_ACTIONS)).max(80).optional(),
  canReadFinancialData: z.boolean().optional(),
  canReadTeamData: z.boolean().optional(),
  canCreateTasks: z.boolean().optional(),
  canModifyDeals: z.boolean().optional(),
  canPerformBulkActions: z.boolean().optional(),
  requiresConfirmationForWrites: z.boolean().optional(),
});

export const controlCompanyPatchSchema = z.object({
  enabled: z.boolean(),
});

export const controlIdentityCreateSchema = z.object({
  userId: z.string().uuid(),
  provider: z.enum(CONTROL_SOURCES).default("WHATSAPP"),
  externalUserId: z.string().trim().min(3).max(80).optional(),
  phone: z.string().trim().min(5).max(40).optional(),
  verifyNow: z.boolean().optional(),
});
