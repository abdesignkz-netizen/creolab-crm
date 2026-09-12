import { asMoney, sumLines } from "./documentMoney.ts";
import type { serializeDealItem } from "./dealItemService.ts";

type DealItem = ReturnType<typeof serializeDealItem>;

export const AVR_SOURCE_KIND = "avr_internal_v1";

export type AvrSourceSnapshot = {
  kind: typeof AVR_SOURCE_KIND;
  seller: {
    legalName: string;
    bin: string;
    iin: string;
    legalAddress: string;
    directorName: string;
    directorPosition: string;
  };
  buyer: {
    name: string;
    legalName: string;
    bin: string;
    iin: string;
    legalAddress: string;
    directorName: string;
    directorPosition: string;
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
  }>;
  totals: {
    amountWithoutVat: number;
    vatAmount: number;
    totalAmount: number;
    currency: string;
  };
  documentDate: string;
};

export function mapAvrSource(input: {
  documentDate: Date;
  currency: string;
  deal: { id: string; title: string };
  items: DealItem[];
  profile: {
    legalName: string | null;
    shortName?: string | null;
    bin: string | null;
    iin?: string | null;
    legalAddress: string | null;
    directorName: string | null;
    directorPosition: string | null;
  } | null;
  tenantName?: string | null;
  company: {
    name: string;
    legalName: string | null;
    bin: string | null;
    iin: string | null;
    legalAddress: string | null;
    address: string | null;
    directorName?: string | null;
    directorPosition?: string | null;
  } | null;
  contract: { id: string; number: string; date: Date; status: string } | null;
  invoice: { id: string; number: string; date: Date; status: string } | null;
}): AvrSourceSnapshot {
  const totals = input.items.length
    ? sumLines(input.items)
    : { amountWithoutVat: 0, vatAmount: 0, totalAmount: 0, vatRate: null };
  return {
    kind: AVR_SOURCE_KIND,
    seller: {
      legalName: input.profile?.legalName || input.profile?.shortName || input.tenantName || "",
      bin: input.profile?.bin || "",
      iin: input.profile?.iin || "",
      legalAddress: input.profile?.legalAddress || "",
      directorName: input.profile?.directorName || "",
      directorPosition: input.profile?.directorPosition || "Директор",
    },
    buyer: {
      name: input.company?.name || "",
      legalName: input.company?.legalName || input.company?.name || "",
      bin: input.company?.bin || "",
      iin: input.company?.iin || "",
      legalAddress: input.company?.legalAddress || input.company?.address || "",
      directorName: input.company?.directorName || "",
      directorPosition: input.company?.directorPosition || "",
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
      quantity: asMoney(item.quantity),
      unit: item.unit,
      unitPrice: asMoney(item.unitPrice),
      amountWithoutVat: asMoney(item.amountWithoutVat),
      vatRate: asMoney(item.vatRate),
      vatAmount: asMoney(item.vatAmount),
      totalAmount: asMoney(item.totalAmount),
      sortOrder: item.sortOrder,
    })),
    totals: {
      amountWithoutVat: totals.amountWithoutVat,
      vatAmount: totals.vatAmount,
      totalAmount: totals.totalAmount,
      currency: input.currency || "KZT",
    },
    documentDate: input.documentDate.toISOString(),
  };
}
