import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { readEsfConfig } from "../integrations/esf/EsfConfig.ts";
import { previewAvrForEsf, sendAvrToEsf } from "../integrations/esf/EsfGateway.ts";
import { previewInvoiceForEsf, sendInvoiceToEsf } from "../integrations/esf/invoice/EsfInvoiceGateway.ts";
import { isAvrSource } from "../integrations/esf/avr/EsfAvrAdapter.ts";
import { isEsfInvoiceSource } from "../integrations/esf/invoice/EsfInvoiceAdapter.ts";
import { syncElectronicDocumentById } from "./esfStatusSyncService.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { serializeDealItem } from "./dealItemService.ts";
import { serializeElectronicDocument } from "./documentDraftService.ts";
import { mapAvrSource, type AvrSourceSnapshot } from "./avrMapper.ts";
import { mapEsfInvoiceSource, type EsfInvoiceSourceSnapshot } from "./esfInvoiceMapper.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function requireManageDocuments(auth: AuthContext) {
  if (!can(auth, "manage_documents")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для документов");
  }
}

function requireSendEsf(auth: AuthContext) {
  if (!can(auth, "send_esf")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для отправки в ИС ЭСФ");
  }
}

async function loadDocument(prisma: PrismaClient, tenantId: string, documentId: string) {
  const document = await prisma.electronicDocument.findFirst({
    where: { id: documentId, tenantId },
  });
  if (!document) throw new ApiError(404, "not_found", "Документ не найден");
  if (document.type !== "AVR" && document.type !== "ESF") {
    throw new ApiError(422, "unsupported_document", "ИС ЭСФ принимает только АВР и ЭСФ");
  }
  return document;
}

