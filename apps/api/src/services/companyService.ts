import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { CONTACT_PHONE_SELECT, digitsOnly, displayName, formatWhen, phoneFromContact } from "./contactLabels.ts";
import { amountNumber, formatMoney } from "./dealPipeline.ts";
import { writeActivity } from "./contactService.ts";

export const COMPANY_LIFECYCLE_LABEL: Record<string, string> = {
  PROSPECT: "Потенциальный клиент",
  CUSTOMER: "Клиент",
  INACTIVE_CUSTOMER: "Неактивный клиент",
  PARTNER: "Партнёр",
  ARCHIVED: "Архив",
};

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

/** Stub for future RBAC — always allow within tenant for now. */
export function assertCanViewCompany(_auth: AuthContext, _company: { tenantId: string }) {
  return true;
}

export function normalizeCompanyName(name: string) {
  return name
    .toLowerCase()
    .replace(/ооо|тоо|ип|llp|llc|jsc|ао|зао|пао/gi, "")
    .replace(/[\u00ab\u00bb"'`.,\-]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function websiteDomain(website?: string | null) {
  if (!website) return null;
  try {
    const raw = website.includes("://") ? website : `https://${website}`;
    return new URL(raw).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return website.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0]?.toLowerCase() || null;
  }
}

function emailDomain(email?: string | null) {
  if (!email || !email.includes("@")) return null;
  return email.split("@")[1]?.toLowerCase() || null;
}

function contactLabel(contact: {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}) {
  return displayName(contact);
}

export type CompanyInput = {
  name: string;
  legalName?: string | null;
  shortName?: string | null;
  bin?: string | null;
  industry?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  city?: string | null;
  address?: string | null;
  description?: string | null;
  lifecycleStatus?: string | null;
  assigneeMembershipId?: string | null;
  initialSource?: string | null;
  bankDetailsJson?: Record<string, unknown> | null;
  forceCreate?: boolean;
};

export type CompanyContactInput = {
  contactId: string;
  position?: string | null;
  department?: string | null;
  isPrimary?: boolean;
  isDecisionMaker?: boolean;
  isBillingContact?: boolean;
  isActive?: boolean;
};

function serializeCompany(
  company: {
    id: string;
    name: string;
    legalName: string | null;
    shortName: string | null;
    bin: string | null;
    industry: string | null;
    website: string | null;
    email: string | null;
    phone: string | null;
    country: string | null;
    city: string | null;
    address: string | null;
    description: string | null;
    lifecycleStatus: string;
    assigneeMembershipId: string | null;
    initialSource: string | null;
    bankDetailsJson: unknown;
    firstContactAt: Date | null;
    lastActivityAt: Date | null;
    createdAt: Date;
    archivedAt: Date | null;
    assignee?: { id: string; user: { name: string } } | null;
  },
  timeZone: string,
) {
  return {
    id: company.id,
    name: company.name,
    legalName: company.legalName,
    shortName: company.shortName,
    bin: company.bin,
    industry: company.industry,
    website: company.website,
    email: company.email,
    phone: company.phone,
    country: company.country,
    city: company.city,
    address: company.address,
    description: company.description,
    lifecycleStatus: company.lifecycleStatus,
    lifecycleLabel: COMPANY_LIFECYCLE_LABEL[company.lifecycleStatus] || company.lifecycleStatus,
    assigneeMembershipId: company.assigneeMembershipId,
    assigneeName: company.assignee?.user?.name || null,
    initialSource: company.initialSource,
    bankDetails: (company.bankDetailsJson || {}) as Record<string, unknown>,
    firstContactAt: company.firstContactAt?.toISOString() || null,
    firstContactLabel: company.firstContactAt ? formatWhen(company.firstContactAt, timeZone) : null,
    lastActivityAt: company.lastActivityAt?.toISOString() || null,
    lastActivityLabel: company.lastActivityAt ? formatWhen(company.lastActivityAt, timeZone) : null,
    createdAt: company.createdAt.toISOString(),
    archivedAt: company.archivedAt?.toISOString() || null,
  };
}

export async function findCompanyDuplicates(
  prisma: PrismaClient,
  auth: AuthContext,
  input: Partial<CompanyInput> & { name?: string },
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const or: Prisma.CompanyWhereInput[] = [];
  const bin = String(input.bin || "").replace(/\D/g, "");
  if (bin.length >= 8) or.push({ bin });
  const norm = input.name ? normalizeCompanyName(input.name) : "";
  if (norm.length >= 3) or.push({ nameNormalized: norm });
  const domain = websiteDomain(input.website) || emailDomain(input.email);
  if (domain) {
    or.push({ website: { contains: domain, mode: "insensitive" } });
    or.push({ email: { contains: `@${domain}`, mode: "insensitive" } });
  }
  const phone = digitsOnly(input.phone || "");
  if (phone.length >= 10) or.push({ phoneNormalized: { contains: phone.slice(-10) } });

  if (!or.length) return { duplicates: [] as ReturnType<typeof serializeCompany>[] };

  const rows = await prisma.company.findMany({
    where: { tenantId: tid, archivedAt: null, OR: or },
    include: {
      assignee: { include: { user: { select: { name: true } } } },
      contacts: { where: { isActive: true }, select: { id: true } },
      deals: { where: { outcome: "open" }, select: { id: true } },
    },
    take: 10,
  });
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  return {
    duplicates: rows.map((c) => ({
      ...serializeCompany(c, timeZone),
      contactsCount: c.contacts.length,
      activeDealsCount: c.deals.length,
    })),
  };
}

export async function createCompany(prisma: PrismaClient, auth: AuthContext, input: CompanyInput) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const name = String(input.name || "").trim();
  if (!name) throw new ApiError(422, "invalid", "Укажите название компании");

  if (!input.forceCreate) {
    const dup = await findCompanyDuplicates(prisma, auth, input);
    if (dup.duplicates.length) {
      throw new ApiError(409, "company_duplicate", "Возможно, компания уже существует", undefined, {
        duplicates: dup.duplicates,
      });
    }
  }

  const now = new Date();
  const phone = input.phone?.trim() || null;
  const company = await prisma.company.create({
    data: {
      tenantId: tid,
      name,
      legalName: input.legalName?.trim() || null,
      shortName: input.shortName?.trim() || null,
      nameNormalized: normalizeCompanyName(name),
      bin: input.bin?.replace(/\D/g, "") || null,
      industry: input.industry?.trim() || null,
      website: input.website?.trim() || null,
      email: input.email?.trim() || null,
      phone,
      phoneNormalized: phone ? digitsOnly(phone) : null,
      country: input.country?.trim() || null,
      city: input.city?.trim() || null,
      address: input.address?.trim() || null,
      description: input.description?.trim() || null,
      lifecycleStatus: input.lifecycleStatus || "PROSPECT",
      assigneeMembershipId: input.assigneeMembershipId || membership.id,
      initialSource: input.initialSource?.trim() || null,
      bankDetailsJson: (input.bankDetailsJson || {}) as Prisma.InputJsonValue,
      firstContactAt: now,
      lastActivityAt: now,
    },
    include: { assignee: { include: { user: { select: { name: true } } } } },
  });

  return serializeCompany(company, membership.tenant.timezone || "Asia/Almaty");
}

