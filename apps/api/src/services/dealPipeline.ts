/** Default operational settings stored in Tenant.settingsJson.ops */

export type TenantOpsSettings = {
  stalledDealDays: number;
  proposalFollowUpThresholdDays: number;
  silenceReturnDays: number;
  largeDealAmountMinor: number;
  stageSlaDays: Record<string, number>;
};

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
  const base = { ...DEFAULT_OPS_SETTINGS, stageSlaDays: { ...DEFAULT_OPS_SETTINGS.stageSlaDays } };
  if (!raw || typeof raw !== "object") return base;
  const ops = (raw as { ops?: Record<string, unknown> }).ops;
  if (!ops || typeof ops !== "object") return base;
  if (typeof ops.stalledDealDays === "number") base.stalledDealDays = ops.stalledDealDays;
  if (typeof ops.proposalFollowUpThresholdDays === "number") {
    base.proposalFollowUpThresholdDays = ops.proposalFollowUpThresholdDays;
  }
  if (typeof ops.silenceReturnDays === "number") base.silenceReturnDays = ops.silenceReturnDays;
  if (typeof ops.largeDealAmountMinor === "number") base.largeDealAmountMinor = ops.largeDealAmountMinor;
  if (ops.stageSlaDays && typeof ops.stageSlaDays === "object") {
    base.stageSlaDays = { ...base.stageSlaDays, ...(ops.stageSlaDays as Record<string, number>) };
  }
  return base;
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
