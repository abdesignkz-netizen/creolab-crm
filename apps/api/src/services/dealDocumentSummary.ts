import type { PrismaClient } from "@creolab/db";
import { documentStatusLabel, type DocumentKind } from "./documentInboxService.ts";

type DocumentSummary = {
  id: string; number: string; status: string; statusLabel: string; count: number;
  delivery: "sent" | "not_sent" | "sending" | "unknown";
  deliveryLabel: string; href: string;
};
export type DealDocumentSummary = Record<DocumentKind, DocumentSummary | null>;
const empty = (): DealDocumentSummary => ({ CONTRACT: null, INVOICE: null, AVR: null, ESF: null });

/** Summarize the newest document of each kind, never the most successful older one. */
export async function loadDealDocumentSummaries(prisma: PrismaClient, tenantId: string, dealIds: string[]) {
  const result = new Map(dealIds.map((id) => [id, empty()]));
  if (!dealIds.length) return result;
  const where = { tenantId, dealId: { in: dealIds } };
  const orderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];
  const [contracts, invoices, electronic] = await Promise.all([
    prisma.contract.findMany({ where, orderBy, select: {
      id: true, dealId: true, number: true, status: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { id: true } },
      signatureRequests: { where: { tenantId, signerType: "BUYER" }, select: { contractVersionId: true, openedAt: true, signedAt: true, status: true } },
    } }),
    prisma.invoice.findMany({ where, orderBy, select: { id: true, dealId: true, number: true, status: true } }),
    prisma.electronicDocument.findMany({ where: { ...where, type: { in: ["AVR", "ESF"] } }, orderBy,
      select: { id: true, dealId: true, number: true, type: true, status: true, sentAt: true, errorCode: true } }),
  ]);
  function add(dealId: string, kind: DocumentKind, row: Omit<DocumentSummary, "count">) {
    const group = result.get(dealId)!;
    if (group[kind]) group[kind]!.count += 1;
    else group[kind] = { ...row, count: 1 };
  }
  for (const row of contracts) {
    const buyer = row.signatureRequests.filter((request) => request.contractVersionId === (row.versions[0]?.id ?? null));
    const received = buyer.some((request) => request.openedAt || request.signedAt);
    add(row.dealId, "CONTRACT", {
      id: row.id, number: row.number, status: row.status, statusLabel: documentStatusLabel("CONTRACT", row.status),
      delivery: received ? "sent" : "unknown",
      deliveryLabel: received ? "Получен клиентом" : buyer.length ? "Отправка ссылки не подтверждена" : "Отправка не подтверждена",
      href: `/documents?kind=CONTRACT&contract=${row.id}`,
    });
  }
  for (const row of invoices) add(row.dealId, "INVOICE", {
    id: row.id, number: row.number, status: row.status, statusLabel: documentStatusLabel("INVOICE", row.status),
    delivery: "unknown", deliveryLabel: "Отправка не отслеживается",
    href: `/documents?kind=INVOICE&dealId=${row.dealId}`,
  });
  for (const row of electronic) {
    const kind = row.type as "AVR" | "ESF";
    const sent = Boolean(row.sentAt) || ["SENT", "ACCEPTED"].includes(row.status);
    add(row.dealId, kind, {
      id: row.id, number: row.number, status: row.errorCode ? "ERROR" : row.status,
      statusLabel: documentStatusLabel(kind, row.errorCode ? "ERROR" : row.status),
      delivery: row.status === "SENDING" ? "sending" : sent ? "sent" : "not_sent",
      deliveryLabel: row.status === "SENDING" ? "Отправляется в ИС ЭСФ" : sent ? "Отправлен в ИС ЭСФ" : "Не отправлен",
      href: `/documents?kind=${kind}&dealId=${row.dealId}`,
    });
  }
  return result;
}
