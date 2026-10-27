export * from "./entitlements.ts";
export * from "./pricingCatalog.ts";
export * from "./amountWords.ts";
export * from "./duration.ts";
export * from "./esfMeasureUnits.ts";
export * from "./esfNcaLayer.ts";
export * from "./kzTaxId.ts";
export * from "./phone.ts";
export * from "./roles.ts";
export * from "./schemas.ts";
export * from "./control.ts";
export * from "./taskBoard.ts";
export * from "./onboarding.ts";
export * from "./aiManagerSetup.ts";
export * from "./aiKnowledgeImport.ts";

export const PAGE_SIZE_DEFAULT = 30;
export * from "./controlNotifications.ts";
export const PAGE_SIZE_MAX = 100;
export { INVOICE_PAYMENT_KIND_LABEL } from "./pdfImport.ts";
export type { PdfImportParty, PdfImportDraft, PdfImportPreview, InvoiceImportMatches } from "./pdfImport.ts";
export { avrEditorSchema, avrEditorAmounts, type AvrEditorInput } from "./avrEditor.ts";
export {
  invoiceEditorSchema,
  updateInvoiceDraftSchema,
  invoicePayableTotals,
  inferInvoicePaymentPercent,
  scaleInvoiceMoney,
  type InvoiceEditorInput,
} from "./invoiceEditor.ts";
export {
  parseCompanyRequisitesSchema,
  companyRequisitesDraftSchema,
  type CompanyRequisitesDraft,
  type ParseCompanyRequisitesInput,
} from "./companyRequisites.ts";

export * from "./documentSignMeta.ts";

export { systemText, systemMessage, kkSystemMessages } from "./systemLocale.ts";
export { publicFormKey, publicFormKeyAliases, BASQAR_SITE_FORM_KEY } from "./publicFormBranding.ts";
export { taskTitlePresentation, localizedTaskTitle, type TaskTitlePresentation } from "./taskPresentation.ts";

export * from "./salesProcess.ts";

export * from "./aiBusinessScenarios.ts";
export type { CrmReviewEntity, CrmReviewField, CrmReviewValue, CrmReviewStatus, CrmReviewBlock, CrmReviewItem, CrmReviewList, CrmCalendarEffect, CrmProcessQueue } from "./crmReview.ts";
export type { MessageDeliveryPart, MessageRetryBlock, MessageDeliveryReview, MessageDeliveryReconciliation } from "./messageDelivery.ts";
export { crmMoneySchema, crmCommercialFactSchema, CRM_COMMERCIAL_FIELDS, readCrmCommercial } from "./crmCommercial.ts";
export type { CrmMoney, CrmCommercialField, CrmCommercialFact, CrmCommercialValues } from "./crmCommercial.ts";
export * from "./processCalendar.ts";
export * from "./processLocale.ts";
