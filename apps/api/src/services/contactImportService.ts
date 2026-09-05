/** CSV / simple tabular import for campaign recipients. XLSX is accepted as CSV export or TSV-like text. */

export type ImportColumnKey = "name" | "phone" | "company" | "email" | "service" | "comment" | "skip";

export type ImportRow = {
  rowIndex: number;
  values: Record<string, string>;
  mapped: {
    name?: string;
    phone?: string;
    company?: string;
    email?: string;
    service?: string;
    comment?: string;
  };
};

const HEADER_ALIASES: Record<ImportColumnKey, string[]> = {
  name: ["имя", "name", "фио", "клиент", "contact", "fullname", "first name"],
  phone: ["телефон", "phone", "мобильный", "whatsapp", "номер", "tel", "mobile"],
  company: ["компания", "company", "организация", "firm"],
  email: ["email", "e-mail", "почта", "mail"],
  service: ["услуга", "service", "интерес", "направление", "interest", "product"],
  comment: ["комментарий", "comment", "note", "заметка", "notes"],
  skip: [],
};

function detectDelimiter(firstLine: string) {
  const candidates = [",", ";", "\t"] as const;
  let best: (typeof candidates)[number] = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const count = firstLine.split(d).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function guessMapping(headers: string[]): Record<string, ImportColumnKey> {
  const mapping: Record<string, ImportColumnKey> = {};
  for (const header of headers) {
    const norm = header.toLowerCase().trim();
    let matched: ImportColumnKey = "skip";
    for (const [key, aliases] of Object.entries(HEADER_ALIASES) as Array<[ImportColumnKey, string[]]>) {
      if (key === "skip") continue;
      if (aliases.some((a) => norm === a || norm.includes(a))) {
        matched = key;
        break;
      }
    }
    mapping[header] = matched;
  }
  if (!Object.values(mapping).includes("phone")) {
    const phoneLike = headers.find((h) => /\d{5,}/.test(h));
    if (phoneLike) mapping[phoneLike] = "phone";
  }
  return mapping;
}

export function parseContactImportText(text: string) {
  const cleaned = text.replace(/^\uFEFF/, "").trim();
  if (!cleaned) {
    return { headers: [] as string[], rows: [] as ImportRow[], mapping: {} as Record<string, ImportColumnKey>, delimiter: "," };
  }
  const lines = cleaned.split(/\r?\n/).filter((line) => line.trim());
  const delimiter = detectDelimiter(lines[0] || "");
  const headers = parseCsvLine(lines[0], delimiter).map((h, i) => h || `Колонка ${i + 1}`);
  const mapping = guessMapping(headers);
  const rows: ImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i], delimiter);
    const values: Record<string, string> = {};
    headers.forEach((h, idx) => {
      values[h] = cols[idx] || "";
    });
    const mapped: ImportRow["mapped"] = {};
    for (const [header, key] of Object.entries(mapping)) {
      if (key === "skip") continue;
      const val = values[header]?.trim();
      if (val) mapped[key] = val;
    }
    rows.push({ rowIndex: i + 1, values, mapped });
  }
  return { headers, rows, mapping, delimiter };
}

export function applyImportMapping(
  headers: string[],
  rows: Array<{ rowIndex: number; values: Record<string, string> }>,
  mapping: Record<string, ImportColumnKey>,
) {
  return rows.map((row) => {
    const mapped: ImportRow["mapped"] = {};
    for (const [header, key] of Object.entries(mapping)) {
      if (key === "skip") continue;
      const val = row.values[header]?.trim();
      if (val) mapped[key] = val;
    }
    return { ...row, mapped };
  });
}

export function importRowsToPhoneListText(rows: ImportRow[]) {
  return rows
    .map((row) => row.mapped.phone)
    .filter(Boolean)
    .join("\n");
}

/** Best-effort: if binary xlsx was uploaded as base64 text mistakenly, reject; expect CSV/TSV text. */
export function decodeImportFileContent(fileName: string, contentBase64: string) {
  const buf = Buffer.from(contentBase64, "base64");
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    // Without a spreadsheet engine, accept UTF-8 text exports saved with xls/xlsx extension,
    // or reject binary Office packages clearly.
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      throw new Error("XLSX: сохраните лист как CSV (Файл → Сохранить как → CSV) и загрузите снова. Бинарный XLSX пока разбирается через CSV.");
    }
  }
  return buf.toString("utf8");
}
