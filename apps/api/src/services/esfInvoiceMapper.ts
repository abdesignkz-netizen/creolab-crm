import { asMoney, sumLines } from "./documentMoney.ts";
import type { serializeDealItem } from "./dealItemService.ts";

type DealItem = ReturnType<typeof serializeDealItem> & { catalogTruId?: string | null };

export const ESF_INVOICE_SOURCE_KIND = "esf_invoice_v2";
export const ESF_TRU_ORIGIN_SERVICE = "6";

export type EsfInvoiceSourceSnapshot = {
  kind: typeof ESF_INVOICE_SOURCE_KIND;
  invoiceType: "ORDINARY_INVOICE";
  outgoingNum: string;
  operatorFullname: string;
  seller: {
    legalName: string;
    bin: string;
    iin: string;
    legalAddress: string;
    directorName: string;
    countryCode: string;
    bank: string;
    bik: string;
    iik: string;
    certificateNum: string;
  };
  buyer: {
    name: string;
    legalName: string;
    bin: string;
    iin: string;
    legalAddress: string;
    countryCode: string;
  };
  deal: { id: string; title: string };
  contract: { id: string; number: string; date: string; status: string } | null;
  invoice: { id: string; number: string; date: string; status: string } | null;
  items: Array<{
    dealItemId: string;
    name: string;
    description: string | null;
    quantity: number;
    unit: string;
    unitPrice: number;
    amountWithoutVat: number;
    vatRate: number;
    vatAmount: number;
    totalAmount: number;
    sortOrder: number;
    catalogTruId: string;
    truOriginCode: string;
  }>;
  totals: {
    amountWithoutVat: number;
    vatAmount: number;
    totalAmount: number;
    currency: string;
  };
  documentDate: string;
};

export function esfOutgoingNum(number: string | null | undefined) {
  return String(number || "").replace(/\D/g, "").slice(0, 30);
}

export function officialIik(value: string | null | undefined) {
  const raw = String(value || "").replace(/\s+/g, "").toUpperCase();
  return /^[0-9A-Z]{20}$/.test(raw) ? raw : "";
}

export function officialBik(value: string | null | undefined) {
  const raw = String(value || "").replace(/\s+/g, "").toUpperCase();
  return /^[0-9A-Z]{8}$/.test(raw) ? raw : "";
}

export function resolveCatalogTruId(
  item: { catalogTruId?: string | null },
  defaultCatalogTruId?: string | null,
) {
  return String(item.catalogTruId || defaultCatalogTruId || "").trim();
}

export function mapEsfInvoiceSource(input: {
  documentDate: Date;
  number: string;
  currency: string;
  deal: { id: string; title: string };
  items: DealItem[];
  defaultCatalogTruId?: string | null;
  profile: {
    legalName: string | null;
    shortName?: string | null;
    bin: string | null;
    iin?: string | null;
    legalAddress: string | null;
    directorName: string | null;
    country?: string | null;
    bankName?: string | null;
    bik?: string | null;
    iban?: string | null;
    vatRegistrationNumber?: string | null;
  } | null;
  tenantName?: string | null;
  company: {
    name: string;
    legalName: string | null;
    bin: string | null;
    iin: string | null;
    legalAddress: string | null;
    address: string | null;
  } | null;
  contract: { id: string; number: string; date: Date; status: string } | null;
  invoice: { id: string; number: string; date: Date; status: string } | null;
}): EsfInvoiceSourceSnapshot {
  const totals = input.items.length
    ? sumLines(input.items)
    : { amountWithoutVat: 0, vatAmount: 0, totalAmount: 0, vatRate: null };
  return {
    kind: ESF_INVOICE_SOURCE_KIND,
    invoiceType: "ORDINARY_INVOICE",
    outgoingNum: esfOutgoingNum(input.number),
    operatorFullname: input.profile?.directorName || "",
    seller: {
      legalName: input.profile?.legalName || input.profile?.shortName || input.tenantName || "",
      bin: input.profile?.bin || "",
      iin: input.profile?.iin || "",
      legalAddress: input.profile?.legalAddress || "",
      directorName: input.profile?.directorName || "",
      countryCode: input.profile?.country || "KZ",
      bank: input.profile?.bankName || "",
      bik: officialBik(input.profile?.bik),
      iik: officialIik(input.profile?.iban),
      certificateNum: input.profile?.vatRegistrationNumber || "",
    },
    buyer: {
      name: input.company?.name || "",
      legalName: input.company?.legalName || input.company?.name || "",
      bin: input.company?.bin || "",
      iin: input.company?.iin || "",
      legalAddress: input.company?.legalAddress || input.company?.address || "",
      countryCode: "KZ",
    },
    deal: { id: input.deal.id, title: input.deal.title },
    contract: input.contract
      ? {
          id: input.contract.id,
          number: input.contract.number,
          date: input.contract.date.toISOString(),
          status: input.contract.status,
        }
      : null,
    invoice: input.invoice
      ? {
          id: input.invoice.id,
          number: input.invoice.number,
          date: input.invoice.date.toISOString(),
          status: input.invoice.status,
        }
      : null,
    items: input.items.map((item) => ({
      dealItemId: item.id,
      name: item.name,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
      amountWithoutVat: item.amountWithoutVat,
      vatRate: item.vatRate,
      vatAmount: item.vatAmount,
      totalAmount: item.totalAmount,
      sortOrder: item.sortOrder,
      catalogTruId: resolveCatalogTruId(item, input.defaultCatalogTruId),
      truOriginCode: ESF_TRU_ORIGIN_SERVICE,
    })),
    totals: {
      amountWithoutVat: asMoney(totals.amountWithoutVat),
      vatAmount: asMoney(totals.vatAmount),
      totalAmount: asMoney(totals.totalAmount),
      currency: input.currency || "KZT",
    },
    documentDate: input.documentDate.toISOString(),
  };
}
