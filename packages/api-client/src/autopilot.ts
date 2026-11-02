import type { AutopilotConfig, AutopilotView, AutopilotPreview } from "@creolab/contracts";
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
export function createAutopilotApi(request: Request) {
  const base = "/api/v1/settings/autopilot";
  type Op = { requestId: string; version: number; confirmed: true };
  return {
    get: (cursor?: string) => request<AutopilotView>(`${base}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    preview: (config: AutopilotConfig) => request<AutopilotPreview>(`${base}/preview`, { method: "POST", body: JSON.stringify(config) }),
    save: (body: { requestId: string; version: number; config: AutopilotConfig }) => request<AutopilotView>(base, { method: "PUT", body: JSON.stringify(body) }),
    operation: (op: "enable" | "pause", body: Op) => request<AutopilotView>(`${base}/${op}`, { method: "POST", body: JSON.stringify(body) }),
    caseOperation: (id: string, op: "start" | "stop", body: Op) => request<{ ok: true }>(`${base}/cases/${encodeURIComponent(id)}/${op}`, { method: "POST", body: JSON.stringify(body) }),
  };
}
