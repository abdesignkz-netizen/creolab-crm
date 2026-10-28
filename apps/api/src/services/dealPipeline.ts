/** Default operational settings stored in Tenant.settingsJson.ops */
import { DEFAULT_PROCESS_CALENDAR, processCalendarSchema, type ProcessCalendar } from "@creolab/contracts";
import type { MonthlySalesPlan } from "./analyticsPeriodPolicy.ts";

export type TenantOpsSettings = {
  stalledDealDays: number;
  proposalFollowUpThresholdDays: number;
  silenceReturnDays: number;
  largeDealAmountMinor: number;
  stageSlaDays: Record<string, number | null>;
  processCalendar: ProcessCalendar;
  lostReasons: string[];
  salesPlanMinor: number | null;
  salesPlans: MonthlySalesPlan[];
};

export type SlaStatus = "OK" | "WARNING" | "OVERDUE";

export const DEFAULT_OPS_SETTINGS: TenantOpsSettings = {
  stalledDealDays: 5,
  proposalFollowUpThresholdDays: 3,
  silenceReturnDays: 7,
  largeDealAmountMinor: 500_000,
  stageSlaDays: {
    proposal_sent: 3,
    negotiation: 7,
    contract: 5,
    invoiced: 3,
  },
  lostReasons: [],
  salesPlanMinor: null,
  salesPlans: [],
  processCalendar: DEFAULT_PROCESS_CALENDAR,
};

export const PIPELINE_STAGES: Array<{
  systemKey: string;
  name: string;
  sortOrder: number;
  defaultProbability: number;
}> = [
  { systemKey: "new", name: "Новая", sortOrder: 1, defaultProbability: 10 },
  { systemKey: "in_progress", name: "В работе", sortOrder: 2, defaultProbability: 20 },
  { systemKey: "need_identified", name: "Потребность выявлена", sortOrder: 3, defaultProbability: 35 },
  { systemKey: "proposal_sent", name: "КП отправлено", sortOrder: 4, defaultProbability: 50 },
  { systemKey: "negotiation", name: "Переговоры", sortOrder: 5, defaultProbability: 70 },
  { systemKey: "contract", name: "Договор", sortOrder: 6, defaultProbability: 85 },
  { systemKey: "invoiced", name: "Счёт выставлен", sortOrder: 7, defaultProbability: 90 },
];

/** Map legacy seeded keys → current pipeline keys */
export const LEGACY_STAGE_MAP: Record<string, string> = {
  qualification: "need_identified",
};

export const PAYMENT_STATUSES = [
  "NOT_REQUIRED",
  "NOT_INVOICED",
  "INVOICED",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
] as const;

export const LOST_REASONS = [
  "Дорого",
  "Не отвечает",
  "Выбрал конкурента",
  "Нет бюджета",
  "Отложил",
  "Передумал",
  "Не подошла услуга",
  "Другое",
] as const;

export function parseOpsSettings(raw: unknown): TenantOpsSettings {
  const base: TenantOpsSettings = {
    ...DEFAULT_OPS_SETTINGS,
    stageSlaDays: { ...DEFAULT_OPS_SETTINGS.stageSlaDays },
    lostReasons: [],
    salesPlans: [],
    processCalendar: { ...DEFAULT_PROCESS_CALENDAR, days: [...DEFAULT_PROCESS_CALENDAR.days], excludedDates: [] },
  };
  if (!raw || typeof raw !== "object") return base;
  const ops = (raw as { ops?: Record<string, unknown> }).ops;
  if (!ops || typeof ops !== "object") return base;
  const bounded = (value: unknown, fallback: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.min(max, value) : fallback;
  base.stalledDealDays = bounded(ops.stalledDealDays, base.stalledDealDays, 90);
  base.proposalFollowUpThresholdDays = bounded(ops.proposalFollowUpThresholdDays, base.proposalFollowUpThresholdDays, 90);
  base.silenceReturnDays = bounded(ops.silenceReturnDays, base.silenceReturnDays, 180);
  base.largeDealAmountMinor = bounded(ops.largeDealAmountMinor, base.largeDealAmountMinor, Number.MAX_SAFE_INTEGER);
  if (typeof ops.salesPlanMinor === "number" && Number.isFinite(ops.salesPlanMinor)) {
    base.salesPlanMinor = Math.max(0, Math.round(ops.salesPlanMinor));
  }
  if (ops.salesPlanMinor === null) base.salesPlanMinor = null;
  if (Array.isArray(ops.salesPlans)) {
    const seen = new Set<string>();
    base.salesPlans = ops.salesPlans.filter((row): row is MonthlySalesPlan => {
      if (!row || typeof row !== "object" || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(row.month) || !/^[A-Z]{3}$/.test(row.currency)
        || !Number.isSafeInteger(row.amount) || row.amount < 0) return false;
      const key = `${row.month}:${row.currency}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 120);
  }
  if (ops.stageSlaDays && typeof ops.stageSlaDays === "object") {
    for (const [key, value] of Object.entries(ops.stageSlaDays)) {
      if (value === null) base.stageSlaDays[key] = null;
      else if (typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 90) base.stageSlaDays[key] = value;
    }
  }
  const calendar = processCalendarSchema.safeParse(ops.processCalendar);
  if (calendar.success) base.processCalendar = calendar.data;
  if (Array.isArray(ops.lostReasons)) {
    base.lostReasons = ops.lostReasons.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 40);
  }
  return base;
}

export function lostReasonCatalog(ops: TenantOpsSettings) {
  return ops.lostReasons.length ? ops.lostReasons : [...LOST_REASONS];
}

export function slaStatusForDays(daysOnStage: number, slaDays: number | null | undefined): SlaStatus {
  if (typeof slaDays !== "number" || slaDays <= 0) return "OK";
  if (daysOnStage > slaDays) return "OVERDUE";
  if (daysOnStage > slaDays * 0.7) return "WARNING";
  return "OK";
}

export function stageDurationLabel(enteredAt: Date, now = new Date()) {
  const ms = Math.max(0, now.getTime() - enteredAt.getTime());
  const hours = Math.floor(ms / 3600000);
  if (hours < 24) return `${Math.max(1, hours)} ч`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days} дн. ${remH} ч` : `${days} дн.`;
}

export function amountNumber(value: { toString(): string } | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

export function formatMoney(amount: number | null, currency = "KZT") {
  if (amount == null) return null;
  return `${Math.round(amount).toLocaleString("ru-RU")} ${currency === "KZT" ? "₸" : currency}`;
}
