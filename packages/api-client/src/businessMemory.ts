import type { BusinessDecisionView, BusinessDecisionDetail, DecisionSave, BusinessMemoryContext } from "@creolab/contracts";
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
export function createBusinessMemoryApi(request: Request) {
  const path = "/api/v1/workspace/decisions";
  return {
    list: (state = "all", q = "", cursor?: string) => request<{ items: BusinessDecisionView[]; nextCursor: string | null; canEdit: boolean }>(`${path}?${new URLSearchParams({ state, q, ...(cursor ? { cursor } : {}) })}`),
    get: (id: string) => request<BusinessDecisionDetail>(`${path}/${encodeURIComponent(id)}`),
    context: () => request<BusinessMemoryContext>(`${path}/context`),
    options: (kind = "manual", q = "") => request<{ sources: Array<{ id: string; title: string }>; canEdit: boolean; timezone: string }>(`${path}/options?${new URLSearchParams({ kind, q })}`),
    save: (id: string | null, body: DecisionSave) => request<BusinessDecisionDetail>(id ? `${path}/${encodeURIComponent(id)}` : path, { method: id ? "PATCH" : "POST", body: JSON.stringify(body) }),
    operation: (id: string, operation: "approve" | "revoke" | "erase", body: { requestId: string; version: number; confirmed: true; replacesId?: string }) => request<BusinessDecisionDetail>(`${path}/${encodeURIComponent(id)}/${operation}`, { method: "POST", body: JSON.stringify(body) }),
  };
}
