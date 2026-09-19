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

export type ScannedContractTemplate = {
  name: string;
  body: string;
  placeholders: string[];
  seller: TemplateParty;
  buyer: TemplateParty;
  warnings: string[];
};

const emptyParty = (): TemplateParty => ({
  name: "",
  bin: "",
  legalAddress: "",
  directorName: "",
  iban: "",
  bankName: "",
  bik: "",
});

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

function orgName(block: string) {
  const quoted = block.match(/(?:ТОО|TOO|ИП|АО|ЖШС)\s*[«"“][^»"”]{1,120}[»"”]/i);
  if (quoted) return clean(quoted[0]).replace(/^TOO/i, "ТОО");
  const plain = block.match(/(?:ТОО|TOO|ИП|АО|ЖШС)\s+[А-ЯЁA-Z][А-ЯЁA-Za-z0-9«»"\- ]{1,80}/);
  return plain ? clean(plain[0]).replace(/^TOO/i, "ТОО") : "";
}

function directorIn(block: string) {
  const labeled = block.match(/в\s+лице\s+(?:Директора|Генерального\s+директора|руководителя)\s+([^,]{3,80}),/i);
  if (labeled) return clean(labeled[1]);
  const initials = block.match(/([А-ЯЁ][а-яё]+\s+[А-ЯЁA-Z]\.\s*[А-ЯЁA-Z]\.)/);
  return initials ? clean(initials[1]) : "";
}

function binIn(block: string) {
  const labeled = block.match(/БИН(?:\s*\/\s*ИИН)?\s*:?\s*([\d\s]{12,20})/i);
  const digits = taxDigits(labeled?.[1] || "");
  return digits.length === 12 ? digits : "";
}

function ibanIn(block: string) {
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

function partyByRole(text: string, role: "Исполнитель" | "Заказчик") {
  const matched = text.match(
    new RegExp(
      `((?:ТОО|TOO|ИП|АО|ЖШС)\\s*[«"“][^»"”]{1,120}[»"”]|(?:ТОО|TOO|ИП|АО|ЖШС)\\s+[А-ЯЁA-Z][А-ЯЁA-Za-z0-9\\- ]{1,80}),\\s*именуем[аоы]е?\\s+в\\s+дальнейшем\\s+[«"]${role}[»"]`,
      "i",
    ),
  );
  const name = matched ? orgName(matched[1]) || clean(matched[1]) : "";
  const after =
    matched && matched.index != null
      ? text.slice(matched.index + matched[0].length, matched.index + matched[0].length + 220)
      : "";
  return { name, director: directorIn(after) || (matched ? directorIn(matched[0]) : "") };
}

function preambleRoles(text: string) {
  const executor = partyByRole(text, "Исполнитель");
  const customer = partyByRole(text, "Заказчик");
  return {
    sellerName: executor.name,
    sellerDirector: executor.director,
    buyerName: customer.name,
    buyerDirector: customer.director,
  };
}

function fillParty(text: string, name: string, director: string): TemplateParty {
  const requisites = text.split(/РЕКВИЗИТЫ\s+СТОРОН/i)[1] || text;
  const block = windowAfter(requisites, name) || windowAfter(text, name);
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
  if (value.length < 3) return text;
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
  const found = [...text.matchAll(/\b(\d{1,3}(?:\s\d{3}){1,3}|\d{4,7})(?:\s*\([^)]{3,80}\))?\s*(?:тенге|₸)/gi)];
  return [...new Set(found.map((match) => Number(String(match[1]).replace(/\s/g, ""))).filter((n) => n >= 1000))];
}

function groupedAmountPattern(amount: number) {
  const digits = String(Math.round(amount));
  const parts: string[] = [];
  let rest = digits;
  while (rest.length > 3) {
    parts.unshift(rest.slice(-3));
    rest = rest.slice(0, -3);
  }
  parts.unshift(rest);
  return parts.join("\\s");
}

function replaceTotalAmount(text: string) {
  const amounts = moneyAmounts(text).sort((a, b) => b - a);
  const total = amounts[0];
  if (!total) return text;
  const grouped = groupedAmountPattern(total);
  text = text.replace(
    new RegExp(`(?:${grouped}|${total})\\s*\\(([^)]{3,80})\\)\\s*(тенге|₸)`, "gi"),
    "{{amount}} ({{amount_words}}) $2",
  );
  text = text.replace(new RegExp(`Итого:\\s*(?:${grouped}|${total})`, "gi"), "Итого: {{amount}}");
  text = text.replace(new RegExp(grouped, "g"), "{{amount}}");
  text = text.replace(new RegExp(`\\b${total}\\b`, "g"), "{{amount}}");
  return text;
}

function inferTemplateName(text: string, fileName?: string) {
  const fromFile = pathStem(fileName);
  if (/презентац/i.test(text)) return "Договор на разработку презентации";
  if (/возмездн/i.test(text) && /услуг/i.test(text)) return fromFile || "Договор на возмездные услуги";
  const heading = text.match(/договор[^\n]{0,80}/i)?.[0];
  if (heading && heading.length > 8 && heading.length < 80) return clean(heading.replace(/№.*/, ""));
  return fromFile || "Шаблон договора";
}

function pathStem(fileName?: string) {
  if (!fileName) return "";
  return clean(fileName.replace(/\.[^.]+$/, "")).slice(0, 200);
}

function insertItemsTable(body: string) {
  if (/\{\{\s*items_table\s*\}\}/i.test(body)) return body;
  if (/РЕКВИЗИТЫ\s+СТОРОН|Приложение\s*№/i.test(body)) return body;
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
  next = next.replace(/Договор\s*№\s*[\w./-]+/i, "Договор № {{contract_number}}");
  next = next.replace(/№\s*[\d]{6,}\/[\d]{1,4}/g, "№ {{contract_number}}");
  next = next.replace(/[«"“]\d{1,2}[»"”]\s+[а-яё]+\s+20\d{2}(?:\s*г(?:ода)?\.?)?/gi, "{{contract_date}}");
  next = replaceTotalAmount(next);
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
  let seller = fillParty(text, roles.sellerName, roles.sellerDirector);
  let buyer = fillParty(text, roles.buyerName, roles.buyerDirector);

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
  if (!seller.name) warnings.push("Не удалось однозначно найти исполнителя. Проверьте текст шаблона.");
  if (!buyer.name) warnings.push("Не удалось однозначно найти заказчика. Проверьте текст шаблона.");

  if (profile.phone && text.includes(profile.phone)) {
    text = replaceFlexible(text, profile.phone, "{{seller_phone}}");
  }
  if (profile.email && new RegExp(escapeRegExp(profile.email), "i").test(text)) {
    text = replaceFlexible(text, profile.email, "{{seller_email}}");
  }
  text = rewriteScannedFragment(text, { seller, buyer });
  text = insertItemsTable(text).replace(/\n{3,}/g, "\n\n").trim();

  const placeholders = placeholdersIn(text);
  if (!placeholders.includes("seller_name") || !placeholders.includes("buyer_name")) {
    warnings.push("Не все реквизиты сторон заменены на поля шаблона. Можно поправить текст вручную перед сохранением.");
  }

  return {
    name: inferTemplateName(raw, fileName),
    body: text,
    placeholders,
    seller,
    buyer,
    warnings,
  };
}
