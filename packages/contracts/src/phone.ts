import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export type PhoneValidation =
  | {
      ok: true;
      raw: string;
      e164: string;
      normalized: string;
      country?: string;
    }
  | {
      ok: false;
      raw: string;
      code: "missing_phone" | "invalid_phone";
      message: string;
    };

const TEMPLATE_MARKERS = ["<", ">", "телефон_клиента", "example", "xxx"];

export function validateClientPhone(
  input: unknown,
  defaultRegion: string = "KZ",
): PhoneValidation {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return {
      ok: false,
      raw,
      code: "missing_phone",
      message: "Укажите номер телефона клиента",
    };
  }

  const lowered = raw.toLowerCase();
  if (TEMPLATE_MARKERS.some((marker) => lowered.includes(marker))) {
    return {
      ok: false,
      raw,
      code: "invalid_phone",
      message: "Шаблон номера не проходит валидацию",
    };
  }

  const region = (defaultRegion || "KZ").toUpperCase() as CountryCode;
  const parsed = parsePhoneNumberFromString(raw, region);
  if (!parsed || !parsed.isValid()) {
    return {
      ok: false,
      raw,
      code: "invalid_phone",
      message: "Некорректный международный номер телефона",
    };
  }

  const e164 = parsed.number;
  return {
    ok: true,
    raw,
    e164,
    normalized: e164.replace(/^\+/, ""),
    country: parsed.country,
  };
}

export function isUuid(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
