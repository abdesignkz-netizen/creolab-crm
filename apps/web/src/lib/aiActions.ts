import type { ActionPlanInput, ActionRunView, ActionRunSummary } from "@creolab/contracts";
import { api } from "./api";

const path = "/api/v1/workspace/ai-actions";
export type ActionOptions = { members: Array<{ id: string; name: string }>; selfId: string; timezone: string; allowed: string[]; blockedReason: string | null };
export type ActionChoice = { id: string; label: string };
// This client is loaded with the plans panel, keeping the initial app bundle small.
export const actionApi = {
  list: (offset = 0) => api.request<{ items: ActionRunSummary[]; total: number; offset: number; limit: number }>(`${path}?offset=${offset}`),
  get: (id: string) => api.request<ActionRunView>(`${path}/${encodeURIComponent(id)}`),
  options: () => api.request<ActionOptions>(`${path}/options`),
  choices: (kind: "task" | "contact", q: string) => api.request<{ items: ActionChoice[] }>(`${path}/options?${new URLSearchParams({ kind, q })}`),
  preview: (body: ActionPlanInput) => api.request<ActionRunView>(path, { method: "POST", body: JSON.stringify(body) }),
  confirm: (run: ActionRunView, requestId: string) => api.request<ActionRunView>(`${path}/${run.id}/confirm`, { method: "POST", body: JSON.stringify({ requestId, planHash: run.planHash, confirmed: true }) }),
  cancel: (run: ActionRunView, requestId: string) => api.request<ActionRunView>(`${path}/${run.id}/cancel`, { method: "POST", body: JSON.stringify({ requestId }) }),
};
