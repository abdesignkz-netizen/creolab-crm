import { uiMessage, uiText } from "./uiText";

export function analyticsCoverageLines(data: any): string[] {
  if (!data?.coverage?.partial) return [];
  const lines = [uiText("Часть подробного отчёта неполная. Сузьте период или фильтры.")];
  if (data.coverage.totalsComplete) lines.push(uiText("Общие количества и суммы рассчитаны по всем подходящим записям."));
  for (const section of data.coverage.sections || []) {
    const detail = section.status === "unavailable"
      ? uiText("Данные временно недоступны. Повторите загрузку.")
      : uiText("Учтено {shown} записей; найдено не менее {total}.", { shown: section.loaded, total: section.atLeast });
    lines.push(`${uiMessage(section.label)}: ${detail}`);
  }
  return [...new Set(lines)];
}
