export type TemplateParty = {
  name: string;
  bin: string;
  legalAddress: string;
  directorName: string;
  iban: string;
  bankName: string;
  bik: string;
};

export type TemplateSellerProfile = {
  legalName?: string | null;
  shortName?: string | null;
  bin?: string | null;
  iin?: string | null;
  legalAddress?: string | null;
  directorName?: string | null;
  directorPosition?: string | null;
  iban?: string | null;
  bankName?: string | null;
  bik?: string | null;
  phone?: string | null;
  email?: string | null;
};

export type RecognizedTemplateField = {
  key: string;
  label: string;
  found: boolean;
  sample: string;
};

export type ScannedContractTemplate = {
  name: string;
  body: string;
  placeholders: string[];
  fields: RecognizedTemplateField[];
  seller: TemplateParty;
  buyer: TemplateParty;
  warnings: string[];
};

export const TEMPLATE_FIELD_CATALOG: Array<{ key: string; label: string; anyOf?: string[] }> = [
  { key: "contract_number", label: "Номер договора" },
  { key: "contract_date", label: "Дата договора" },
  { key: "seller_name", label: "Ваша организация" },
  { key: "seller_bin", label: "БИН вашей организации" },
  { key: "seller_director", label: "Руководитель вашей стороны" },
  { key: "seller_address", label: "Адрес вашей организации" },
  { key: "seller_iban", label: "Счёт вашей организации" },
  { key: "buyer_name", label: "Заказчик" },
  { key: "buyer_bin", label: "БИН заказчика" },
  { key: "buyer_director", label: "Руководитель заказчика" },
  { key: "buyer_address", label: "Адрес заказчика" },
  { key: "amount", label: "Сумма договора", anyOf: ["amount"] },
  { key: "prepayment_amount", label: "Предоплата" },
  { key: "remainder_amount", label: "Остаток оплаты" },
  { key: "completion_terms", label: "Срок исполнения" },
  { key: "items_table", label: "Состав работ и услуг" },
];

const RU_MONTH = "января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря";
const CONTRACT_NO = "[A-ZА-ЯЁ0-9][A-ZА-ЯЁA-Za-zа-яё0-9./\\-]*";
const SELLER_ROLE = "(?:Исполнитель|Подрядчик|Поставщик|Продавец|Арендодатель)";
const BUYER_ROLE = "(?:Заказчик|Покупатель|Клиент|Арендатор)";
const SELLER_LABELS = ["Исполнитель", "Подрядчик", "Поставщик", "Продавец", "Арендодатель"];
const BUYER_LABELS = ["Заказчик", "Покупатель", "Клиент", "Арендатор"];

function taxDigits(value: string | null | undefined) {
  return String(value || "").replace(/\D/g, "");
}

