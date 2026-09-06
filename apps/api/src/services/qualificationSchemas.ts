/** Qualification schemas by service category — what AI should know vs ask */

export type QualificationField = {
  key: string;
  label: string;
};

export const QUALIFICATION_SCHEMAS: Record<string, QualificationField[]> = {
  web: [
    { key: "site_type", label: "Тип сайта" },
    { key: "site_goal", label: "Задача сайта" },
    { key: "audience", label: "Целевая аудитория" },
    { key: "structure", label: "Примерная структура / объём" },
    { key: "functionality", label: "Функциональность" },
    { key: "materials", label: "Материалы" },
    { key: "deadline", label: "Срок" },
    { key: "budget", label: "Бюджет" },
  ],
  presentation: [
    { key: "presentation_type", label: "Тип презентации" },
    { key: "audience", label: "Для кого" },
    { key: "goal", label: "Цель" },
    { key: "volume", label: "Объём" },
    { key: "materials", label: "Исходные материалы" },
    { key: "deadline", label: "Срок" },
    { key: "format", label: "Формат результата" },
    { key: "budget", label: "Бюджет" },
  ],
  advertising: [
    { key: "business", label: "Бизнес" },
    { key: "offer", label: "Что рекламируем" },
    { key: "geo", label: "География" },
    { key: "landing", label: "Сайт / landing" },
    { key: "current_ads", label: "Текущая реклама" },
    { key: "ad_budget", label: "Рекламный бюджет" },
    { key: "goal", label: "Цель рекламы" },
  ],
  branding: [
    { key: "need", label: "Что нужно" },
    { key: "new_or_redesign", label: "Новый бренд / редизайн" },
    { key: "audience", label: "Аудитория" },
    { key: "positioning", label: "Позиционирование" },
    { key: "deadline", label: "Срок" },
    { key: "carriers", label: "Носители" },
    { key: "budget", label: "Бюджет" },
  ],
  ai: [
    { key: "use_case", label: "Сценарий использования" },
    { key: "channels", label: "Каналы" },
    { key: "integrations", label: "Интеграции" },
    { key: "deadline", label: "Срок" },
    { key: "budget", label: "Бюджет" },
  ],
  other: [
    { key: "need", label: "Потребность" },
    { key: "deadline", label: "Срок" },
    { key: "budget", label: "Бюджет" },
  ],
};

export function schemaForCategory(category?: string | null): QualificationField[] {
  const key = String(category || "other").toLowerCase();
  return QUALIFICATION_SCHEMAS[key] || QUALIFICATION_SCHEMAS.other;
}
