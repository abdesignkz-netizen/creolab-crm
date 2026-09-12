import type { AvrSourceSnapshot } from "../../../services/avrMapper.ts";
import { el, formatEsfDate, formatEsfDecimal, formatEsfInt, mustEl, wrap } from "../xml.ts";

export const AWP_NS = "v1.awp";
export const ABSTRACT_AWP_NS = "abstractAwp.awp";
export const AWP_VERSION = "AwpV1";

export type AwpBankExtras = {
  bank?: string | null;
  bik?: string | null;
  iik?: string | null;
};

export type AwpBuildExtras = {
  number?: string | null;
  sellerBank?: AwpBankExtras | null;
  buyerBank?: AwpBankExtras | null;
};

function tinOf(party: { bin?: string; iin?: string }) {
  return String(party.bin || party.iin || "").trim();
}

function boolStr(value: boolean) {
  return value ? "true" : "false";
}

function bankXml(bank?: AwpBankExtras | null) {
  if (!bank) return "";
  const inner = `${el("bank", bank.bank || "")}${el("bik", bank.bik || "")}${el("iik", bank.iik || "")}`;
  return inner ? wrap("bankDetails", inner) : "";
}

function registrationType(party: { bin?: string; iin?: string }) {
  if (party.bin) return "ENTERPRISE";
  return "";
}

export function buildAwpV1Xml(source: AvrSourceSnapshot, extras: AwpBuildExtras = {}) {
  const date = formatEsfDate(source.documentDate);
  const performedDate = formatEsfDate(source.documentDate);
  const number = String(extras.number || "").trim();
  const hasContract = Boolean(source.contract?.number);
  const contractInner = `${el("date", hasContract ? formatEsfDate(source.contract?.date) : "")}${mustEl(
    "isContract",
    boolStr(hasContract),
  )}${el("number", hasContract ? source.contract?.number : "")}`;

  const recipientType = registrationType(source.buyer);
  const recipient = wrap(
    "recipient",
    `${el("address", source.buyer.legalAddress)}${el("tin", tinOf(source.buyer))}${bankXml(extras.buyerBank)}${mustEl(
      "name",
      source.buyer.legalName || source.buyer.name,
    )}${mustEl("nonResident", "false")}${el("registrationType", recipientType)}`,
  );

  const sender = wrap(
    "sender",
    `${el("address", source.seller.legalAddress)}${el("tin", tinOf(source.seller))}${bankXml(extras.sellerBank)}${mustEl(
      "name",
      source.seller.legalName,
    )}`,
  );

  const works = source.items
    .map((item) => {
      const vatRate = Math.round(Number(item.vatRate) || 0);
      return wrap(
        "work",
        `${el("additionalInfo", item.description || "")}${el("measureUnitCode", item.unit || "")}${mustEl(
          "name",
          item.name,
        )}${el("ndsAmount", formatEsfDecimal(item.vatAmount))}${mustEl("ndsRate", formatEsfInt(vatRate))}${el(
          "quantity",
          formatEsfDecimal(item.quantity, 3),
        )}${mustEl("sumWithTax", formatEsfDecimal(item.totalAmount))}${mustEl(
          "sumWithoutTax",
          formatEsfDecimal(item.amountWithoutVat),
        )}${mustEl("turnoverSize", formatEsfDecimal(item.amountWithoutVat))}${mustEl(
          "unitPriceWithoutTax",
          formatEsfDecimal(item.unitPrice),
        )}`,
      );
    })
    .join("");

  const worksPerformed = wrap(
    "worksPerformed",
    `${mustEl("currencyCode", source.totals.currency || "KZT")}${mustEl(
      "totalNdsAmount",
      formatEsfDecimal(source.totals.vatAmount),
    )}${mustEl("totalSumWithTax", formatEsfDecimal(source.totals.totalAmount))}${mustEl(
      "totalSumWithoutTax",
      formatEsfDecimal(source.totals.amountWithoutVat),
    )}${mustEl("totalTurnoverSize", formatEsfDecimal(source.totals.amountWithoutVat))}${wrap("works", works)}`,
  );

  return [
    `<v1:awp xmlns:v1="${AWP_NS}" xmlns:aawp="${ABSTRACT_AWP_NS}">`,
    mustEl("date", date),
    mustEl("number", number),
    mustEl("performedDate", performedDate),
    wrap("contract", contractInner),
    wrap("recipients", recipient),
    wrap("senders", sender),
    worksPerformed,
    `</v1:awp>`,
  ].join("");
}
