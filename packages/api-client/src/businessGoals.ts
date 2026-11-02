import type { BusinessGoalView, BusinessGoalDetail, GoalOptions, GoalCreate, GoalChange } from "@creolab/contracts";
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
export function createBusinessGoalsApi(request: Request) {
  const path = "/api/v1/workspace/goals";
  return {
    list: (state = "active", cursor?: string) => request<{ items: BusinessGoalView[]; nextCursor: string | null; canEdit: boolean }>(`${path}?${new URLSearchParams({ state, ...(cursor ? { cursor } : {}) })}`),
    options: () => request<GoalOptions>(`${path}/options`),
    get: (id: string) => request<BusinessGoalDetail>(`${path}/${encodeURIComponent(id)}`),
    create: (body: GoalCreate) => request<BusinessGoalDetail>(path, { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, body: GoalChange) => request<BusinessGoalDetail>(`${path}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
    refresh: (id: string, requestId: string) => request<BusinessGoalDetail>(`${path}/${encodeURIComponent(id)}/refresh`, { method: "POST", body: JSON.stringify({ requestId }) }),
    tasks: (q = "") => request<{ items: Array<{ id: string; title: string }> }>(`${path}/tasks?${new URLSearchParams({ q })}`),
    link: (id: string, body: { requestId: string; version: number; taskId: string; remove: boolean }) => request<BusinessGoalDetail>(`${path}/${encodeURIComponent(id)}/initiatives`, { method: "POST", body: JSON.stringify(body) }),
  };
}
