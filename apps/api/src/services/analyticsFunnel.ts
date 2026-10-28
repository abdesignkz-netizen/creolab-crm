import type { Prisma, PrismaClient } from "@creolab/db";

const qualifiedStatuses = ["qualified", "accepted", "in_progress", "waiting_client", "waiting_manager", "proposal", "converted"];
const stageKeys = ["need_identified", "proposal_sent", "negotiation", "contract"];
const stages = [
  { key: "inquiries", name: "Обращения" }, { key: "qualified", name: "Квалифицировано" },
  { key: "deals", name: "Сделки" }, { key: "proposal", name: "КП отправлено" },
  { key: "negotiation", name: "Переговоры" }, { key: "contract", name: "Договор" }, { key: "won", name: "Продано" },
];

export async function buildAnalyticsFunnel(db: PrismaClient, tenantId: string, from: Date | null, to: Date | null,
  mode: "cohort" | "events", inquiryWhere: Prisma.InquiryWhereInput, dealWhere: Prisma.DealWhereInput) {
  const period = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } : undefined;
  const counts: Record<string, number> = Object.fromEntries(stages.map(stage => [stage.key, 0]));
  let unlinkedConverted = 0;
  if (mode === "events") {
    const reached = (key: string) => db.deal.count({ where: { AND: [dealWhere,
      { stageHistory: { some: { tenantId, toSystemKey: key, ...(period ? { enteredAt: period } : {}) } } }] } });
    const values = await Promise.all([
      db.inquiry.count({ where: { AND: [inquiryWhere, ...(period ? [{ receivedAt: period }] : [])] } }),
      db.inquiry.count({ where: { AND: [inquiryWhere, { OR: [
        { qualifiedAt: period || { not: null } },
        { statusHistory: { some: { tenantId, toStatus: { in: qualifiedStatuses }, ...(period ? { changedAt: period } : {}) } } },
      ] }] } }),
      db.deal.count({ where: { AND: [dealWhere, ...(period ? [{ createdAt: period }] : [])] } }),
      reached("proposal_sent"), reached("negotiation"), reached("contract"),
      db.deal.count({ where: { AND: [dealWhere, { outcome: "won", ...(period ? { closedAt: period } : {}) }] } }),
    ]);
    stages.forEach((stage, index) => { counts[stage.key] = values[index]; });
  } else {
    let cursor: string | undefined;
    for (;;) {
      const inquiries = await db.inquiry.findMany({
        where: { AND: [inquiryWhere, ...(period ? [{ receivedAt: period }] : []), ...(cursor ? [{ id: { gt: cursor } }] : [])] },
        orderBy: { id: "asc" }, take: 500,
        select: { id: true, dealId: true, status: true, qualifiedAt: true,
          statusHistory: { where: { toStatus: { in: qualifiedStatuses } }, take: 1, select: { id: true } } },
      });
      if (!inquiries.length) break;
      const deals = await db.deal.findMany({ where: { AND: [dealWhere, { OR: [
        { inquiryId: { in: inquiries.map(row => row.id) } }, { id: { in: inquiries.flatMap(row => row.dealId ? [row.dealId] : []) } },
      ] }] }, select: { id: true, inquiryId: true, outcome: true, stage: { select: { systemKey: true } },
        stageHistory: { where: { toSystemKey: { in: stageKeys } }, distinct: ["toSystemKey"], select: { toSystemKey: true } } } });
      const byId = new Map(deals.map(row => [row.id, row])), byInquiry = new Map(deals.filter(row => row.inquiryId).map(row => [row.inquiryId!, row]));
      for (const inquiry of inquiries) {
        counts.inquiries++;
        const linked = [...new Set([inquiry.dealId ? byId.get(inquiry.dealId) : undefined, byInquiry.get(inquiry.id)].filter(row => row != null))];
        const reached = new Set(linked.flatMap(row => [row.stage.systemKey, ...row.stageHistory.map(h => h.toSystemKey)]));
        if (inquiry.qualifiedAt || inquiry.statusHistory.length || qualifiedStatuses.includes(inquiry.status) || reached.has("need_identified")) counts.qualified++;
        if (linked.length) counts.deals++;
        else if (inquiry.status === "converted" || inquiry.dealId) unlinkedConverted++;
        if (reached.has("proposal_sent")) counts.proposal++;
        if (reached.has("negotiation")) counts.negotiation++;
        if (reached.has("contract")) counts.contract++;
        if (linked.some(row => row.outcome === "won")) counts.won++;
      }
      if (inquiries.length < 500) break;
      cursor = inquiries[inquiries.length - 1].id;
    }
  }
  // Reached stages are independent sets: a deal can skip or repeat a stage.
  // Subtracting adjacent counts would falsely call open/skipped cases losses.
  return { mode, steps: stages.map(stage => ({ ...stage, count: counts[stage.key],
    fromStartPct: mode === "cohort" && counts.inquiries ? Math.round(counts[stage.key] / counts.inquiries * 1000) / 10 : null,
    fromPrevPct: null, lost: null })), transitions: [] as Array<{ from: string; to: string; was: number; passed: number; lost: number; conversion: number | null }>,
    cohort: mode === "cohort" ? { inquiries: counts.inquiries, withDeal: counts.deals, won: counts.won,
      conversion: counts.inquiries ? Math.round(counts.won / counts.inquiries * 1000) / 10 : null, unlinkedConverted } : null,
    observedAt: new Date().toISOString(), complete: true };
}