export async function updateCompany(
  prisma: PrismaClient,
  auth: AuthContext,
  companyId: string,
  input: Partial<CompanyInput>,
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const existing = await prisma.company.findFirst({ where: { id: companyId, tenantId: tid } });
  if (!existing) throw new ApiError(404, "not_found", "Компания не найдена");
  assertCanViewCompany(auth, existing);

  const name = input.name != null ? String(input.name).trim() : undefined;
  if (name !== undefined && !name) throw new ApiError(422, "invalid", "Название не может быть пустым");

  const phone = input.phone !== undefined ? input.phone?.trim() || null : undefined;
  const company = await prisma.company.update({
    where: { id: companyId },
    data: {
      ...(name != null ? { name, nameNormalized: normalizeCompanyName(name) } : {}),
      ...(input.legalName !== undefined ? { legalName: input.legalName?.trim() || null } : {}),
      ...(input.shortName !== undefined ? { shortName: input.shortName?.trim() || null } : {}),
      ...(input.bin !== undefined ? { bin: input.bin?.replace(/\D/g, "") || null } : {}),
      ...(input.industry !== undefined ? { industry: input.industry?.trim() || null } : {}),
      ...(input.website !== undefined ? { website: input.website?.trim() || null } : {}),
      ...(input.email !== undefined ? { email: input.email?.trim() || null } : {}),
      ...(phone !== undefined ? { phone, phoneNormalized: phone ? digitsOnly(phone) : null } : {}),
      ...(input.country !== undefined ? { country: input.country?.trim() || null } : {}),
      ...(input.city !== undefined ? { city: input.city?.trim() || null } : {}),
      ...(input.address !== undefined ? { address: input.address?.trim() || null } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      ...(input.lifecycleStatus !== undefined ? { lifecycleStatus: input.lifecycleStatus || "PROSPECT" } : {}),
      ...(input.assigneeMembershipId !== undefined
        ? { assigneeMembershipId: input.assigneeMembershipId || null }
        : {}),
      ...(input.initialSource !== undefined ? { initialSource: input.initialSource?.trim() || null } : {}),
      ...(input.bankDetailsJson !== undefined
        ? { bankDetailsJson: (input.bankDetailsJson || {}) as Prisma.InputJsonValue }
        : {}),
      lastActivityAt: new Date(),
    },
    include: { assignee: { include: { user: { select: { name: true } } } } },
  });
  return serializeCompany(company, membership.tenant.timezone || "Asia/Almaty");
}

export async function deleteCompany(prisma: PrismaClient, auth: AuthContext, companyId: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const existing = await prisma.company.findFirst({ where: { id: companyId, tenantId: tid } });
  if (!existing) throw new ApiError(404, "not_found", "Компания не найдена");
  assertCanViewCompany(auth, existing);

  await prisma.$transaction(async (tx) => {
    await tx.companyContact.updateMany({
      where: { tenantId: tid, companyId },
      data: { isActive: false, isPrimary: false, endedAt: new Date() },
    });
    await tx.company.update({
      where: { id: companyId },
      data: {
        archivedAt: existing.archivedAt || new Date(),
        lifecycleStatus: "ARCHIVED",
        lastActivityAt: new Date(),
      },
    });
  });
  return { ok: true, id: companyId };
}

export async function listCompanies(
  prisma: PrismaClient,
  auth: AuthContext,
  query: {
    scope?: string;
    q?: string;
    lifecycleStatus?: string;
    assignee?: string;
    industry?: string;
    city?: string;
    hasActiveDeals?: string;
    hasWon?: string;
    inactiveDays?: string;
  } = {},
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const currency = membership.tenant.currency || "KZT";
  const q = String(query.q || "").trim();
  const where: Prisma.CompanyWhereInput = {
    tenantId: tid,
    archivedAt: null,
  };

  if (query.scope === "mine") where.assigneeMembershipId = membership.id;
  if (query.scope === "unassigned") where.assigneeMembershipId = null;
  if (query.lifecycleStatus) where.lifecycleStatus = query.lifecycleStatus;
  if (query.assignee) where.assigneeMembershipId = query.assignee;
  if (query.industry) where.industry = { contains: query.industry, mode: "insensitive" };
  if (query.city) where.city = { contains: query.city, mode: "insensitive" };
  if (query.inactiveDays) {
    const days = Number(query.inactiveDays);
    if (Number.isFinite(days) && days > 0) {
      const cutoff = new Date(Date.now() - days * 86400000);
      where.OR = [{ lastActivityAt: null }, { lastActivityAt: { lt: cutoff } }];
    }
  }
  if (query.hasActiveDeals === "1") where.deals = { some: { outcome: "open" } };
  if (query.hasActiveDeals === "0") where.deals = { none: { outcome: "open" } };
  if (query.hasWon === "1") where.deals = { ...(where.deals as object), some: { outcome: "won" } };

  if (q) {
    const digits = digitsOnly(q);
    where.AND = [
      {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { legalName: { contains: q, mode: "insensitive" } },
          { shortName: { contains: q, mode: "insensitive" } },
          { bin: { contains: digits || q } },
          { phone: { contains: q } },
          { email: { contains: q, mode: "insensitive" } },
          { website: { contains: q, mode: "insensitive" } },
          {
            contacts: {
              some: {
                contact: {
                  OR: [
                    { name: { contains: q, mode: "insensitive" } },
                    { firstName: { contains: q, mode: "insensitive" } },
                    { lastName: { contains: q, mode: "insensitive" } },
                    ...(digits
                      ? [{ methods: { some: { normalizedValue: { contains: digits } } } }]
                      : []),
                  ],
                },
              },
            },
          },
        ],
      },
    ];
  }

  const rows = await prisma.company.findMany({
    where,
    include: {
      assignee: { include: { user: { select: { name: true } } } },
      contacts: {
        where: { isActive: true },
        include: {
          contact: {
            select: { id: true, name: true, firstName: true, lastName: true },
          },
        },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      },
      deals: {
        where: { outcome: "open" },
        select: {
          id: true,
          offerAmountMinor: true,
          probability: true,
          stage: { select: { defaultProbability: true } },
        },
      },
    },
    orderBy: [{ lastActivityAt: "desc" }, { createdAt: "desc" }],
    take: 200,
  });

  const items = rows.map((c) => {
    let pipeline = 0;
    let pipelineKnown = 0;
    for (const d of c.deals) {
      const n = amountNumber(d.offerAmountMinor);
      if (n != null) {
        pipeline += n;
        pipelineKnown += 1;
      }
    }
    const primary = c.contacts.find((x) => x.isPrimary) || c.contacts[0] || null;
    return {
      ...serializeCompany(c, timeZone),
      contactsCount: c.contacts.length,
      activeDealsCount: c.deals.length,
      pipelineAmount: pipelineKnown ? pipeline : null,
      pipelineLabel: formatMoney(pipelineKnown ? pipeline : null, currency),
      primaryContact: primary
        ? {
            id: primary.contact.id,
            name: contactLabel(primary.contact),
            position: primary.position,
            isDecisionMaker: primary.isDecisionMaker,
          }
        : null,
    };
  });

  return { items, total: items.length };
}

