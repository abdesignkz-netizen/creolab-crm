import type { CompanyRequisitesDraft, PdfImportParty } from "@creolab/contracts";
import { parsePdfDocument } from "./pdfDocumentParser.ts";
import type { PdfPageText } from "./pdfTextExtraction.ts";

const ORG_RE = /(?:ТОО|TOO|ИП|АО|НАО|ЖШС)\s*[«"“„'][^»"”']+[»"”']/i;
const ORG_GLOBAL = new RegExp(ORG_RE.source, "gi");

export function emptyCompanyRequisites(): CompanyRequisitesDraft {
  return {
    name: "",
    legalName: "",
    bin: "",
    iin: "",
    legalAddress: "",
    city: "",
    iban: "",
    bankName: "",
    bik: "",
    directorName: "",
    phone: "",
    email: "",
  };
}

export function scoreCompanyRequisites(draft: CompanyRequisitesDraft) {
  return (
    (draft.name ? 3 : 0) +
    (draft.bin || draft.iin ? 3 : 0) +
    (draft.iban ? 2 : 0) +
    (draft.legalAddress ? 1 : 0) +
    (draft.bankName ? 1 : 0) +
    (draft.bik ? 1 : 0) +
    (draft.directorName ? 1 : 0) +
    (draft.phone ? 1 : 0) +
    (draft.email ? 1 : 0)
  );
}

function clean(text: string) {
  return text.replace(/[|¦\[\]]/g, " ").replace(/[ \t]+/g, " ").replace(/\s+,/g, ",").trim();
}

function normalizeIbanSpacing(text: string) {
  return text.replace(/KZ(?:[\s\u00a0]*[A-Z0-9]){18}/gi, (match) => match.replace(/[\s\u00a0]/g, ""));
}

function taxId(draft: CompanyRequisitesDraft) {
  return draft.bin || draft.iin;
}

function cleanBank(line: string) {
  const value = clean(line)
    .replace(/^(?:Банк(?:\s+бенефициара)?|БАНК)\s*:?\s*/i, "")
    .replace(/\s+(?:БИК|ИИК|IBAN|КБе)\b.*$/i, "")
    .trim();
  if (!value || /бенефициара/i.test(value)) return "";
  return value.slice(0, 200);
}

function cityFrom(text: string) {
  return text.match(/г(?:ород)?\.?\s*([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z\-]+)/)?.[1] || "";
}

function taxIdAfterLabel(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  const digits = String(match?.[1] || "").replace(/\D/g, "");
  return digits.length === 12 ? digits : "";
}

