import { createApiClient } from "@creolab/api-client";

export const api = createApiClient({
  baseUrl: "",
  getTenantId: () => localStorage.getItem("crm_tenant"),
  onUnknownTenant: () => localStorage.removeItem("crm_tenant"),
  onFeatureRequired: (info) => {
    window.dispatchEvent(new CustomEvent("basqar:paywall", { detail: info }));
  },
});

export function setTenant(id: string) {
  localStorage.setItem("crm_tenant", id);
}

export function clearTenant() {
  localStorage.removeItem("crm_tenant");
}

export async function downloadAvrExcel(documentId: string) {
  const { blob, filename } = await api.downloadElectronicDocumentExcel(documentId);
  triggerDownload(blob, filename);
}

export async function downloadAvrPdf(documentId: string) {
  const { blob, filename } = await api.downloadElectronicDocumentPdf(documentId);
  triggerDownload(blob, filename);
}

export async function downloadInvoicePdf(invoiceId: string, stamped = false) {
  const { blob, filename } = await api.downloadInvoicePdf(invoiceId, { stamped });
  triggerDownload(blob, filename);
}

export async function downloadContractFile(contractId: string, format: "pdf" | "docx" = "pdf") {
  const { blob, filename } = await api.downloadContractFile(contractId, format);
  triggerDownload(blob, filename);
}

export async function downloadContractPreview(previewId: string, format: "pdf" | "docx" = "pdf") {
  const { blob, filename } = await api.downloadContractPreview(previewId, format);
  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
