import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { asMoney, lineAmounts, sumLines, toMinorTenge } from "./documentMoney.ts";
import { getTenantDocumentFlags, resolveVatRate } from "./legalProfileService.ts";

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

export function serializeDealItem(item: {
  id: string;
  name: string;
  description: string | null;
  quantity: { toString(): string } | number;
  unit: string;
  unitPrice: { toString(): string } | number;
  amountWithoutVat: { toString(): string } | number;
  vatRate: { toString(): string } | number;
  vatAmount: { toString(): string } | number;
  totalAmount: { toString(): string } | number;
  sortOrder: number;
  catalogItemId: string | null;
  catalogTruId?: string | null;
}) {
  return {
    id: item.id,
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
    catalogItemId: item.catalogItemId,
    catalogTruId: item.catalogTruId ?? null,
  };
}

export function totalsFromItems(items: Array<ReturnType<typeof serializeDealItem>>) {
  return sumLines(items);
}

export async function syncDealOfferFromItems(prisma: PrismaClient, tenantId: string, dealId: string) {
  const items = await prisma.dealItem.findMany({
    where: { tenantId, dealId },
    orderBy: { sortOrder: "asc" },
  });
  if (!items.length) return [];
  const serialized = items.map(serializeDealItem);
  const totals = sumLines(serialized);
  await prisma.deal.update({
    where: { id: dealId },
    data: { offerAmountMinor: toMinorTenge(totals.totalAmount), version: { increment: 1 } },
  });
  return serialized;
}

export async function listDealItems(prisma: PrismaClient, auth: AuthContext, dealId: string) {
  const membership = requireTenant(auth);
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: membership.tenantId } });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const items = await prisma.dealItem.findMany({
    where: { tenantId: membership.tenantId, dealId },
    orderBy: { sortOrder: "asc" },
  });
  const serialized = items.map(serializeDealItem);
  return { items: serialized, totals: serialized.length ? sumLines(serialized) : null };
}

export async function addDealItem(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: {
    name: string;
    description?: string | null;
    quantity: number;
    unit?: string;
    unitPrice: number;
    vatRate?: number;
    sortOrder?: number;
    catalogItemId?: string | null;
    catalogTruId?: string | null;
  },
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: tid } });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const flags = await getTenantDocumentFlags(prisma, tid);
  const vatRate = resolveVatRate(flags, input.vatRate);
  const amounts = lineAmounts(input.quantity, input.unitPrice, vatRate);
  const last = await prisma.dealItem.findFirst({
    where: { tenantId: tid, dealId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  await prisma.dealItem.create({
    data: {
      tenantId: tid,
      dealId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      quantity: input.quantity,
      unit: input.unit?.trim() || "услуга",
      unitPrice: input.unitPrice,
      vatRate,
      ...amounts,
      sortOrder: input.sortOrder ?? (last ? last.sortOrder + 1 : 0),
      catalogItemId: input.catalogItemId || null,
      catalogTruId: input.catalogTruId?.trim() || null,
    },
  });
  const items = await syncDealOfferFromItems(prisma, tid, dealId);
  return { items, totals: items.length ? sumLines(items) : null };
}

export async function updateDealItem(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  itemId: string,
  input: Partial<{
    name: string;
    description: string | null;
    quantity: number;
    unit: string;
    unitPrice: number;
    vatRate: number;
    sortOrder: number;
    catalogItemId: string | null;
    catalogTruId: string | null;
  }>,
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const item = await prisma.dealItem.findFirst({ where: { id: itemId, tenantId: tid, dealId } });
  if (!item) throw new ApiError(404, "not_found", "Позиция не найдена");
  const quantity = input.quantity ?? asMoney(item.quantity);
  const unitPrice = input.unitPrice ?? asMoney(item.unitPrice);
  const vatRate = input.vatRate ?? asMoney(item.vatRate);
  const amounts = lineAmounts(quantity, unitPrice, vatRate);
  await prisma.dealItem.update({
    where: { id: itemId },
    data: {
      ...(input.name != null ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      quantity,
      unit: input.unit?.trim() || item.unit,
      unitPrice,
      vatRate,
      ...amounts,
      ...(input.sortOrder != null ? { sortOrder: input.sortOrder } : {}),
      ...(input.catalogItemId !== undefined ? { catalogItemId: input.catalogItemId } : {}),
      ...(input.catalogTruId !== undefined ? { catalogTruId: input.catalogTruId?.trim() || null } : {}),
    },
  });
  const items = await syncDealOfferFromItems(prisma, tid, dealId);
  return { items, totals: items.length ? sumLines(items) : null };
}

export async function deleteDealItem(prisma: PrismaClient, auth: AuthContext, dealId: string, itemId: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const item = await prisma.dealItem.findFirst({ where: { id: itemId, tenantId: tid, dealId } });
  if (!item) throw new ApiError(404, "not_found", "Позиция не найдена");
  await prisma.dealItem.delete({ where: { id: itemId } });
  const remaining = await prisma.dealItem.findMany({
    where: { tenantId: tid, dealId },
    orderBy: { sortOrder: "asc" },
  });
  if (remaining.length) {
    const items = await syncDealOfferFromItems(prisma, tid, dealId);
    return { items, totals: sumLines(items) };
  }
  return { items: [], totals: null };
}
