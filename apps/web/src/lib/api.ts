import { createApiClient } from "@creolab/api-client";

export const api = createApiClient({
  baseUrl: "",
  getTenantId: () => localStorage.getItem("crm_tenant"),
});

export function setTenant(id: string) {
  localStorage.setItem("crm_tenant", id);
}
