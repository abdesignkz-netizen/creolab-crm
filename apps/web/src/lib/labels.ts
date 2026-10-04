import { uiText, useUiText, localizeUiOptions } from "./uiText";
export const DEAL_OUTCOME_LABEL: Record<string, string> = {
  open: "Открыта",
  won: "Продажа",
  lost: "Потеря",
  on_hold: "На паузе",
};

export function dealOutcomeLabel(outcome?: string | null, stageName?: string | null) {
  if (outcome === "open" || !outcome) return stageName || uiText("Открыта");
  return localizeUiOptions(DEAL_OUTCOME_LABEL, uiText)[outcome] || stageName || outcome;
}

export function conversationModeLabel(mode?: string | null, fallback?: string | null) {
  if (fallback) return uiText(fallback);
  const map: Record<string, string> = {
    ai: "AI",
    human: uiText("Сотрудник"),
    paused: uiText("Пауза"),
  };
  return map[String(mode || "")] || mode || "";
}
