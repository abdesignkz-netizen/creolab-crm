import type { BusinessExperimentSummary, BusinessExperimentDetail, ExperimentOptions, ExperimentSave, ExperimentOperation } from "@creolab/contracts";
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
export function createBusinessExperimentsApi(request: Request) {
  const path = "/api/v1/workspace/experiments";
  return {
    list: (state = "active", cursor?: string) => request<{ items: BusinessExperimentSummary[]; canEdit: boolean; nextCursor: string | null }>(`${path}?${new URLSearchParams({ state, ...(cursor ? { cursor } : {}) })}`),
    options: () => request<ExperimentOptions>(`${path}/options`),
    get: (id: string) => request<BusinessExperimentDetail>(`${path}/${encodeURIComponent(id)}`),
    save: (id: string | null, body: ExperimentSave) => request<BusinessExperimentDetail>(id ? `${path}/${encodeURIComponent(id)}` : path, { method: id ? "PATCH" : "POST", body: JSON.stringify(body) }),
    operate: (id: string, action: "approve" | "stop" | "result" | "note", body: ExperimentOperation) => request<BusinessExperimentDetail>(`${path}/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify(body) }),
    tasks: (q: string) => request<{ items: Array<{ id: string; title: string }> }>(`${path}/tasks?${new URLSearchParams({ q })}`),
  };
}
