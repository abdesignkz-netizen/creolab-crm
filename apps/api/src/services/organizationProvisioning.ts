import { assertFreeCapacity, initializeTenantUsage } from "./billingResourceService.ts";
import { writeAudit } from "../lib/audit.ts";
import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { SUBSCRIPTION_STATUSES, CATALOG_BY_CODE, CATALOG_VERSION } from "@creolab/contracts";
import { PIPELINE_STAGES } from "./dealPipeline.ts";

export type DbClient = PrismaClient | Prisma.TransactionClient;

export type ProvisionSubscriptionStatus =
  | typeof SUBSCRIPTION_STATUSES.NONE
  | typeof SUBSCRIPTION_STATUSES.ACTIVE;

export type ProvisionOrganizationInput = {
  name: string;
  timezone?: string;
  currency?: string;
  city?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  legalName?: string | null;
  bin?: string | null;
  iin?: string | null;
  subscriptionStatus: ProvisionSubscriptionStatus;
  planCode?: string;
  aiEnabled?: boolean;
  source: "self_registration" | "platform_admin";
};

export function slugifyTenantName(name: string) {
  const translit: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  const base = name
    .trim()
    .toLowerCase()
    .split("")
    .map((ch) => translit[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "company";
}

function asTrimmed(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

async function uniqueSlug(tx: DbClient, name: string) {
  let slug = slugifyTenantName(name);
  const taken = await tx.tenant.findUnique({ where: { slug }, select: { id: true } });
  if (taken) slug = `${slug}-${randomBytes(3).toString("hex")}`;
  return slug;
}

async function ensureStarterPlan(tx: DbClient, code = "starter") {
  return tx.plan.upsert({
    where: { code },
    update: {},
    create: {
      name: "Стартовый",
      code,
      limitsJson: { whatsappActive: 1, members: 20, aiMonthly: 20000 },
      featuresJson: { forms: true, webhook: true, whatsapp: true },
    },
  });
}

/**
 * Single tenant bootstrap used by self-registration and platform-admin create.
 * Does not create User or Membership — callers attach owner/invite in the same transaction.
 */
export async function provisionOrganization(tx: DbClient, input: ProvisionOrganizationInput) {
  const free = input.source === "self_registration";
  if (free) await assertFreeCapacity(tx);
  const name = input.name.trim();
  const slug = await uniqueSlug(tx, name);
  const contactEmail = asTrimmed(input.contactEmail);
  const contactPhone = asTrimmed(input.contactPhone);
  const city = asTrimmed(input.city);
  const preview = input.subscriptionStatus === SUBSCRIPTION_STATUSES.NONE;
  const tenant = await tx.tenant.create({
    data: {
      name,
      slug,
      timezone: input.timezone || "Asia/Almaty",
      currency: input.currency || "KZT",
      status: "active",
      settingsJson: {
        city,
        contactEmail,
        contactPhone,
        source: input.source,
        onboarding: preview
          ? { status: "not_started", deferred: false, steps: {} }
          : { status: "completed", deferred: false, steps: {} },
      } as Prisma.InputJsonValue,
    },
  });
  await tx.tenantLegalProfile.create({
    data: {
      tenantId: tenant.id,
      legalName: asTrimmed(input.legalName),
      bin: asTrimmed(input.bin),
      iin: asTrimmed(input.iin),
      email: contactEmail,
      phone: contactPhone,
    },
  });
  const spec = CATALOG_BY_CODE.BASQAR_FREE;
  const plan = free ? await tx.plan.upsert({ where: { code: spec.code }, update: {}, create: {
    code: spec.code, name: spec.name, kind: spec.kind, product: spec.product, public: true,
    catalogStatus: spec.catalogStatus, description: spec.description, version: CATALOG_VERSION,
    featuresJson: spec.features, limitsJson: spec.limits,
  } }) : await ensureStarterPlan(tx, input.planCode || "starter");
  await tx.tenantPlan.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: free ? SUBSCRIPTION_STATUSES.ACTIVE : input.subscriptionStatus,
      ...(free ? { featuresSnapshotJson: spec.features, limitsSnapshotJson: spec.limits,
        priceSnapshotJson: { planVersion: CATALOG_VERSION, planCode: spec.code, basePriceAtActivation: 0, finalAmountMinor: 0 }, paymentMethod: "FREE" } : {}),
    },
  });
  for (const def of PIPELINE_STAGES) {
    await tx.dealStage.create({
      data: {
        tenantId: tenant.id,
        systemKey: def.systemKey,
        name: def.name,
        sortOrder: def.sortOrder,
        defaultProbability: def.defaultProbability,
      },
    });
  }
  await tx.knowledgeVersion.create({
    data: {
      tenantId: tenant.id,
      version: 1,
      status: "published",
      publishedAt: new Date(),
      contentJson: { about: name, services: [] },
    },
  });
  await tx.aIConfiguration.create({
    data: {
      tenantId: tenant.id,
      enabled: input.aiEnabled ?? !preview,
      provider: null,
    },
  });
  if (free) {
    await initializeTenantUsage(tx, tenant.id, spec.limits as Record<string, number>);
    await writeAudit(tx, { tenantId: tenant.id, action: "subscription.free_activated", entityType: "tenant", entityId: tenant.id });
  }
  return tenant;
}
