import { Prisma } from "@creolab/db";
import type { DecisionContent, BusinessInsightRule } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { requireTenant } from "../lib/access.ts";
import { evidenceHash, loadBusinessEvidence, metricKey, type InsightKey } from "./businessMetricRegistry.ts";
import { goalTarget } from "./businessGoalMetrics.ts";

type Source = Pick<DecisionContent, "sourceKind" | "sourceId">;
export async function decisionSource(db: Prisma.TransactionClient, auth: AuthContext, source: Source, now: Date) {
  const tenantId = requireTenant(auth).tenantId, id = source.sourceId;
  const none = { available: false, fingerprint: null as string | null, label: "Источник недоступен", href: null as string | null, privateUserId: null as string | null };
  if (source.sourceKind === "manual") return { ...none, available: true, fingerprint: "manual-v1", label: "Записано руководителем" };
  if (!id) return none;
  if (source.sourceKind === "goal") {
    const g = await db.businessGoal.findFirst({ where: { tenantId, id } });
    if (!g) return none;
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, settingsJson: true } });
    const m = await db.goalMeasurement.findFirst({ where: { tenantId, goalId: id }, orderBy: [{ version: "desc" }, { measuredAt: "desc" }, { id: "desc" }] });
    const target = goalTarget(g, tenant.settingsJson), measurement = m?.resultJson as { target?: number | null } | undefined;
    const fresh = Boolean(m && tenant.timezone === g.timezone && measurement?.target === target
      && (g.state !== "active" || m.version === g.version && (!g.nextCheckAt || g.nextCheckAt > now)));
    return { ...none, available: true, fingerprint: fresh ? evidenceHash({ version: g.version, state: g.state, timezone: tenant.timezone, target, facts: m?.resultJson }) : null,
      label: "Бизнес-цель", href: `/control?view=goals&goal=${id}` };
  }
  if (source.sourceKind === "insight") {
    const i = await db.businessInsight.findFirst({ where: { tenantId, id, isCurrent: true } });
    if (!i || i.state === "unavailable") return none;
    const key: InsightKey = { rule: i.rule as BusinessInsightRule, entityKind: i.entityKind as InsightKey["entityKind"], entityId: i.entityId };
    const { evidence } = await loadBusinessEvidence(db, auth, [key], now), fact = evidence.get(metricKey(key));
    if (!fact?.available) return none;
    const fresh = i.validUntil > now && i.fingerprint === fact.fingerprint && i.formulaVersion === fact.formulaVersion;
    return { ...none, available: true, fingerprint: fresh ? evidenceHash({ version: i.version, fingerprint: i.fingerprint, state: i.state }) : null,
      label: "Бизнес-вывод", href: `/control?view=insights&insight=${id}` };
  }
  const r = await db.actionRun.findFirst({ where: { tenantId, id, userId: auth.user.id, status: "succeeded" }, select: { id: true, userId: true, status: true, finishedAt: true, snapshotJson: true } });
  if (!r) return none;
  return { ...none, available: true, fingerprint: evidenceHash(r), label: "Мой выполненный план", href: `/control?view=plans&run=${id}`, privateUserId: r.userId };
}

export function validateDecisionText(input: Pick<DecisionContent, "topic" | "title" | "body" | "rationale">) {
  const text = Object.values(input).join("\n");
  // Common credentials must never enter persisted free text or an audit copy.
  // This is a guard, not a guarantee that arbitrary personal data is detectable.
  return !/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|\b\d{7,12}:[A-Za-z0-9_-]{25,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{12,}|(?:api[_ -]?key|secret|token|password|пароль|токен|құпиясөз)\s*[:=]\s*\S{4,}/iu.test(text);
}