async function sourceForDocument(
  prisma: PrismaClient,
  tenantId: string,
  document: {
    dealId: string;
    documentDate: Date;
    sourceDataJson: unknown;
    contractId: string | null;
    invoiceId: string | null;
  },
): Promise<AvrSourceSnapshot> {
  if (isAvrSource(document.sourceDataJson)) return document.sourceDataJson;
  const deal = await prisma.deal.findFirst({
    where: { id: document.dealId, tenantId },
    include: { items: { orderBy: { sortOrder: "asc" } }, company: true },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const [profile, tenant, contract, invoice] = await Promise.all([
    prisma.tenantLegalProfile.findUnique({ where: { tenantId } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    document.contractId
      ? prisma.contract.findFirst({ where: { id: document.contractId, tenantId } })
      : Promise.resolve(null),
    document.invoiceId
      ? prisma.invoice.findFirst({ where: { id: document.invoiceId, tenantId } })
      : Promise.resolve(null),
  ]);
  return mapAvrSource({
    documentDate: document.documentDate,
    currency: deal.currency || "KZT",
    deal,
    items: deal.items.map(serializeDealItem),
    profile,
    tenantName: tenant?.name || null,
    company: deal.company,
    contract,
    invoice,
  });
}

async function invoiceSourceForDocument(
  prisma: PrismaClient,
  tenantId: string,
  document: {
    dealId: string;
    number: string;
    documentDate: Date;
    sourceDataJson: unknown;
    contractId: string | null;
    invoiceId: string | null;
  },
): Promise<EsfInvoiceSourceSnapshot> {
  if (isEsfInvoiceSource(document.sourceDataJson)) return document.sourceDataJson;
  const deal = await prisma.deal.findFirst({
    where: { id: document.dealId, tenantId },
    include: { items: { orderBy: { sortOrder: "asc" } }, company: true },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const [profile, tenant, contract, invoice] = await Promise.all([
    prisma.tenantLegalProfile.findUnique({ where: { tenantId } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    document.contractId
      ? prisma.contract.findFirst({ where: { id: document.contractId, tenantId } })
      : Promise.resolve(null),
    document.invoiceId
      ? prisma.invoice.findFirst({ where: { id: document.invoiceId, tenantId } })
      : Promise.resolve(null),
  ]);
  return mapEsfInvoiceSource({
    documentDate: document.documentDate,
    number: document.number,
    currency: deal.currency || "KZT",
    deal,
    items: deal.items.map(serializeDealItem),
    defaultCatalogTruId: profile?.defaultCatalogTruId,
    profile,
    tenantName: tenant?.name || null,
    company: deal.company,
    contract,
    invoice,
  });
}

async function extrasForTenant(prisma: PrismaClient, tenantId: string, number: string) {
  const profile = await prisma.tenantLegalProfile.findUnique({ where: { tenantId } });
  return {
    number,
    sellerBank: {
      bank: profile?.bankName || "",
      bik: profile?.bik || "",
      iik: profile?.iban || "",
    },
  };
}

async function storeXml(tenantId: string, documentId: string, fileName: string, xml: string) {
  const storageKey = path.posix.join(tenantId, "electronic-documents", documentId, fileName);
  const abs = resolveUploadPath(storageKey);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, xml, "utf8");
  return storageKey;
}

export async function previewAvrEsf(prisma: PrismaClient, auth: AuthContext, documentId: string) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const tid = membership.tenantId;
  await requireDocumentsEnabled(prisma, tid);
  const document = await loadDocument(prisma, tid, documentId);
  if (document.type === "ESF") return previewEsfInvoice(prisma, tid, document);
  const source = await sourceForDocument(prisma, tid, document);
  const extras = await extrasForTenant(prisma, tid, document.number);
  const preview = previewAvrForEsf(source, extras);
  const xmlStorageKey = await storeXml(tid, document.id, "awp-v1.xml", preview.xml);
  const updated = await prisma.electronicDocument.update({
    where: { id: document.id },
    data: {
      xmlStorageKey,
      errorCode: preview.validation.valid ? null : "esf_xsd_invalid",
      errorMessage: preview.validation.valid ? null : preview.validation.issues[0]?.message || "XSD",
    },
  });
  return {
    document: serializeElectronicDocument(updated),
    xml: preview.xml,
    version: preview.version,
    validation: preview.validation,
    signing: preview.signing,
    session: preview.session,
    provider: preview.provider,
    liveSendAllowed: preview.liveSendAllowed,
    esfEnv: preview.esfEnv,
    endpoints: preview.endpoints,
    operations: preview.operations,
    envelopes: preview.envelopes,
  };
}

export async function sendAvrEsf(prisma: PrismaClient, auth: AuthContext, documentId: string) {
  const membership = requireTenant(auth);
  requireSendEsf(auth);
  const tid = membership.tenantId;
  const flags = await requireDocumentsEnabled(prisma, tid);
  if (!flags.esfIntegrationEnabled) {
    throw new ApiError(403, "esf_disabled", "Интеграция с ИС ЭСФ выключена в настройках");
  }
  const document = await loadDocument(prisma, tid, documentId);
  if (document.type === "ESF") return sendEsfInvoice(prisma, auth, tid, document);
  if (document.status === "DRAFT") {
    throw new ApiError(422, "avr_not_validated", "Сначала проверьте АВР");
  }
  if (document.status === "SENT" || document.status === "ACCEPTED") {
    if (document.externalId) {
      return {
        document: serializeElectronicDocument(document),
        externalId: document.externalId,
        externalStatus: document.externalStatus,
        reused: true,
        operations: ["createSession", "uploadAwp", "queryAwpStatusById"] as const,
      };
    }
    throw new ApiError(422, "avr_immutable", "АВР уже отправлен в ИС ЭСФ");
  }
  const source = await sourceForDocument(prisma, tid, document);
  const extras = await extrasForTenant(prisma, tid, document.number);
  const result = await sendAvrToEsf(source, extras);
  if (!result.ok) {
    await prisma.electronicDocument.update({
      where: { id: document.id },
      data: {
        xmlStorageKey: await storeXml(tid, document.id, "awp-v1.xml", result.preview.xml),
        errorCode: result.code,
        errorMessage: result.code,
      },
    });
    throw new ApiError(422, result.code, esfSendMessage(result.code), undefined, {
      validation: result.preview.validation,
      signing: result.preview.signing,
      liveSendAllowed: result.preview.liveSendAllowed,
      operations: result.preview.operations,
      envelopes: result.preview.envelopes,
      errors: "errors" in result ? result.errors : undefined,
    });
  }

  const xmlStorageKey = await storeXml(tid, document.id, "awp-v1.xml", result.preview.xml);
  const signedXmlStorageKey = result.signature
    ? await storeXml(tid, document.id, "awp-v1.signature.txt", result.signature)
    : document.signedXmlStorageKey;
  const officialStatus = result.externalStatus || "NOT_VIEWED";
  const accepted = officialStatus === "CONFIRMED";
  const updated = await prisma.electronicDocument.update({
    where: { id: document.id },
    data: {
      status: accepted ? "ACCEPTED" : "SENT",
      signedAt: document.signedAt || new Date(),
      sentAt: new Date(),
      acceptedAt: accepted ? new Date() : document.acceptedAt,
      xmlStorageKey,
      signedXmlStorageKey,
      externalSystem: "ESF_AWP",
      externalId: result.externalId,
      externalNumber: result.externalNumber || null,
      externalStatus: officialStatus,
      errorCode: null,
      errorMessage: null,
    },
  });
  await prisma.auditEvent.create({
    data: {
      tenantId: tid,
      actorUserId: auth.user.id,
      action: "electronic_document.esf_send",
      entityType: "electronic_document",
      entityId: updated.id,
      changesJson: { externalId: result.externalId, externalStatus: officialStatus, provider: result.provider || null },
    },
  });
  await prisma.outboxEvent.create({
    data: {
      tenantId: tid,
      type: "avr.sent",
      entityType: "electronic_document",
      entityId: updated.id,
      payloadJson: {
        documentId: updated.id,
        dealId: updated.dealId,
        externalId: result.externalId,
        externalStatus: officialStatus,
      },
    },
  });
  return {
    document: serializeElectronicDocument(updated),
    externalId: result.externalId,
    externalStatus: officialStatus,
    provider: result.provider || readEsfConfig().provider,
    operations: result.preview.operations,
    reused: false,
  };
}

export async function refreshAvrEsf(prisma: PrismaClient, auth: AuthContext, documentId: string) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const tid = membership.tenantId;
  await requireDocumentsEnabled(prisma, tid);
  const document = await loadDocument(prisma, tid, documentId);
  return syncElectronicDocumentById(prisma, tid, document.id);
}

async function previewEsfInvoice(
  prisma: PrismaClient,
  tenantId: string,
  document: { id: string; dealId: string; number: string; documentDate: Date; sourceDataJson: unknown; contractId: string | null; invoiceId: string | null },
) {
  const source = await invoiceSourceForDocument(prisma, tenantId, document);
  const preview = previewInvoiceForEsf(source);
  const xmlStorageKey = await storeXml(tenantId, document.id, "invoice-v2.xml", preview.xml);
  const updated = await prisma.electronicDocument.update({
    where: { id: document.id },
    data: {
      xmlStorageKey,
      errorCode: preview.validation.valid ? null : "esf_xsd_invalid",
      errorMessage: preview.validation.valid ? null : preview.validation.issues[0]?.message || "XSD",
    },
  });
  return {
    document: serializeElectronicDocument(updated),
    xml: preview.xml,
    containerXml: preview.containerXml,
    version: preview.version,
    validation: preview.validation,
    signing: preview.signing,
    session: preview.session,
    provider: preview.provider,
    liveSendAllowed: preview.liveSendAllowed,
    esfEnv: preview.esfEnv,
    endpoints: preview.endpoints,
    operations: preview.operations,
    envelopes: preview.envelopes,
  };
}

async function sendEsfInvoice(
  prisma: PrismaClient,
  auth: AuthContext,
  tenantId: string,
  document: {
    id: string;
    dealId: string;
    number: string;
    status: string;
    documentDate: Date;
    sourceDataJson: unknown;
    contractId: string | null;
    invoiceId: string | null;
    externalId: string | null;
    externalStatus: string | null;
    signedAt: Date | null;
    acceptedAt: Date | null;
    signedXmlStorageKey: string | null;
  },
) {
  if (document.status === "DRAFT") {
    throw new ApiError(422, "esf_not_validated", "Сначала проверьте ЭСФ");
  }
  if (document.status === "SENT" || document.status === "ACCEPTED") {
    if (document.externalId) {
      return {
        document: serializeElectronicDocument(document as never),
        externalId: document.externalId,
        externalStatus: document.externalStatus,
        reused: true,
        operations: ["createSession", "syncInvoice", "queryInvoiceById"] as const,
      };
    }
    throw new ApiError(422, "esf_immutable", "ЭСФ уже отправлен в ИС ЭСФ");
  }
  const avr = await prisma.electronicDocument.findFirst({
    where: { tenantId, dealId: document.dealId, type: "AVR", externalId: { not: null } },
  });
  if (!avr?.externalId) {
    throw new ApiError(422, "avr_not_sent", "Сначала отправьте АВР в ИС ЭСФ");
  }
  const source = await invoiceSourceForDocument(prisma, tenantId, document);
  const result = await sendInvoiceToEsf(source);
  if (!result.ok) {
    await prisma.electronicDocument.update({
      where: { id: document.id },
      data: {
        xmlStorageKey: await storeXml(tenantId, document.id, "invoice-v2.xml", result.preview.xml),
        errorCode: result.code,
        errorMessage: result.code,
      },
    });
    throw new ApiError(422, result.code, esfSendMessage(result.code, "ESF"), undefined, {
      validation: result.preview.validation,
      signing: result.preview.signing,
      liveSendAllowed: result.preview.liveSendAllowed,
      operations: result.preview.operations,
      envelopes: result.preview.envelopes,
      errors: "errors" in result ? result.errors : undefined,
    });
  }

  const xmlStorageKey = await storeXml(tenantId, document.id, "invoice-v2.xml", result.preview.xml);
  const signedXmlStorageKey = result.signature
    ? await storeXml(tenantId, document.id, "invoice-v2.signature.txt", result.signature)
    : document.signedXmlStorageKey;
  const officialStatus = result.externalStatus || "CREATED";
  const accepted = officialStatus === "DELIVERED";
  const updated = await prisma.electronicDocument.update({
    where: { id: document.id },
    data: {
      status: accepted ? "ACCEPTED" : "SENT",
      signedAt: document.signedAt || new Date(),
      sentAt: new Date(),
      acceptedAt: accepted ? new Date() : document.acceptedAt,
      xmlStorageKey,
      signedXmlStorageKey,
      externalSystem: "ESF_INVOICE",
      externalId: result.externalId,
      externalNumber: result.externalNumber || null,
      externalStatus: officialStatus,
      errorCode: null,
      errorMessage: null,
    },
  });
  await prisma.auditEvent.create({
    data: {
      tenantId,
      actorUserId: auth.user.id,
      action: "electronic_document.esf_send",
      entityType: "electronic_document",
      entityId: updated.id,
      changesJson: { type: "ESF", externalId: result.externalId, externalStatus: officialStatus, provider: result.provider || null },
    },
  });
  await prisma.outboxEvent.create({
    data: {
      tenantId,
      type: "esf.sent",
      entityType: "electronic_document",
      entityId: updated.id,
      payloadJson: {
        documentId: updated.id,
        dealId: updated.dealId,
        externalId: result.externalId,
        externalStatus: officialStatus,
      },
    },
  });
  return {
    document: serializeElectronicDocument(updated),
    externalId: result.externalId,
    externalStatus: officialStatus,
    provider: result.provider || readEsfConfig().provider,
    operations: result.preview.operations,
    reused: false,
  };
}

function esfSendMessage(code: string, kind: "AVR" | "ESF" = "AVR") {
  if (code === "kalkan_adapter_missing" || code === "legacy_server_p12_forbidden") {
    return kind === "ESF"
      ? "Подпись ЭСФ XML на сервере через .p12 выключена. Нужен NCALayer на компьютере пользователя."
      : "Подпись АВР XML на сервере через .p12 выключена. Нужен NCALayer на компьютере пользователя.";
  }
  if (code === "esf_send_not_configured") {
    return "Живая отправка в ИС ЭСФ выключена. Нужны ESF_ENV=test|local и ESF_ALLOW_LIVE_SEND=1.";
  }
  if (code === "esf_xsd_invalid") {
    return kind === "ESF" ? "XML ЭСФ не проходит official InvoiceV2 XSD" : "XML АВР не проходит official AwpV1 XSD";
  }
  return kind === "ESF" ? "Не удалось отправить ЭСФ в ИС ЭСФ" : "Не удалось отправить АВР в ИС ЭСФ";
}
