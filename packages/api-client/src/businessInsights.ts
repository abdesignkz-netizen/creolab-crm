import type { BusinessInsightList, BusinessInsightDetail, BusinessInsightView, BusinessInsightRule, BusinessInsightState, InsightDecision } from "@creolab/contracts";
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Loaded with the analytical panel, not the application's initial bundle. */
export function createBusinessInsightsApi(request: Request) {
  const path = "/api/v1/workspace/intelligence";
  return {
    list: (query: { kind?: "insight" | "opportunity"; state?: BusinessInsightState | "all"; rule?: BusinessInsightRule; cursor?: string } = {}) => {
      const params = new URLSearchParams(); Object.entries(query).forEach(([key, value]) => { if (value) params.set(key, value); });
      return request<BusinessInsightList>(`${path}?${params}`);
    },
    get: (id: string) => request<BusinessInsightDetail>(`${path}/${encodeURIComponent(id)}`),
    refresh: (insightId?: string) => request<BusinessInsightList & { advanced: boolean }>(`${path}/refresh`, { method: "POST", body: JSON.stringify({ insightId }) }),
    decide: (id: string, decision: "acknowledge" | "dismiss", body: InsightDecision) => request<BusinessInsightView>(`${path}/${encodeURIComponent(id)}/${decision}`, { method: "POST", body: JSON.stringify(body) }),
  };
}
