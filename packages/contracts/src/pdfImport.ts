export type PdfImportParty = {
  name: string; bin: string; legalAddress: string; iban: string; bankName: string; bik: string; directorName: string;
};
export type PdfImportDraft = {
  kind: "CONTRACT" | "INVOICE";
  number: string; date: string; subject: string;
  seller: PdfImportParty; buyer: PdfImportParty;
  contactName: string; contactPhone: string;
  paymentTerms: string; completionTerms: string;
  items: Array<{ name: string; quantity: number; unitPrice: number; vatRate: number; unit: string }>;
  detectedTotal: number | null;
};
export type PdfImportPreview = {
  importId: string; fileName: string; sha256: string; pageCount: number; usedOcr: boolean;
  draft: PdfImportDraft; warnings: string[]; pages: Array<{ page: number; text: string }>;
};
