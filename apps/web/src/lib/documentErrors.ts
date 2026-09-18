const names: Record<string, string> = {
  documentDate: "Дата документа", name: "Название", quantity: "Количество", unit: "Единица измерения",
  unitPrice: "Цена без НДС", vatRate: "НДС", paymentPercent: "Процент оплаты", legalName: "Юридическое название", bin: "БИН / ИИН",
  iin: "ИИН пользователя для авторизации", legalAddress: "Юридический адрес", iban: "ИИК / IBAN",
  bik: "БИК", directorName: "Руководитель", directorBasis: "Основание полномочий", bankName: "Банк",
  cabinetUsername: "ИИН / логин кабинета ИС ЭСФ", cabinetPassword: "Пароль кабинета ИС ЭСФ",
  signedAuthTicket: "Ответ NCALayer для авторизации ИС ЭСФ", authCmsBase64: "Сертификат авторизации NCALayer",
  publicCertificate: "Публичный сертификат подписи", signature: "Подпись NCALayer", payloadSha256: "Версия подписываемого документа",
  updatedAt: "Версия черновика", body: "Документ", items: "Позиции документа", ncalayer: "NCALayer",
  contractNumber: "Номер договора", contractDate: "Дата договора",
};
export function documentFieldLabel(path: string) {
  const parts = path.replace(/^editor\./, "").split(".");
  const prefix = parts[0] === "organization" ? "Исполнитель: " : parts[0] === "customer" ? "Заказчик: " : parts[0] === "items" && /^\d+$/.test(parts[1]) ? `Позиция ${Number(parts[1]) + 1}: ` : "";
  return prefix + (names[parts.at(-1)!] || path || "Документ");
}
export function documentErrorFields(error: any, customer = false): Record<string, string> {
  const body = error?.body || {};
  const result: Record<string, string> = {};
  const add = (path: string, message: unknown) => {
    const key = path.replace(/^editor\./, "");
    const target = customer && !key.startsWith("customer.") ? `customer.${key}` : key;
    const value = Array.isArray(message) ? message.join("; ") : String(message);
    result[target] = result[target] ? `${result[target]}; ${value}` : value;
  };
  if (Array.isArray(body.field_issues)) body.field_issues.forEach((i: any) => add(i.path || "body", i.message));
  else Object.entries(body.field_errors || {}).forEach(([path, message]) => add(path, message));
  const detail = body.details || body;
  if (Array.isArray(detail.missingFields)) detail.missingFields.forEach((path: string) => add(path, detail.missingFieldLabels?.[path] || "Нужно заполнить"));
  return result;
}
