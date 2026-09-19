export const DEAL_OUTCOME_LABEL: Record<string, string> = {
  open: "Открыта",
  won: "Продажа",
  lost: "Потеря",
  on_hold: "На паузе",
};

export function dealOutcomeLabel(outcome?: string | null, stageName?: string | null) {
  if (outcome === "open" || !outcome) return stageName || "Открыта";
  return DEAL_OUTCOME_LABEL[outcome] || stageName || outcome;
}

export function conversationModeLabel(mode?: string | null, fallback?: string | null) {
  if (fallback) return fallback;
  const map: Record<string, string> = {
    ai: "AI",
    human: "Сотрудник",
    paused: "Пауза",
  };
  return map[String(mode || "")] || mode || "";
}
