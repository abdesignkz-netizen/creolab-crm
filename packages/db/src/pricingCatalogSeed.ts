import type { Prisma, PrismaClient } from "@prisma/client";
import { PRICING_CATALOG, CATALOG_VERSION } from "@creolab/contracts";

export async function syncPricingCatalog(prisma: PrismaClient | Prisma.TransactionClient) {
  for (const item of PRICING_CATALOG) {
    const existing = await prisma.plan.findUnique({ where: { code: item.code } });
    if (existing && existing.version >= CATALOG_VERSION) continue;
    // Freeze old assignments before changing their public catalog row.
    if (existing) {
      const assigned = await prisma.tenantPlan.findMany({ where: { planId: existing.id } });
      for (const row of assigned) {
        const price = (row.priceSnapshotJson || {}) as Record<string, unknown>;
        await prisma.tenantPlan.update({ where: { id: row.id }, data: {
          priceSnapshotJson: { ...price, planVersion: price.planVersion || existing.version },
          featuresSnapshotJson: Object.keys((row.featuresSnapshotJson || {}) as object).length ? row.featuresSnapshotJson : existing.featuresJson,
          limitsSnapshotJson: Object.keys((row.limitsSnapshotJson || {}) as object).length ? row.limitsSnapshotJson : existing.limitsJson,
        } as Prisma.TenantPlanUpdateInput });
      }
    }
    const data = {
      version: CATALOG_VERSION,
      name: item.name,
      kind: item.kind,
      product: item.product,
      monthlyPriceMinor: item.monthlyPriceMinor,
      yearlyPriceMinor: item.yearlyPriceMinor,
      public: item.public,
      active: item.active,
      catalogStatus: item.catalogStatus,
      chargeType: item.chargeType,
      recommended: Boolean(item.recommended),
      sortOrder: item.sortOrder,
      description: item.description,
      includedJson: item.included || [],
      featuresJson: item.features,
      limitsJson: item.limits,
    };
    await prisma.plan.upsert({
      where: { code: item.code },
      update: data,
      create: { code: item.code, ...data },
    });
  }
  await prisma.plan.updateMany({
    where: { code: "starter" },
    data: {
      kind: "legacy",
      public: false,
      catalogStatus: "HIDDEN",
      active: true,
      description: "Прежний стартовый тариф. Существующие компании сохраняют полный доступ.",
    },
  });
}
