export function phoneText(phone?: string | null) {
  const value = phone == null ? "" : String(phone).trim();
  return value || "Нет телефона";
}

export function nameWithPhone(name?: string | null, phone?: string | null) {
  const n = name == null ? "" : String(name).trim();
  return `${n || "Без имени"} · ${phoneText(phone)}`;
}