export function parseRequisitesBlock(text: string): CompanyRequisitesDraft {
  const raw = normalizeIbanSpacing(text);
  const lines = raw.split(/\r?\n/).map((line) => clean(line)).filter(Boolean);
  const joined = lines.join("\n");
  const draft = emptyCompanyRequisites();

  const quoted = joined.match(ORG_RE)?.[0] || "";
  draft.name = quoted.replace(/^TOO\b/i, "ТОО").trim();
  if (!draft.name) {
    draft.name = joined.match(/ИП\s+[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){0,3}/)?.[0]?.trim() || "";
  }
  draft.legalName = draft.name;

  const binLabeled = taxIdAfterLabel(joined, /БИН(?:\s*\/\s*ИИН)?\s*:?\s*([\d\s]{12,20})/i);
  const iinLabeled = taxIdAfterLabel(joined, /(?:^|[^\w])ИИН\s*:?\s*([\d\s]{12,20})/i);
  const tax = binLabeled || iinLabeled || "";
  if (/ИП\b/i.test(draft.name) || (iinLabeled && !binLabeled)) draft.iin = tax || iinLabeled || "";
  else draft.bin = tax;
  if (!draft.bin && !draft.iin) {
    const any12 = joined.match(/\b(\d{12})\b/)?.[1];
    if (any12) draft.bin = any12;
  }

  draft.iban = (raw.match(/\bKZ[A-Z0-9]{18}\b/i)?.[0] || "").toUpperCase();
  draft.bik = (joined.match(/БИК\s*:?\s*([A-Z]{4}KZ[A-Z0-9]{2,5}|[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)/i)?.[1] || "").toUpperCase();

  const bankLine = lines.find(
    (line) =>
      /банк/i.test(line) &&
      !/бенефициара/i.test(line) &&
      (/(?:АО|ТОО|НАО|Bank)/i.test(line) || /банк\s*:/i.test(line) || /[«"“]/.test(line)),
  );
  if (bankLine) draft.bankName = cleanBank(bankLine);

  const addrLabeled = joined.match(
    /(?:Юридический\s+адрес|Юр\.?\s*адрес|Фактический\s+адрес|Адрес)\s*:?\s*([^\n]+)/i,
  );
  if (addrLabeled) {
    draft.legalAddress = clean(addrLabeled[1].replace(/\s+(?:Тел(?:ефон)?|БИН|ИИН|ИИК|БИК|E-?mail).*$/i, ""));
  } else if (draft.name) {
    const after = joined.slice(joined.indexOf(draft.name) + draft.name.length).replace(/^[\s,;]+/, "");
    const chunk = after.split(/\n|Тел(?:ефон)?\.?\s*:|БИН|ИИН|ИИК|БИК|\bKZ|Директор|E-?mail/i)[0].trim();
    if (/^(?:РК|Республика Казахстан|Казахстан|\d{6}|г\.)/i.test(chunk)) {
      draft.legalAddress = clean(chunk.replace(/\s+/g, " "));
    }
  }

  draft.city = cityFrom(draft.legalAddress || joined);

  const directorInline = joined.match(
    /(?:в лице\s+(?:Генерального\s+директора|Директора)|Генеральный\s+директор|Директор|Руководитель)\s*:?\s*([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){0,3}(?:\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.)?)/i,
  );
  if (directorInline) draft.directorName = clean(directorInline[1]);
  else {
    const idx = lines.findIndex((line) => /^Директор(?:\s|:|$)/i.test(line) && !/[А-ЯЁ][а-яё]{2,}/.test(line.replace(/^Директор\s*:?\s*/i, "")));
    if (idx >= 0) {
      draft.directorName = lines.slice(idx + 1).find((line) => /^[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё.]+)+/.test(line)) || "";
    }
  }

  draft.phone = (joined.match(/(?:Тел(?:ефон)?|моб(?:ильный)?)\.?\s*:?\s*(\+?\s*[78][\d\s()\-]{9,22})/i)?.[1] || "")
    .replace(/\s+/g, " ")
    .trim();
  draft.email = joined.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] || "";

  if (draft.legalAddress.length > 400) draft.legalAddress = draft.legalAddress.slice(0, 400);
  if (draft.name.length > 200) draft.name = draft.name.slice(0, 200);
  if (draft.legalName.length > 300) draft.legalName = draft.legalName.slice(0, 300);
  return draft;
}

export function mergeCompanyRequisites(primary: CompanyRequisitesDraft, secondary: CompanyRequisitesDraft) {
  const out = { ...primary };
  for (const key of Object.keys(out) as Array<keyof CompanyRequisitesDraft>) {
    if (!out[key] && secondary[key]) out[key] = secondary[key];
  }
  if (!out.legalName) out.legalName = out.name;
  if (!out.city) out.city = cityFrom(out.legalAddress);
  return out;
}

function extractRoleBlocks(text: string) {
  const normalized = text.replace(/\r\n/g, "\n");
  const buyer =
    normalized.match(
      /(?:^|\n)\s*(?:Покупатель|Заказчик)\s*:?\s*([\s\S]*?)(?=(?:\n\s*(?:Поставщик|Исполнитель|Основание|Договор|Итого)\s*:)|\n№\s|$)/i,
    )?.[1]?.trim() || "";
  const seller =
    normalized.match(
      /(?:^|\n)\s*(?:Поставщик|Исполнитель)\s*:?\s*([\s\S]*?)(?=(?:\n\s*(?:Покупатель|Заказчик|Основание|Договор|Итого)\s*:)|\n№\s|$)/i,
    )?.[1]?.trim() || "";
  return { buyer, seller };
}

function isBankOrganization(name: string) {
  return /банк|bank/i.test(name);
}

function splitByOrganizations(text: string) {
  const matches = [...text.matchAll(ORG_GLOBAL)].filter((match) => !isBankOrganization(match[0]));
  if (matches.length < 2) return [];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    return text.slice(start, end);
  });
}

