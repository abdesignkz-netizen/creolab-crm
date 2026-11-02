import type { PrismaClient } from "@creolab/db";
import type { BusinessHomeFocus, HomeModule } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { requireTenant } from "../lib/access.ts";
import { logServerError } from "../lib/redact.ts";
import { authForUserInTenant } from "./authService.ts";
import { listBusinessInsights } from "./businessInsightService.ts";
import { listBusinessGoals } from "./businessGoalService.ts";
import { actionHomeFocus } from "./aiActionService.ts";

const leadership = ["owner", "director", "sales_lead"];
const version = (auth: AuthContext) => {
  const m = requireTenant(auth);
  return JSON.stringify([auth.user.id, m.tenantId, m.role, [...m.permissions].sort(), m.active, m.tenant.status]);
};
const hidden = <T>(): HomeModule<T> => ({ status: "hidden", items: [] });

/** No persisted summaries or cache: all three sections use their existing authorization and evidence. */
export async function getBusinessHomeFocus(db: PrismaClient, auth: AuthContext, now = new Date()): Promise<BusinessHomeFocus> {
  if (auth.configurationTenant) throw new ApiError(403, "forbidden", "Обзор доступен в кабинете компании.");
  const tenantId = requireTenant(auth).tenantId;
  const current = await authForUserInTenant(db, auth.user.id, tenantId, auth.sessionId);
  const initial = version(current);
  const empty: BusinessHomeFocus = { asOf: now.toISOString(), scope: "personal",
    insights: { ...hidden(), scannedAt: null, sampled: true }, goals: hidden(), actions: { ...hidden(), recent: [] } };
  // No company-wide queries for employees, even if their permissions contain extra flags.
  if (!leadership.includes(requireTenant(current).role)) return empty;
  const safe = async <T>(section: string, work: () => Promise<T>): Promise<T | null> => {
    try { return await work(); }
    catch (e) {
      if (e instanceof ApiError && [401, 403].includes(e.status)) throw e;
      logServerError(e, `business_home.${section}`);
      return null;
    }
  };
  // Sequential transactions also work with the single-connection embedded test database.
  const insights = await safe("insights", () => listBusinessInsights(db, current, {}, now, true));
  const goals = await safe("goals", () => listBusinessGoals(db, current, {}, now, true));
  const actions = await safe("actions", () => actionHomeFocus(db, current, now));
  if (version(await authForUserInTenant(db, auth.user.id, tenantId, auth.sessionId)) !== initial) {
    throw new ApiError(403, "access_changed", "Права изменились. Обновите страницу.");
  }
  return { asOf: now.toISOString(), scope: "company",
    insights: { status: insights ? "ready" : "unavailable", scannedAt: insights?.coverage.asOf || null, sampled: true,
      items: (insights?.items || []).filter(i => !i.stale && i.content).sort((a, b) => Number(b.content!.severity === "urgent") - Number(a.content!.severity === "urgent")).slice(0, 2).map(i => ({
        id: i.id, title: i.content!.title, detail: i.content!.explanation, limitation: i.content!.limitation,
        href: `/control?view=insights&insight=${i.id}`, asOf: i.checkedAt, urgent: i.content!.severity === "urgent",
      })) },
    goals: { status: goals ? "ready" : "unavailable", items: (goals?.items || []).map(g => {
      const valid = !g.stale && g.current?.sample.status === "ready" && !g.periodEnded;
      return { id: g.id, title: g.title, progress: valid ? g.current!.progress : null, reached: valid ? g.current!.reached : null,
        stale: g.stale, ended: g.periodEnded, asOf: g.current?.asOf || null, href: `/control?view=goals&goal=${g.id}` };
    }) },
    actions: { status: actions ? "ready" : "unavailable", items: actions?.items || [], recent: actions?.recent || [] },
  };
}
