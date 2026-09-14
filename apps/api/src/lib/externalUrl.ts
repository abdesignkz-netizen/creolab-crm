import { ApiError } from "../errors.ts";

const PRIVATE_HOST =
  /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

export function assertExternalCallbackUrl(raw: string, field = "url") {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ApiError(422, "invalid_url", "Некорректный адрес подключения", { [field]: "Укажите полный URL" });
  }
  if (parsed.protocol === "https:") {
    if (PRIVATE_HOST.test(parsed.hostname) && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new ApiError(422, "invalid_url", "Адрес указывает на закрытую сеть", { [field]: "Нельзя использовать внутренний адрес" });
    }
    return parsed;
  }
  if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
    return parsed;
  }
  throw new ApiError(422, "invalid_url", "Допускается https или http://localhost", { [field]: "Нужен https" });
}