async function clearOtherPrimary(
  tx: Prisma.TransactionClient | PrismaClient,
  tenantId: string,
  companyId: string,
  exceptId?: string,
) {
  await tx.companyContact.updateMany({
    where: {
      tenantId,
      companyId,
      isPrimary: true,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { isPrimary: false },
  });
}

export async function linkContactToCompany(
  prisma: PrismaClient,
  auth: AuthContext,
  companyId: string,
  input: CompanyContactInput,
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const company = await prisma.company.findFirst({ where: { id: companyId, tenantId: tid } });
  if (!company) throw new ApiError(404, "not_found", "Компания не найдена");
  const contact = await prisma.contact.findFirst({ where: { id: input.contactId, tenantId: tid } });
  if (!contact) throw new ApiError(404, "not_found", "Клиент не найден");

  const existing = await prisma.companyContact.findFirst({
    where: { tenantId: tid, companyId, contactId: input.contactId },
  });

  const link = await prisma.$transaction(async (tx) => {
    if (input.isPrimary) await clearOtherPrimary(tx, tid, companyId, existing?.id);
    const data = {
      position: input.position?.trim() || null,
      department: input.department?.trim() || null,
      isPrimary: Boolean(input.isPrimary),
      isDecisionMaker: Boolean(input.isDecisionMaker),
      isBillingContact: Boolean(input.isBillingContact),
      isActive: input.isActive !== false,
      endedAt: input.isActive === false ? new Date() : null,
    };
    const row = existing
      ? await tx.companyContact.update({ where: { id: existing.id }, data })
      : await tx.companyContact.create({
          data: {
            tenantId: tid,
            companyId,
            contactId: input.contactId,
            startedAt: new Date(),
            ...data,
          },
        });
    await tx.company.update({
      where: { id: companyId },
      data: { lastActivityAt: new Date() },
    });
    if (!contact.companyName) {
      await tx.contact.update({
        where: { id: contact.id },
        data: { companyName: company.name },
      });
    }
    await writeActivity(tx, {
      tenantId: tid,
      contactId: contact.id,
      companyId,
      type: "company.link",
      title: `Связан с компанией ${company.name}`,
      description: data.position || undefined,
      actorType: "user",
      actorId: auth.user.id,
      metadata: { companyId },
    });
    return row;
  });

  return getCompanyContacts(prisma, auth, companyId).then((r) => ({
    linkId: link.id,
    contacts: r.contacts,
  }));
}

export async function updateCompanyContact(
  prisma: PrismaClient,
  auth: AuthContext,
  companyId: string,
  linkId: string,
  input: Partial<CompanyContactInput>,
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const link = await prisma.companyContact.findFirst({
    where: { id: linkId, tenantId: tid, companyId },
  });
  if (!link) throw new ApiError(404, "not_found", "Связь не найдена");

  await prisma.$transaction(async (tx) => {
    if (input.isPrimary) await clearOtherPrimary(tx, tid, companyId, linkId);
    await tx.companyContact.update({
      where: { id: linkId },
      data: {
        ...(input.position !== undefined ? { position: input.position?.trim() || null } : {}),
        ...(input.department !== undefined ? { department: input.department?.trim() || null } : {}),
        ...(input.isPrimary !== undefined ? { isPrimary: Boolean(input.isPrimary) } : {}),
        ...(input.isDecisionMaker !== undefined ? { isDecisionMaker: Boolean(input.isDecisionMaker) } : {}),
        ...(input.isBillingContact !== undefined ? { isBillingContact: Boolean(input.isBillingContact) } : {}),
        ...(input.isActive !== undefined
          ? { isActive: Boolean(input.isActive), endedAt: input.isActive ? null : new Date() }
          : {}),
      },
    });
    await tx.company.update({ where: { id: companyId }, data: { lastActivityAt: new Date() } });
  });
  return getCompanyContacts(prisma, auth, companyId);
}

export async function unlinkCompanyContact(
  prisma: PrismaClient,
  auth: AuthContext,
  companyId: string,
  linkId: string,
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const link = await prisma.companyContact.findFirst({
    where: { id: linkId, tenantId: tid, companyId },
  });
  if (!link) throw new ApiError(404, "not_found", "Связь не найдена");
  await prisma.companyContact.update({
    where: { id: linkId },
    data: { isActive: false, endedAt: new Date(), isPrimary: false },
  });
  return getCompanyContacts(prisma, auth, companyId);
}

export async function getCompanyContacts(prisma: PrismaClient, auth: AuthContext, companyId: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const links = await prisma.companyContact.findMany({
    where: { tenantId: tid, companyId, isActive: true },
    include: {
      contact: {
        include: {
          methods: true,
        },
      },
    },
    orderBy: [{ isPrimary: "desc" }, { isDecisionMaker: "desc" }, { createdAt: "asc" }],
  });
  return {
    contacts: links.map((l) => {
      const phone = l.contact.methods.find((m) => m.type === "phone" && m.primary) ||
        l.contact.methods.find((m) => m.type === "phone");
      const email = l.contact.methods.find((m) => m.type === "email")?.rawValue || null;
      return {
        linkId: l.id,
        contactId: l.contactId,
        name: contactLabel(l.contact),
        position: l.position,
        department: l.department,
        isPrimary: l.isPrimary,
        isDecisionMaker: l.isDecisionMaker,
        isBillingContact: l.isBillingContact,
        phone: phone?.rawValue || null,
        email,
        lastContactAt: l.contact.lastContactAt?.toISOString() || null,
        lastContactLabel: l.contact.lastContactAt ? formatWhen(l.contact.lastContactAt, timeZone) : null,
        href: `/contacts/${l.contactId}`,
      };
    }),
  };
}

export async function getCompanyOverview(prisma: PrismaClient, auth: AuthContext, companyId: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const currency = membership.tenant.currency || "KZT";

  const company = await prisma.company.findFirst({
    where: { id: companyId, tenantId: tid },
    include: { assignee: { include: { user: { select: { name: true } } } } },
  });
  if (!company) throw new ApiError(404, "not_found", "Компания не найдена");
  assertCanViewCompany(auth, company);

  const [contactsRes, inquiries, deals, tasks, activities] = await Promise.all([
    getCompanyContacts(prisma, auth, companyId),
    prisma.inquiry.findMany({
      where: { tenantId: tid, companyId, archived: false },
      include: { contact: { select: CONTACT_PHONE_SELECT } },
      orderBy: { receivedAt: "desc" },
      take: 50,
    }),
    prisma.deal.findMany({
      where: { tenantId: tid, companyId },
      include: {
        stage: true,
        contact: { select: CONTACT_PHONE_SELECT },
        dealContacts: {
          include: { contact: { select: { id: true, ...CONTACT_PHONE_SELECT } } },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
    prisma.task.findMany({
      where: {
        tenantId: tid,
        OR: [{ companyId }, { contact: { companyContacts: { some: { companyId, isActive: true } } } }],
        status: { in: ["open", "waiting"] },
      },
      orderBy: { dueAt: "asc" },
      take: 30,
    }),
    prisma.activity.findMany({
      where: { tenantId: tid, companyId },
      include: { contact: { select: CONTACT_PHONE_SELECT } },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
  ]);

  const activeInquiries = inquiries.filter((i) =>
    ["new", "accepted", "qualification", "qualified", "in_progress", "waiting_client", "waiting_manager", "proposal"].includes(
      i.status,
    ),
  );
  const activeDeals = deals.filter((d) => d.outcome === "open");
  const wonDeals = deals.filter((d) => d.outcome === "won");
  const lostDeals = deals.filter((d) => d.outcome === "lost");
  let pipeline = 0;
  let pipelineKnown = 0;
  let onContract = 0;
  for (const d of activeDeals) {
    const n = amountNumber(d.offerAmountMinor);
    if (n != null) {
      pipeline += n;
      pipelineKnown += 1;
    }
    if (d.stage.systemKey === "contract" || d.stage.systemKey === "invoiced") onContract += 1;
  }
  let revenue = 0;
  let revenueKnown = 0;
  for (const d of wonDeals) {
    const n = amountNumber(d.wonAmountMinor ?? d.offerAmountMinor);
    if (n != null) {
      revenue += n;
      revenueKnown += 1;
    }
  }

  const overdueTasks = tasks.filter((t) => t.dueAt && t.dueAt < new Date() && t.status === "open");
  const nextTask = tasks.find((t) => t.status === "open" || t.status === "waiting") || null;
  const nextDeal = activeDeals.find((d) => d.nextActionAt || d.nextAction) || null;

  // Also pull activities from linked contacts if companyId not set on old rows
  const contactIds = contactsRes.contacts.map((c) => c.contactId);
  const contactActivities =
    contactIds.length && activities.length < 10
      ? await prisma.activity.findMany({
          where: { tenantId: tid, contactId: { in: contactIds }, companyId: null },
          include: { contact: { select: CONTACT_PHONE_SELECT } },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      : [];

  const timeline = [...activities, ...contactActivities]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 40)
    .map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      description: a.description,
      createdAt: a.createdAt.toISOString(),
      createdLabel: formatWhen(a.createdAt, timeZone),
      contactName: contactLabel(a.contact),
      phone: phoneFromContact(a.contact),
      contactId: a.contactId,
    }));

  return {
    company: serializeCompany(company, timeZone),
    contacts: contactsRes.contacts,
    current: {
      activeRequests: activeInquiries.length,
      activeDeals: activeDeals.length,
      pipelineAmount: pipelineKnown ? pipeline : null,
      pipelineLabel: formatMoney(pipelineKnown ? pipeline : null, currency),
      contractDeals: onContract,
      needsReply: activeInquiries.filter((i) => i.needsReply).length,
      overdueTasks: overdueTasks.length,
      nextAction: nextTask
        ? {
            kind: "task",
            id: nextTask.id,
            title: nextTask.title,
            dueAt: nextTask.dueAt?.toISOString() || null,
            dueLabel: nextTask.dueAt ? formatWhen(nextTask.dueAt, timeZone) : null,
            href: `/tasks?task=${nextTask.id}`,
          }
        : nextDeal
          ? {
              kind: "deal",
              id: nextDeal.id,
              title: nextDeal.nextAction || nextDeal.title,
              dueAt: nextDeal.nextActionAt?.toISOString() || null,
              dueLabel: nextDeal.nextActionAt ? formatWhen(nextDeal.nextActionAt, timeZone) : null,
              href: `/deals/${nextDeal.id}`,
            }
          : null,
    },
    lifetime: {
      requests: inquiries.length,
      deals: deals.length,
      wonDeals: wonDeals.length,
      lostDeals: lostDeals.length,
      revenue: revenueKnown ? revenue : null,
      revenueLabel: formatMoney(revenueKnown ? revenue : null, currency),
      averageDeal: revenueKnown && wonDeals.length ? Math.round(revenue / wonDeals.length) : null,
      averageDealLabel: formatMoney(
        revenueKnown && wonDeals.length ? Math.round(revenue / wonDeals.length) : null,
        currency,
      ),
      withUsSince: company.firstContactAt?.toISOString() || company.createdAt.toISOString(),
      withUsSinceLabel: formatWhen(company.firstContactAt || company.createdAt, timeZone),
    },
    inquiries: inquiries.slice(0, 20).map((i) => ({
      id: i.id,
      title: i.subject || i.service || "Заявка",
      status: i.status,
      contactName: contactLabel(i.contact),
      phone: phoneFromContact(i.contact, i),
      source: i.utmSource || i.sourceChannel || i.source,
      receivedAt: i.receivedAt.toISOString(),
      receivedLabel: formatWhen(i.receivedAt, timeZone),
      href: `/requests/${i.id}`,
    })),
    deals: deals.slice(0, 20).map((d) => {
      const amount = amountNumber(d.offerAmountMinor);
      const primary = d.dealContacts.find((c) => c.isPrimary) || d.dealContacts[0];
      const lpr = d.dealContacts.find((c) => (c.role || "").toLowerCase().includes("лпр") || (c.role || "").toLowerCase().includes("decision"));
      return {
        id: d.id,
        title: d.title,
        outcome: d.outcome,
        stageName: d.stage.name,
        amount,
        amountLabel: formatMoney(amount, d.currency || currency),
        contactName: contactLabel(d.contact),
        phone: phoneFromContact(d.contact),
        primaryContactName: primary ? contactLabel(primary.contact) : null,
        primaryContactPhone: primary ? phoneFromContact(primary.contact) : null,
        decisionMakerName: lpr ? contactLabel(lpr.contact) : null,
        decisionMakerPhone: lpr ? phoneFromContact(lpr.contact) : null,
        href: `/deals/${d.id}`,
      };
    }),
    tasks: tasks.slice(0, 15).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dueAt: t.dueAt?.toISOString() || null,
      dueLabel: t.dueAt ? formatWhen(t.dueAt, timeZone) : null,
      href: `/tasks?task=${t.id}`,
    })),
    timeline,
  };
}

export async function suggestCompaniesFromCompanyName(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const contacts = await prisma.contact.findMany({
    where: { tenantId: tid, archivedAt: null, companyName: { not: null } },
    select: { id: true, companyName: true, name: true, firstName: true, lastName: true },
    take: 2000,
  });
  const groups = new Map<string, { label: string; contactIds: string[]; names: string[] }>();
  for (const c of contacts) {
    const raw = String(c.companyName || "").trim();
    if (raw.length < 3) continue;
    const key = normalizeCompanyName(raw);
    if (key.length < 3) continue;
    if (!groups.has(key)) groups.set(key, { label: raw, contactIds: [], names: [] });
    const g = groups.get(key)!;
    g.contactIds.push(c.id);
    g.names.push(contactLabel(c));
    if (raw.length < g.label.length) g.label = raw;
  }

  const existing = await prisma.company.findMany({
    where: { tenantId: tid, archivedAt: null },
    select: { nameNormalized: true },
  });
  const existingNorm = new Set(existing.map((e) => e.nameNormalized).filter(Boolean));

  const candidates = [...groups.entries()]
    .filter(([key, g]) => g.contactIds.length >= 2 && !existingNorm.has(key))
    .map(([key, g]) => ({
      nameNormalized: key,
      suggestedName: g.label,
      contactCount: g.contactIds.length,
      contactIds: g.contactIds.slice(0, 20),
      sampleNames: g.names.slice(0, 5),
    }))
    .sort((a, b) => b.contactCount - a.contactCount)
    .slice(0, 50);

  return { candidates };
}

export async function getContactCompanies(prisma: PrismaClient, auth: AuthContext, contactId: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const links = await prisma.companyContact.findMany({
    where: { tenantId: tid, contactId, isActive: true },
    include: {
      company: {
        include: { assignee: { include: { user: { select: { name: true } } } } },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return {
    companies: links.map((l) => ({
      linkId: l.id,
      position: l.position,
      department: l.department,
      isPrimary: l.isPrimary,
      isDecisionMaker: l.isDecisionMaker,
      isBillingContact: l.isBillingContact,
      company: serializeCompany(l.company, timeZone),
      href: `/companies/${l.companyId}`,
    })),
  };
}

export async function addDealContact(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: { contactId: string; role?: string | null; isPrimary?: boolean },
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: tid } });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const contact = await prisma.contact.findFirst({ where: { id: input.contactId, tenantId: tid } });
  if (!contact) throw new ApiError(404, "not_found", "Клиент не найден");

  await prisma.$transaction(async (tx) => {
    if (input.isPrimary) {
      await tx.dealContact.updateMany({
        where: { tenantId: tid, dealId, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    const existing = await tx.dealContact.findFirst({
      where: { tenantId: tid, dealId, contactId: input.contactId },
    });
    if (existing) {
      await tx.dealContact.update({
        where: { id: existing.id },
        data: {
          role: input.role?.trim() || existing.role,
          isPrimary: input.isPrimary ?? existing.isPrimary,
        },
      });
    } else {
      await tx.dealContact.create({
        data: {
          tenantId: tid,
          dealId,
          contactId: input.contactId,
          role: input.role?.trim() || null,
          isPrimary: Boolean(input.isPrimary),
        },
      });
    }
  });
  return { ok: true };
}
