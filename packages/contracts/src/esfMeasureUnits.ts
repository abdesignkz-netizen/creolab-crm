/** OKEI / «Единицы измерения» as used in ИС ЭСФ (AVR G3 measureUnitCode). */
export type EsfMeasureUnit = {
  code: string;
  symbol: string;
  name: string;
  group: "common" | "length" | "area" | "volume" | "mass" | "time" | "other";
};

export const ESF_DEFAULT_MEASURE_UNIT_CODE = "796";

export const ESF_MEASURE_UNIT_GROUPS: Array<{ id: EsfMeasureUnit["group"]; label: string }> = [
  { id: "common", label: "Часто используются" },
  { id: "time", label: "Время" },
  { id: "length", label: "Длина" },
  { id: "area", label: "Площадь" },
  { id: "volume", label: "Объём" },
  { id: "mass", label: "Масса" },
  { id: "other", label: "Прочие" },
];

export const ESF_MEASURE_UNITS: EsfMeasureUnit[] = [
  { code: "796", symbol: "шт", name: "штука", group: "common" },
  { code: "839", symbol: "ед", name: "единица", group: "common" },
  { code: "868", symbol: "усл. ед", name: "условная единица", group: "common" },
  { code: "778", symbol: "упак", name: "упаковка", group: "common" },
  { code: "704", symbol: "набор", name: "набор", group: "common" },
  { code: "356", symbol: "ч", name: "час", group: "time" },
  { code: "359", symbol: "сут", name: "сутки", group: "time" },
  { code: "360", symbol: "нед", name: "неделя", group: "time" },
  { code: "362", symbol: "мес", name: "месяц", group: "time" },
  { code: "364", symbol: "кварт.", name: "квартал", group: "time" },
  { code: "366", symbol: "год", name: "год", group: "time" },
  { code: "003", symbol: "мм", name: "миллиметр", group: "length" },
  { code: "004", symbol: "см", name: "сантиметр", group: "length" },
  { code: "006", symbol: "м", name: "метр", group: "length" },
  { code: "008", symbol: "км", name: "километр", group: "length" },
  { code: "018", symbol: "пог. м", name: "погонный метр", group: "length" },
  { code: "050", symbol: "мм2", name: "квадратный миллиметр", group: "area" },
  { code: "051", symbol: "см2", name: "квадратный сантиметр", group: "area" },
  { code: "055", symbol: "м2", name: "квадратный метр", group: "area" },
  { code: "058", symbol: "тыс. м2", name: "тысяча квадратных метров", group: "area" },
  { code: "059", symbol: "га", name: "гектар", group: "area" },
  { code: "061", symbol: "км2", name: "квадратный километр", group: "area" },
  { code: "111", symbol: "см3", name: "кубический сантиметр", group: "volume" },
  { code: "112", symbol: "л", name: "литр", group: "volume" },
  { code: "113", symbol: "м3", name: "кубический метр", group: "volume" },
  { code: "118", symbol: "тыс. м3", name: "тысяча кубических метров", group: "volume" },
  { code: "163", symbol: "г", name: "грамм", group: "mass" },
  { code: "166", symbol: "кг", name: "килограмм", group: "mass" },
  { code: "168", symbol: "т", name: "тонна", group: "mass" },
  { code: "792", symbol: "чел", name: "человек", group: "other" },
  { code: "625", symbol: "лист", name: "лист", group: "other" },
  { code: "657", symbol: "сотня", name: "сотня", group: "other" },
  { code: "715", symbol: "пар", name: "пара", group: "other" },
  { code: "730", symbol: "часть", name: "часть", group: "other" },
  { code: "797", symbol: "сто шт", name: "сто штук", group: "other" },
  { code: "798", symbol: "тыс. шт", name: "тысяча штук", group: "other" },
  { code: "831", symbol: "рул", name: "рулон", group: "other" },
  { code: "845", symbol: "бут", name: "бутылка", group: "other" },
];

const BY_CODE = new Map(ESF_MEASURE_UNITS.map((unit) => [unit.code, unit]));

const ALIASES: Record<string, string> = {
  услуга: "796",
  услуги: "796",
  шт: "796",
  штука: "796",
  штуки: "796",
  ед: "839",
  единица: "839",
  "усл. ед": "868",
  "усл.ед": "868",
  упак: "778",
  упаковка: "778",
  набор: "704",
  час: "356",
  часа: "356",
  часов: "356",
  ч: "356",
  hour: "356",
  сутки: "359",
  сут: "359",
  неделя: "360",
  нед: "360",
  месяц: "362",
  мес: "362",
  квартал: "364",
  год: "366",
  мм: "003",
  см: "004",
  м: "006",
  метр: "006",
  км: "008",
  "пог. м": "018",
  "пог.м": "018",
  м2: "055",
  "м²": "055",
  га: "059",
  см3: "111",
  "см³": "111",
  мл: "111",
  л: "112",
  литр: "112",
  м3: "113",
  "м³": "113",
  грамм: "163",
  кг: "166",
  килограмм: "166",
  т: "168",
  тонна: "168",
  чел: "792",
  человек: "792",
  лист: "625",
  пара: "715",
  пар: "715",
  рулон: "831",
};

function aliasKey(value: string) {
  return value.toLowerCase().replace(/\.$/, "").replace(/\s+/g, " ");
}

export function findEsfMeasureUnit(code: string | null | undefined) {
  return BY_CODE.get(String(code || "").trim()) || null;
}

export function resolveEsfMeasureUnitCode(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return ESF_DEFAULT_MEASURE_UNIT_CODE;
  if (BY_CODE.has(raw)) return raw;
  const alias = ALIASES[aliasKey(raw)];
  if (alias) return alias;
  if (/^\d{1,4}$/.test(raw)) {
    const padded = raw.padStart(3, "0");
    if (BY_CODE.has(padded)) return padded;
    return raw;
  }
  return ESF_DEFAULT_MEASURE_UNIT_CODE;
}

export function formatEsfMeasureUnit(value: string | null | undefined) {
  const code = resolveEsfMeasureUnitCode(value);
  const unit = findEsfMeasureUnit(code);
  return unit ? esfMeasureUnitOptionLabel(unit) : code;
}

export function esfMeasureUnitOptionLabel(unit: EsfMeasureUnit) {
  return `${unit.code} — ${unit.symbol} (${unit.name})`;
}

export function esfMeasureUnitShortLabel(value: string | null | undefined) {
  const code = resolveEsfMeasureUnitCode(value);
  const unit = findEsfMeasureUnit(code);
  return unit ? `${unit.symbol} (${unit.code})` : code;
}

export function esfMeasureUnitSymbol(value: string | null | undefined) {
  const code = resolveEsfMeasureUnitCode(value);
  return findEsfMeasureUnit(code)?.symbol || String(value || "").trim() || "шт";
}
