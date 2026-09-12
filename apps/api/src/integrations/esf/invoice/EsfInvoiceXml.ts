import type { EsfInvoiceSourceSnapshot } from "../../../services/esfInvoiceMapper.ts";
import { boolEl, el, formatEsfDate, formatEsfDecimal, formatEsfInt, mustEl, wrap } from "../xml.ts";

export const INVOICE_V2_NS = "v2.esf";
export const ABSTRACT_INVOICE_NS = "abstractInvoice.esf";
export const INVOICE_CONTAINER_NS = "esf";
export const INVOICE_VERSION = "InvoiceV2";

function tinOf(party: { bin?: string; iin?: string }) {
  return String(party.bin || party.iin || "").trim();
}

export function wrapInvoiceContainer(invoiceXml: string) {
  return [
    `<esf:invoiceContainer xmlns:esf="${INVOICE_CONTAINER_NS}">`,
    `<invoiceSet>`,
    invoiceXml,
    `</invoiceSet>`,
    `</esf:invoiceContainer>`,
  ].join("");
}

export function buildInvoiceV2Xml(source: EsfInvoiceSourceSnapshot) {
  const date = formatEsfDate(source.documentDate);
  const hasContract = Boolean(source.contract?.number);
  const customers = wrap(
    "customers",
    wrap(
      "customer",
      `${el("address", source.buyer.legalAddress)}${mustEl("countryCode", source.buyer.countryCode || "KZ")}${mustEl(
        "name",
        source.buyer.legalName || source.buyer.name,
      )}${el("tin", tinOf(source.buyer))}`,
    ),
  );

  const products = source.items
    .map((item) => {
      const vatRate = Math.round(Number(item.vatRate) || 0);
      return wrap(
        "product",
        `${mustEl("catalogTruId", item.catalogTruId)}${el("description", item.name)}${mustEl(
          "ndsAmount",
          formatEsfDecimal(item.vatAmount),
        )}${vatRate > 0 ? mustEl("ndsRate", formatEsfInt(vatRate)) : ""}${mustEl(
          "priceWithTax",
          formatEsfDecimal(item.totalAmount),
        )}${mustEl("priceWithoutTax", formatEsfDecimal(item.amountWithoutVat))}${el(
          "quantity",
          formatEsfDecimal(item.quantity, 3),
        )}${mustEl("truOriginCode", item.truOriginCode)}${mustEl(
          "turnoverSize",
          formatEsfDecimal(item.amountWithoutVat),
        )}${el("unitNomenclature", item.unit)}${el("unitPrice", formatEsfDecimal(item.unitPrice, 6))}`,
      );
    })
    .join("");

  const productSet = wrap(
    "productSet",
    `${mustEl("currencyCode", source.totals.currency || "KZT")}${wrap("products", products)}${mustEl(
      "totalExciseAmount",
      "0.00",
    )}${mustEl("totalNdsAmount", formatEsfDecimal(source.totals.vatAmount))}${mustEl(
      "totalPriceWithTax",
      formatEsfDecimal(source.totals.totalAmount),
    )}${mustEl("totalPriceWithoutTax", formatEsfDecimal(source.totals.amountWithoutVat))}${mustEl(
      "totalTurnoverSize",
      formatEsfDecimal(source.totals.amountWithoutVat),
    )}`,
  );

  const deliveryTerm = wrap(
    "deliveryTerm",
    `${el("contractDate", hasContract ? formatEsfDate(source.contract?.date) : "")}${el(
      "contractNum",
      hasContract ? source.contract?.number : "",
    )}${boolEl("hasContract", hasContract)}`,
  );

  const sellers = wrap(
    "sellers",
    wrap(
      "seller",
      `${el("address", source.seller.legalAddress)}${el("bank", source.seller.bank)}${el(
        "bik",
        source.seller.bik,
      )}${el("certificateNum", source.seller.certificateNum)}${el("countryCode", source.seller.countryCode)}${el(
        "iik",
        source.seller.iik,
      )}${mustEl("name", source.seller.legalName)}${el("tin", tinOf(source.seller))}`,
    ),
  );

  return [
    `<v2:invoice xmlns:a="${ABSTRACT_INVOICE_NS}" xmlns:v2="${INVOICE_V2_NS}">`,
    mustEl("date", date),
    mustEl("invoiceType", source.invoiceType),
    mustEl("num", source.outgoingNum),
    mustEl("operatorFullname", source.operatorFullname),
    mustEl("turnoverDate", date),
    customers,
    deliveryTerm,
    productSet,
    sellers,
    `</v2:invoice>`,
  ].join("");
}
