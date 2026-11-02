import type { ArchitectAnswers, ArchitectPreview, ArchitectSavedDraft, ArchitectSaveInput, ArchitectState, ArchitectApplyReview, ArchitectApplyInput, ActionRunView } from "@creolab/contracts";
import { api } from "./api";

const path = "/api/v1/workspace/onboarding/architect";
export const architectApi = {
  get: () => api.request<ArchitectState>(path),
  preview: (answers: ArchitectAnswers) => api.request<ArchitectPreview>(`${path}/preview`, { method: "POST", body: JSON.stringify({ answers }) }),
  save: (body: ArchitectSaveInput) => api.request<ArchitectSavedDraft>(`${path}/draft`, { method: "PUT", body: JSON.stringify(body) }),
  review: (id: string, revision: number) => api.request<ArchitectApplyReview>(`${path}/${encodeURIComponent(id)}/apply-preview`, { method: "POST", body: JSON.stringify({ revision }) }),
  apply: (id: string, body: ArchitectApplyInput) => api.request<ActionRunView>(`${path}/${encodeURIComponent(id)}/apply`, { method: "POST", body: JSON.stringify(body) }),
};
