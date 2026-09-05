import * as XLSX from "xlsx";
import {
  applyImportMapping,
  importRowsToPhoneListText,
  parseContactImportText,
  type ImportColumnKey,
  type ImportRow,
} from "./contactImportService.ts";

export type { ImportColumnKey, ImportRow };

function sheetToCsvText(buf: Buffer) {
  const workbook = XLSX.read(buf, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("В файле нет листов");
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_csv(sheet);
}

export function parseContactImportFile(fileName: string, contentBase64: string, mapping?: Record<string, ImportColumnKey>) {
  const buf = Buffer.from(contentBase64, "base64");
  const lower = fileName.toLowerCase();
  let text: string;
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    text = sheetToCsvText(buf);
  } else {
    text = buf.toString("utf8");
  }
  const parsed = parseContactImportText(text);
  const effectiveMapping = mapping || parsed.mapping;
  const rows = applyImportMapping(parsed.headers, parsed.rows, effectiveMapping);
  const withPhone = rows.filter((row) => Boolean(row.mapped.phone));
  return {
    fileName,
    headers: parsed.headers,
    mapping: effectiveMapping,
    rows,
    phoneListText: importRowsToPhoneListText(rows),
    summary: {
      totalRows: rows.length,
      withPhone: withPhone.length,
      withoutPhone: rows.length - withPhone.length,
    },
  };
}