function clean(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeOrg(value: string) {
  return clean(value)
    .toLowerCase()
    .replace(/[«»„“”"']/g, "")
    .replace(/\btoo\b/g, "тоо")
    .replace(/\s+/g, " ");
}

function legalNameMatch(profile: TemplateSellerProfile, candidate: string) {
  if (!candidate) return false;
  const needle = normalizeOrg(candidate);
  const names = [profile.legalName, profile.shortName].map((item) => normalizeOrg(item || "")).filter(Boolean);
  return names.some((name) => name && (needle.includes(name) || name.includes(needle)));
}

const ORG_PATTERN =
  "(?:товарищество с ограниченной ответственностью|ТОО|TOO|ИП|АО|ЖШС)\\s*[«\"“][^»\"”]{1,120}[»\"”]|(?:ТОО|TOO|ИП|АО|ЖШС)\\s+[А-ЯЁA-Z][А-ЯЁA-Za-z0-9«»\"\\- ]{1,80}";

function orgName(block: string) {
  const quoted = block.match(/(?:товарищество с ограниченной ответственностью|ТОО|TOO|ИП|АО|ЖШС)\s*[«"“][^»"”]{1,120}[»"”]/i);
  if (quoted) return clean(quoted[0]).replace(/товарищество с ограниченной ответственностью/i, "ТОО").replace(/^TOO/i, "ТОО");
  const plain = block.match(/(?:ТОО|TOO|ИП|АО|ЖШС)\s+[А-ЯЁA-Z][А-ЯЁA-Za-z0-9«»"\- ]{1,80}/);
  return plain ? clean(plain[0]).replace(/^TOO/i, "ТОО") : "";
}

function directorIn(block: string) {
  const labeled = block.match(
    /в\s+лице\s+(?:генерального\s+директора|директора|руководителя|управляющего|индивидуального\s+предпринимателя)?\s*([А-ЯЁ][А-ЯЁа-яё\-]+(?:\s+[А-ЯЁ][А-ЯЁа-яё\-]+|\s+[А-ЯЁA-Z]\.\s*[А-ЯЁA-Z]\.){0,2})/i,
  );
  if (labeled) return clean(labeled[1]).slice(0, 80);
  const initials = block.match(/([А-ЯЁ][а-яё]+\s+[А-ЯЁA-Z]\.\s*[А-ЯЁA-Z]\.)/);
  return initials ? clean(initials[1]) : "";
}

function binIn(block: string) {
  const labeled = block.match(/БИН(?:\s*\/\s*ИИН)?\s*:?\s*([\d\s]{12,20})/i);
  const digits = taxDigits(labeled?.[1] || "");
  return digits.length === 12 ? digits : "";
}

function ibanIn(block: string) {
  const labeled = block.match(/(?:ИИК|IBAN|р\/сч?)\s*:?\s*(KZ[A-Z0-9 \t]{18,36})/i)?.[1]?.replace(/[ \t]/g, "") || "";
  if (/^KZ[A-Z0-9]{18}$/i.test(labeled)) return labeled.toUpperCase();
  const raw = block.match(/\bKZ(?:[ \t]*[A-Z0-9]){18}\b/i)?.[0]?.replace(/[ \t]/g, "") || "";
  return /^KZ[A-Z0-9]{18}$/i.test(raw) ? raw.toUpperCase() : "";
}

function bikIn(block: string) {
  return block.match(/БИК\s*:?\s*([A-Z0-9]{8,11})/i)?.[1]?.toUpperCase() || "";
}

function bankIn(block: string) {
  const line = block.split(/\n/).map(clean).find((item) => /банк|bank/i.test(item) && !/бик/i.test(item));
  return line ? clean(line.replace(/^АО\s+АО/, "АО")) : "";
}

function addressIn(block: string, name: string) {
  const text = block.replace(/\u00a0/g, " ");
  const afterName = name && text.includes(name) ? text.slice(text.indexOf(name) + name.length) : text;
  const until = afterName.split(/БИН|ИИН|ИИК|IBAN|\bKZ|БИК|Директор|Тел/i)[0];
  const value = clean(until.replace(/^[\s,;]+/, "").replace(/\n/g, " "));
  if (/^(?:РК|Республика|Казахстан|\d{6}|г\.|город|ул\.|улица)/i.test(value)) return value;
  return "";
}

function windowAfter(text: string, name: string, size = 700) {
  if (!name) return "";
  const idx = text.indexOf(name);
  if (idx < 0) return "";
  const rest = text.slice(idx);
  const nextOrg = rest.slice(name.length).search(/(?:ТОО|TOO|ИП|ЖШС)\s*[«"“A-ZА-ЯЁ]/i);
  return rest.slice(0, nextOrg > 0 ? Math.min(size, name.length + nextOrg) : size);
}

function partyBeforeRole(text: string, role: "seller" | "buyer") {
  const roleWord = role === "buyer" ? BUYER_ROLE : SELLER_ROLE;
  const re = new RegExp(
    `именуем[аоы]е?\\s+(?:в\\s+дальнейшем|далее)\\s*[«"“”']?${roleWord}[»"“”']?`,
    "i",
  );
  const roleMatch = re.exec(text);
  if (!roleMatch || roleMatch.index == null) return { name: "", director: "" };
  const start = Math.max(0, roleMatch.index - 420);
  const before = text.slice(start, roleMatch.index);
  const orgs = [...before.matchAll(new RegExp(ORG_PATTERN, "gi"))];
  const last = orgs[orgs.length - 1];
  const name = last ? orgName(last[0]) || clean(last[0]) : "";
  const fromOrg = last
    ? text.slice(start + (last.index || 0), roleMatch.index + roleMatch[0].length + 220)
    : "";
  return { name, director: directorIn(fromOrg) };
}

function sidesByOrder(text: string) {
  const preamble = text.split(/заключили\s+настоящий/i)[0] || text.slice(0, 1800);
  const orgs = [...preamble.matchAll(new RegExp(ORG_PATTERN, "gi"))].map((match) => orgName(match[0]) || clean(match[0]));
  const unique = [...new Set(orgs.filter(Boolean))];
  return { first: unique[0] || "", second: unique[1] || "" };
}

function partyBySide(text: string, side: "seller" | "buyer") {
  const found = partyBeforeRole(text, side);
  if (found.name) return found;
  const roles = side === "buyer" ? BUYER_LABELS : SELLER_LABELS;
  for (const role of roles) {
    const matched = text.match(
      new RegExp(
        `((?:${ORG_PATTERN}))\\s*,?\\s*именуем[аоы]е?\\s+(?:в\\s+дальнейшем|далее)\\s+[«"“”']${role}[»"“”']`,
        "i",
      ),
    );
    if (!matched) continue;
    const name = orgName(matched[1]) || clean(matched[1]);
    const after =
      matched.index != null
        ? text.slice(matched.index + matched[0].length, matched.index + matched[0].length + 220)
        : "";
    return { name, director: directorIn(after) || directorIn(matched[0]) };
  }
  return { name: "", director: "" };
}

function preambleRoles(text: string) {
  const executor = partyBySide(text, "seller");
  const customer = partyBySide(text, "buyer");
  const ordered = sidesByOrder(text);
  return {
    sellerName: executor.name || ordered.first,
    sellerDirector: executor.director,
    buyerName: customer.name || (ordered.second && ordered.second !== executor.name ? ordered.second : ""),
    buyerDirector: customer.director,
  };
}

function windowForParty(text: string, name: string, side: "seller" | "buyer") {
  const requisites = text.split(/РЕКВИЗИТЫ\s+СТОРОН/i)[1] || text;
  if (name) {
    const byName = windowAfter(requisites, name) || windowAfter(text, name);
    if (byName) return byName;
  }
  const labels = side === "buyer" ? BUYER_LABELS : SELLER_LABELS;
  for (const roleLabel of labels) {
    const parts = requisites.split(new RegExp(`(?:^|\\n)\\s*${roleLabel}\\b\\s*:?\\s*\\n`, "i"));
    if (parts[1]) return parts[1].slice(0, 700);
  }
  return "";
}

function fillParty(text: string, name: string, director: string, side: "seller" | "buyer"): TemplateParty {
  const block = windowForParty(text, name, side);
  return {
    name,
    bin: binIn(block),
    legalAddress: addressIn(block, name),
    directorName: director || directorIn(block),
    iban: ibanIn(block),
    bankName: bankIn(block),
    bik: bikIn(block),
  };
}

function replaceFlexible(text: string, needle: string, placeholder: string) {
  const value = clean(needle);
  if (value.length < 3 || value.length > 240) return text;
  const pattern = escapeRegExp(value).replace(/\\ /g, "\\s+");
  return text.replace(new RegExp(pattern, "gi"), placeholder);
}

function replaceBin(text: string, bin: string, placeholder: string) {
  if (taxDigits(bin).length !== 12) return text;
  return text.replace(new RegExp(taxDigits(bin).split("").join("\\s*"), "g"), placeholder);
}

function replaceIban(text: string, iban: string, placeholder: string) {
  if (!iban) return text;
  return text.replace(new RegExp(iban.split("").join("\\s*"), "gi"), placeholder);
}

function moneyAmounts(text: string) {
  const found = [
    ...text.matchAll(/\b(\d{1,3}(?:\s\d{3}){1,3}|\d{4,7})(?:\s*\([^)]{3,80}\))?\s*(?:тенге|₸)/gi),
    ...text.matchAll(/Итого:\s*(\d{1,3}(?:\s\d{3}){1,3}|\d{4,7})/gi),
  ];
  return [...new Set(found.map((match) => Number(String(match[1]).replace(/\s/g, ""))).filter((n) => n >= 1000))];
}

function ruDatePattern(flags = "gi") {
  return new RegExp(
    `[«"“']?\\d{1,2}[»"”']?\\s+(?:${RU_MONTH})\\s+20\\d{2}(?:\\s*г(?:ода)?\\.?)?`,
    flags,
  );
}

function lastMatchIndex(pattern: RegExp, text: string) {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let last = -1;
  for (const match of text.matchAll(re)) {
    if (match.index != null) last = match.index;
  }
  return last;
}

function amountRole(before: string): "prepayment" | "remainder" | "total" | "skip" {
  const slice = before.replace(/\s+/g, " ");
  if (/неустойк|штраф|пен[яи]|госпошлин|нотариал|гербов/i.test(slice)) return "skip";
  const prepayAt = lastMatchIndex(/предоплат|аванс|перв(?:ая|ую)\s+част/gi, slice);
  const remainAt = lastMatchIndex(/оставши|остат(?:ок|ка|ную)|втор(?:ая|ую)\s+част|окончательн(?:ая|ую)\s+(?:оплат|сумм)/gi, slice);
  if (remainAt > prepayAt) return "remainder";
  if (prepayAt > remainAt) return "prepayment";
  if (/итого|общая\s+стоимость|цена\s+договора|сумма\s+договора|стоимость\s+(?:договора|оказания|услуг|работ|товара)/i.test(slice)) {
    return "total";
  }
  if (/50\s*%|50\s*процент/i.test(slice) && /оплат|составляет|в размере/i.test(slice)) {
    return /оста|втор/i.test(slice) ? "remainder" : "prepayment";
  }
  if (/составляет/i.test(slice) && /(?:стоимость|сумма|цена|договор)/i.test(slice)) return "total";
  return "skip";
}

function moneyPlaceholder(role: "prepayment" | "remainder" | "total", currency: string) {
  if (role === "prepayment") return `{{prepayment_amount}} ({{prepayment_amount_words}}) ${currency}`;
  if (role === "remainder") return `{{remainder_amount}} ({{remainder_amount_words}}) ${currency}`;
  return `{{amount}} ({{amount_words}}) ${currency}`;
}

export function markPaymentAmountPlaceholders(text: string) {
  return text
    .replace(
      /(предоплат[\s\S]{0,180}?(?:которая\s+составляет|составляет|в\s+размере)\s+)(?:\{\{\s*amount\s*\}\}(?:\s*\(\{\{\s*amount_words\s*\}\}\))?|(?:\d{1,3}(?:\s\d{3})+|\d{4,7})(?:\s*\([^)]{3,90}\))?)(\s*(?:тенге|₸))/gi,
      "$1{{prepayment_amount}} ({{prepayment_amount_words}})$2",
    )
    .replace(
      /(аванс[\s\S]{0,240}?(?:который\s+составляет|составляет|в\s+размере)\s+)(?:\{\{\s*amount\s*\}\}(?:\s*\(\{\{\s*amount_words\s*\}\}\))?|(?:\d{1,3}(?:\s\d{3})+|\d{4,7})(?:\s*\([^)]{3,90}\))?)(\s*(?:тенге|₸))/gi,
      "$1{{prepayment_amount}} ({{prepayment_amount_words}})$2",
    )
    .replace(
      /(оставши[\s\S]{0,180}?(?:которая\s+составляет|составляет|в\s+размере)\s+)(?:\{\{\s*amount\s*\}\}(?:\s*\(\{\{\s*amount_words\s*\}\}\))?|(?:\d{1,3}(?:\s\d{3})+|\d{4,7})(?:\s*\([^)]{3,90}\))?)(\s*(?:тенге|₸))/gi,
      "$1{{remainder_amount}} ({{remainder_amount_words}})$2",
    );
}

function replaceMoneyByContext(text: string) {
  const re = /(?:\d{1,3}(?:\s\d{3}){1,3}|\d{4,7})(?:\s*\([^)]{3,90}\))?\s*(тенге|₸)/gi;
  let next = text.replace(re, (match, currency: string, offset: number) => {
    const role = amountRole(text.slice(Math.max(0, offset - 160), offset));
    if (role === "skip") return match;
    return moneyPlaceholder(role, currency);
  });
  next = markPaymentAmountPlaceholders(next);
  next = next.replace(/Итого:\s*(?:\d{1,3}(?:\s\d{3}){1,3}|\d{4,7})/gi, "Итого: {{amount}}");
  return next;
}

function replaceContractNumbers(text: string) {
  let next = text.replace(
    new RegExp(`(договору?(?:\\s+(?:(?!приложени)[^\\n№]){0,80})?)\\s*(?:№|N|No\\.?)\\s*${CONTRACT_NO}`, "gi"),
    (_, title: string) => `${String(title).trimEnd()} № {{contract_number}}`,
  );
  next = next.replace(new RegExp(`(^|\\n)\\s*№\\s*${CONTRACT_NO}`, "g"), "$1№ {{contract_number}}");
  return next;
}

function replaceSigningDates(text: string) {
  const ru = ruDatePattern("gi");
  const dotted = /\b\d{1,2}\.\d{1,2}\.20\d{2}\b/g;
  const cut = Math.min(text.length, 1000);
  const head = text.slice(0, cut).replace(ru, "{{contract_date}}").replace(dotted, "{{contract_date}}");
  const tail = text.slice(cut)
    .replace(new RegExp(`(от\\s+)(?:${ruDatePattern("").source}|\\d{1,2}\\.\\d{1,2}\\.20\\d{2})`, "gi"), "$1{{contract_date}}")
    .replace(
      new RegExp(`(\\{\\{\\s*contract_number\\s*\\}\\}\\s+)(?:${ruDatePattern("").source}|\\d{1,2}\\.\\d{1,2}\\.20\\d{2})`, "gi"),
      "$1{{contract_date}}",
    );
  return head + tail;
}

function replaceCompletionTerms(text: string) {
  return text
    .replace(/\d+\s*[-–—]\s*\d+\s*рабоч(?:их)?\s*дн[ея](?:й)?/gi, "{{completion_terms}}")
    .replace(
      /(срок(?:и)?\s*(?:выполнения|оказания(?:\s+услуг)?|исполнения|поставки)\s*[:—–-]?\s*)(\d+[^\n.]{0,48}(?:рабоч|календарн|дн)[^\n.]{0,24})/gi,
      "$1{{completion_terms}}",
    );
}

function headingContractNumber(text: string) {
  const head = text.slice(0, 500);
  return (
    head.match(new RegExp(`договору?[^\\n№]{0,80}(?:№|N|No\\.?)\\s*(${CONTRACT_NO})`, "i"))?.[1] ||
    head.match(new RegExp(`^\\s*(?:№|N)\\s*(${CONTRACT_NO})`, "m"))?.[1] ||
    ""
  );
}

function headingContractDate(text: string) {
  const head = text.slice(0, 1000);
  return head.match(ruDatePattern("i"))?.[0] || head.match(/\b\d{1,2}\.\d{1,2}\.20\d{2}\b/)?.[0] || "";
}

function sampleAmount(text: string, role: "prepayment" | "remainder" | "total") {
  const re = /(?:\d{1,3}(?:\s\d{3}){1,3}|\d{4,7})(?:\s*\([^)]{3,90}\))?\s*(?:тенге|₸)/gi;
  for (const match of text.matchAll(re)) {
    if (match.index == null) continue;
    if (amountRole(text.slice(Math.max(0, match.index - 160), match.index)) === role) return clean(match[0]);
  }
  if (role === "total") {
    const total = text.match(/Итого:\s*((?:\d{1,3}(?:\s\d{3}){1,3}|\d{4,7}))/i);
    if (total) return clean(total[1]);
  }
  return "";
}

function sampleCompletion(text: string) {
  return (
    text.match(/\d+\s*[-–—]\s*\d+\s*рабоч(?:их)?\s*дн[ея](?:й)?/i)?.[0] ||
    text.match(/срок(?:и)?\s*(?:выполнения|оказания(?:\s+услуг)?|исполнения|поставки)\s*[:—–-]?\s*(\d+[^\n.]{0,48}(?:рабоч|календарн|дн)[^\n.]{0,24})/i)?.[1] ||
    ""
  );
}

export function describeTemplateFields(
  placeholders: string[],
  samples: Record<string, string> = {},
): RecognizedTemplateField[] {
  return TEMPLATE_FIELD_CATALOG.map((field) => {
    const keys = field.anyOf || [field.key];
    const found = keys.some((key) => placeholders.includes(key));
    return { key: field.key, label: field.label, found, sample: found ? samples[field.key] || "" : "" };
  });
}

export function fillContextualLeftovers(text: string, values: Record<string, string>) {
  let next = text;
  if (values.contract_number) {
    next = next.replace(
      new RegExp(`(договору?(?:\\s+(?:(?!приложени)[^\\n№]){0,80})?)\\s*(?:№|N|No\\.?)\\s*${CONTRACT_NO}`, "gi"),
      (_, title: string) => `${String(title).trimEnd()} № ${values.contract_number}`,
    );
    next = next.replace(/№\s*\d{6,}\/\d{1,4}/g, `№ ${values.contract_number}`);
  }
  if (values.contract_date) {
    next = next.replace(ruDatePattern("gi"), values.contract_date);
    const cut = Math.min(next.length, 1000);
    next = `${next.slice(0, cut).replace(/\b\d{1,2}\.\d{1,2}\.20\d{2}\b/g, values.contract_date)}${next.slice(cut)}`;
    next = next.replace(/\bот\s+\d{1,2}\.\d{1,2}\.20\d{2}\b/gi, `от ${values.contract_date}`);
  }
  if (values.prepayment_amount && values.prepayment_amount_words) {
    next = next.replace(
      /(предоплат[\s\S]{0,180}?(?:которая\s+составляет|составляет|в\s+размере)\s+)(?:\d{1,3}(?:\s\d{3})+|\d{4,7})(?:\s*\([^)]{3,90}\))?\s*(тенге|₸)/gi,
      `$1${values.prepayment_amount} (${values.prepayment_amount_words}) $2`,
    );
    next = next.replace(
      /(аванс[\s\S]{0,240}?(?:который\s+составляет|составляет|в\s+размере)\s+)(?:\d{1,3}(?:\s\d{3})+|\d{4,7})(?:\s*\([^)]{3,90}\))?\s*(тенге|₸)/gi,
      `$1${values.prepayment_amount} (${values.prepayment_amount_words}) $2`,
    );
  }
  if (values.remainder_amount && values.remainder_amount_words) {
    next = next.replace(
      /(оставши[\s\S]{0,180}?(?:которая\s+составляет|составляет|в\s+размере)\s+)(?:\d{1,3}(?:\s\d{3})+|\d{4,7})(?:\s*\([^)]{3,90}\))?\s*(тенге|₸)/gi,
      `$1${values.remainder_amount} (${values.remainder_amount_words}) $2`,
    );
  }
  if (values.completion_terms) {
    next = next.replace(/\d+\s*[-–—]\s*\d+\s*рабоч(?:их)?\s*дн[ея](?:й)?/gi, values.completion_terms);
    next = next.replace(
      /(срок(?:и)?\s*(?:выполнения|оказания(?:\s+услуг)?|исполнения|поставки)\s*[:—–-]?\s*)(\d+[^\n.]{0,48}(?:рабоч|календарн|дн)[^\n.]{0,24})/gi,
      `$1${values.completion_terms}`,
    );
  }
  return next;
}

