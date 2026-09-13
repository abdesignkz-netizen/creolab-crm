import { createApiClient } from "@creolab/api-client";

export const api = createApiClient({
  baseUrl: "",
  getTenantId: () => localStorage.getItem("crm_tenant"),
});

export function setTenant(id: string) {
  localStorage.setItem("crm_tenant", id);
}

export async function downloadAvrExcel(documentId: string) {
  const { blob, filename } = await api.downloadElectronicDocumentExcel(documentId);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
