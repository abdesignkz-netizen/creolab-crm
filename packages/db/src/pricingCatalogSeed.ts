import type { PrismaClient } from "@prisma/client";
import { PRICING_CATALOG } from "@creolab/contracts";

export async function syncPricingCatalog(prisma: PrismaClient) {
  for (const item of PRICING_CATALOG) {
    const data = {
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