function fromPdfParty(party: PdfImportParty, extra?: { phone?: string }) {
  const base = emptyCompanyRequisites();
  base.name = (party.name || "").replace(/^TOO\b/i, "ТОО").trim();
  base.legalName = base.name;
  base.bin = party.bin || "";
  base.legalAddress = party.legalAddress || "";
  base.iban = party.iban || "";
  base.bankName = cleanBank(party.bankName || "");
  base.bik = party.bik || "";
  base.directorName = party.directorName || "";
  base.phone = extra?.phone || "";
  base.city = cityFrom(base.legalAddress);
  return mergeCompanyRequisites(
    base,
    parseRequisitesBlock(
      [
        party.name,
        party.bin ? `БИН ${party.bin}` : "",
        party.legalAddress,
        party.iban ? `ИИК ${party.iban}` : "",
        party.bankName,
        party.bik ? `БИК ${party.bik}` : "",
        party.directorName ? `Директор: ${party.directorName}` : "",
        extra?.phone ? `Тел: ${extra.phone}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  );
}

function detectDocumentKind(text: string): "CONTRACT" | "INVOICE" | null {
  if (/реквизиты\s+сторон/i.test(text) || (/заказчик/i.test(text) && /исполнитель/i.test(text) && /договор/i.test(text))) {
    return "CONTRACT";
  }
  if (/сч[её]т\s+на\s+оплату/i.test(text) && /покупатель/i.test(text)) return "INVOICE";
  if (/(?:^|\n)\s*(?:поставщик|покупатель)\s*:/i.test(text)) return "INVOICE";
  return null;
}

type LabeledDraft = { draft: CompanyRequisitesDraft; role?: "buyer" | "seller" };

function pickCompanyDraft(parties: LabeledDraft[], tenantBin?: string | null) {
  const usable = parties.filter((item) => (item.draft.name || taxId(item.draft)) && !isBankOrganization(item.draft.name));
  if (!usable.length) {
    return { draft: emptyCompanyRequisites(), source: "text" as const, warnings: [] as string[] };
  }
  if (tenantBin) {
    const others = usable.filter((item) => taxId(item.draft) !== tenantBin);
    if (others.length === 1) {
      const warnings = usable.some((item) => taxId(item.draft) === tenantBin)
        ? ["В документе две организации. Заполнены реквизиты контрагента, не вашей компании."]
        : [];
      return { draft: others[0].draft, source: others[0].role || "text", warnings };
    }
  }
  const buyer = usable.find((item) => item.role === "buyer");
  if (buyer && (!tenantBin || taxId(buyer.draft) !== tenantBin)) {
    const warnings = usable.some((item) => item.role === "seller")
      ? ["В документе две организации. Заполнены реквизиты покупателя / заказчика; при необходимости поправьте."]
      : [];
    return { draft: buyer.draft, source: "buyer" as const, warnings };
  }
  const ranked = [...usable].sort((a, b) => scoreCompanyRequisites(b.draft) - scoreCompanyRequisites(a.draft));
  return { draft: ranked[0].draft, source: ranked[0].role || "text", warnings: [] as string[] };
}

export function recognizeCompanyRequisites(
  text: string,
  options: { tenantBin?: string | null; ocr?: boolean; pages?: PdfPageText[] } = {},
) {
  const parties: LabeledDraft[] = [];
  const kind = options.pages?.length ? detectDocumentKind(text) : null;
  if (kind && options.pages?.length) {
    const parsed = parsePdfDocument(options.pages, kind, options.tenantBin);
    const buyer = fromPdfParty(parsed.draft.buyer, { phone: parsed.draft.contactPhone });
    const seller = fromPdfParty(parsed.draft.seller);
    if (buyer.name || taxId(buyer)) parties.push({ draft: buyer, role: "buyer" });
    if (seller.name || taxId(seller)) parties.push({ draft: seller, role: "seller" });
  }

  const roles = extractRoleBlocks(text);
  if (roles.buyer) parties.push({ draft: parseRequisitesBlock(roles.buyer), role: "buyer" });
  if (roles.seller) parties.push({ draft: parseRequisitesBlock(roles.seller), role: "seller" });

  if (!roles.buyer && !roles.seller) {
    const splits = splitByOrganizations(text).map((block) => ({ draft: parseRequisitesBlock(block) }));
    if (splits.length >= 2) parties.push(...splits);
    else parties.push({ draft: parseRequisitesBlock(text) });
  }

  const mergedByKey = new Map<string, LabeledDraft>();
  for (const item of parties) {
    const key = `${item.role || ""}:${taxId(item.draft) || item.draft.name}`;
    const prev = mergedByKey.get(key);
    mergedByKey.set(key, prev ? { role: item.role || prev.role, draft: mergeCompanyRequisites(scoreCompanyRequisites(item.draft) >= scoreCompanyRequisites(prev.draft) ? item.draft : prev.draft, scoreCompanyRequisites(item.draft) >= scoreCompanyRequisites(prev.draft) ? prev.draft : item.draft) } : item);
  }

  const picked = pickCompanyDraft([...mergedByKey.values()], options.tenantBin);
  const warnings = [...picked.warnings];
  if (options.ocr) warnings.push("Документ содержит сканы. Сверьте БИН, адрес и банк перед сохранением.");
  if (options.tenantBin && taxId(picked.draft) === options.tenantBin) {
    warnings.push("Похоже, это реквизиты вашей организации. Проверьте, что создаёте карточку клиента.");
  }
  if (!picked.draft.name) warnings.push("Не удалось распознать название. Проверьте и укажите его вручную.");
  if (!taxId(picked.draft)) warnings.push("БИН / ИИН не найден. Проверьте реквизиты.");
  return { draft: picked.draft, source: picked.source, warnings: [...new Set(warnings)] };
}
