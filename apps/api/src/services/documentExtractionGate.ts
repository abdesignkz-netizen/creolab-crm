import { ApiError } from "../errors.ts";

let active = false;
export function beginDocumentExtraction() {
  if (active) throw new ApiError(429, "pdf_import_busy", "Сейчас распознаётся другой документ. Дождитесь завершения и повторите загрузку.");
  active = true;
  return () => { active = false; };
}
