/** Visual tone for a short status label shown as a chip. */
export function statusBadgeTone(label?: string | null): "ok" | "warn" | "danger" | "" {
  const t = String(label || "").trim().toLowerCase();
  if (!t) return "";
  if (/^не подключ|^не отвечает|^ожидает|^приостановл|^не активн|^не задан/.test(t)) return "warn";
  if (/^ошибк/.test(t)) return "danger";
  if (/^активн/.test(t) || /^(подключ[её]н|работает)/.test(t)) return "ok";
  return "";
}

export function statusBadgeClass(label?: string | null) {
  const tone = statusBadgeTone(label);
  return tone ? `badge ${tone}` : "badge";
}