function inferTemplateName(text: string, fileName?: string) {
  const fromFile = pathStem(fileName);
  if (fromFile) return fromFile;
  if (/презентац/i.test(text)) return "Договор на разработку презентации";
  if (/возмездн/i.test(text) && /услуг/i.test(text)) return "Договор на возмездные услуги";
  const heading = text.match(/договор[^\n]{0,80}/i)?.[0];
  if (heading && heading.length > 8 && heading.length < 80) return clean(heading.replace(/№.*/, ""));
  return "Шаблон договора";
}

function pathStem(fileName?: string) {
  if (!fileName) return "";
  return clean(fileName.replace(/\.[^.]+$/, "")).slice(0, 200);
}

function insertItemsTable(body: string) {
  if (/\{\{\s*items_table\s*\}\}/i.test(body)) return body;
  const at = body.search(/\n\s*(?:\d+\.\s*)?РЕКВИЗИТЫ\s+СТОРОН/i);
  if (at > 0) return `${body.slice(0, at).trimEnd()}\n\n{{items_table}}\n${body.slice(at)}`;
  return `${body.trim()}\n\n{{items_table}}\n`;
}

function placeholdersIn(body: string) {
  return [...new Set([...body.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((match) => match[1]))];
}

export function rewriteScannedFragment(text: string, scanned: Pick<ScannedContractTemplate, "seller" | "buyer">) {
  let next = text;
  const pairs: Array<[string, string]> = [
    [scanned.seller.name, "{{seller_name}}"],
    [scanned.seller.legalAddress, "{{seller_address}}"],
    [scanned.seller.directorName, "{{seller_director}}"],
    [scanned.seller.bankName, "{{seller_bank}}"],
    [scanned.buyer.name, "{{buyer_name}}"],
    [scanned.buyer.legalAddress, "{{buyer_address}}"],
    [scanned.buyer.directorName, "{{buyer_director}}"],
    [scanned.buyer.bankName, "{{buyer_bank}}"],
  ];
  pairs.sort((a, b) => b[0].length - a[0].length);
  for (const [value, placeholder] of pairs) {
    next = replaceFlexible(next, value, placeholder);
  }
  next = replaceBin(next, scanned.seller.bin, "{{seller_bin}}");
  next = replaceBin(next, scanned.buyer.bin, "{{buyer_bin}}");
  next = replaceIban(next, scanned.seller.iban, "{{seller_iban}}");
  next = replaceIban(next, scanned.buyer.iban, "{{buyer_iban}}");
  if (scanned.seller.bik) next = next.replace(new RegExp(escapeRegExp(scanned.seller.bik), "gi"), "{{seller_bik}}");
  if (scanned.buyer.bik) next = next.replace(new RegExp(escapeRegExp(scanned.buyer.bik), "gi"), "{{buyer_bik}}");
  next = replaceContractNumbers(next);
  next = replaceSigningDates(next);
  next = replaceMoneyByContext(next);
  next = replaceCompletionTerms(next);
  if (!/\{\{\s*buyer_address\s*\}\}/i.test(next)) {
    next = next.replace(
      /(\{\{\s*buyer_name\s*\}\}[ \t]*\n)(?!\{\{\s*buyer_address)([\s\S]{8,280}?)(\n[ \t]*БИН[ \t]*\{\{\s*buyer_bin\s*\}\})/i,
      "$1{{buyer_address}}$3",
    );
  }
  if (!/\{\{\s*seller_address\s*\}\}/i.test(next)) {
    next = next.replace(
      /(\{\{\s*seller_name\s*\}\}[ \t]*\n)(?!\{\{\s*seller_address)([\s\S]{8,280}?)(\n[ \t]*БИН[ \t]*\{\{\s*seller_bin\s*\}\})/i,
      "$1{{seller_address}}$3",
    );
  }
  return next;
}

export function scanContractTemplateText(
  raw: string,
  profile: TemplateSellerProfile = {},
  fileName?: string,
): ScannedContractTemplate {
  const warnings: string[] = [];
  let text = String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/HYPERLINK\s+"[^"]*"/gi, "")
    .trim();
  if (text.length < 80) {
    throw new Error("template_text_short");
  }

  const roles = preambleRoles(text);
  let seller = fillParty(text, roles.sellerName, roles.sellerDirector, "seller");
  let buyer = fillParty(text, roles.buyerName, roles.buyerDirector, "buyer");

  const tenantBin = taxDigits(profile.bin || profile.iin);
  const tenantOwnsBuyer = tenantBin && buyer.bin === tenantBin && seller.bin !== tenantBin;
  const tenantOwnsSeller = tenantBin && seller.bin === tenantBin;
  if (tenantOwnsBuyer && !tenantOwnsSeller && !legalNameMatch(profile, seller.name)) {
    const swapped = seller;
    seller = buyer;
    buyer = swapped;
  }
  if (tenantBin && seller.bin && seller.bin !== tenantBin && buyer.bin !== tenantBin) {
    warnings.push("БИН вашей организации в файле не найден — стороны размечены по «Исполнитель» и «Заказчик».");
  }
  if (!seller.name && legalNameMatch(profile, roles.sellerName)) seller.name = roles.sellerName;
  if (!seller.name && profile.legalName) {
    const fromProfile = orgName(text) && legalNameMatch(profile, orgName(text)) ? orgName(text) : "";
    if (fromProfile) seller.name = fromProfile;
  }
  if (!seller.name) {
    warnings.push("Исполнитель в преамбуле не размечен как поле. Название вашей организации подставится при формировании, если оно есть в настройках.");
  }
  if (!buyer.name) {
    warnings.push("Заказчик в преамбуле не размечен как поле. При формировании останется название из файла — лучше сохранить шаблон после проверки сторон.");
  }

  if (profile.phone && text.includes(profile.phone)) {
    text = replaceFlexible(text, profile.phone, "{{seller_phone}}");
  }
  if (profile.email && new RegExp(escapeRegExp(profile.email), "i").test(text)) {
    text = replaceFlexible(text, profile.email, "{{seller_email}}");
  }
  const samples: Record<string, string> = {
    contract_number: headingContractNumber(text),
    contract_date: headingContractDate(text),
    seller_name: seller.name,
    seller_bin: seller.bin,
    seller_director: seller.directorName,
    seller_address: seller.legalAddress,
    seller_iban: seller.iban,
    buyer_name: buyer.name,
    buyer_bin: buyer.bin,
    buyer_director: buyer.directorName,
    buyer_address: buyer.legalAddress,
    amount: sampleAmount(text, "total") || (moneyAmounts(text).sort((a, b) => b - a)[0] ? String(moneyAmounts(text).sort((a, b) => b - a)[0]) : ""),
    prepayment_amount: sampleAmount(text, "prepayment"),
    remainder_amount: sampleAmount(text, "remainder"),
    completion_terms: sampleCompletion(text),
    items_table: /приложение|позиц|наименование|состав\s+(?:работ|услуг)|предмет/i.test(text) ? "из сделки" : "",
  };

  text = rewriteScannedFragment(text, { seller, buyer });
  text = insertItemsTable(text).replace(/\n{3,}/g, "\n\n").trim();

  const placeholders = placeholdersIn(text);
  if (!placeholders.includes("seller_name") || !placeholders.includes("buyer_name")) {
    warnings.push("Не все названия сторон заменены на поля. Договор можно сохранить — при формировании подставятся данные из карточек, только если поле есть в тексте.");
  }
  if (!placeholders.includes("contract_number")) {
    warnings.push("Номер в шаблоне не размечен. При формировании возьмём номер из CRM, если в тексте есть «Договор №».");
  }

  return {
    name: inferTemplateName(raw, fileName),
    body: text,
    placeholders,
    fields: describeTemplateFields(placeholders, samples),
    seller,
    buyer,
    warnings,
  };
}
