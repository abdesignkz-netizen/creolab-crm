import type { EsfInvoiceSourceSnapshot } from "../../../services/esfInvoiceMapper.ts";
import { ESF_OFFICIAL, readEsfConfig } from "../EsfConfig.ts";
import { mockSyncInvoice } from "../EsfMock.ts";
import { closeEsfSession, createEsfSession, sessionReadiness } from "../EsfSessionService.ts";
import { signInvoiceXml, signingReadiness } from "../EsfSignatureService.ts";
import {
  buildCreateSessionEnvelope,
  buildSyncInvoiceEnvelope,
  parseSoapFault,
  parseSyncInvoiceResult,
  postSoap,
} from "../EsfSoap.ts";
import { queryInvoiceById } from "../sync/EsfDocumentSyncService.ts";
import { mapInvoiceToEsfXml } from "./EsfInvoiceAdapter.ts";

export function previewInvoiceForEsf(source: EsfInvoiceSourceSnapshot) {
  const config = readEsfConfig();
  const mapped = mapInvoiceToEsfXml(source);
  const createSession = buildCreateSessionEnvelope({
    tin: source.seller.bin || source.seller.iin || config.tin || "TIN",
    x509Certificate: "[ESF_AUTH_CERT_PEM]",
    sourceType: ESF_OFFICIAL.sourceTypeOther,
  });
  const syncInvoice = buildSyncInvoiceEnvelope({
    sessionId: "[sessionId]",
    invoiceBody: mapped.xml,
    signature: "[LocalService.generateSignature]",
    x509Certificate: "[ESF_SIGN_CERT_PEM]",
  });
  return {
    ...mapped,
    signing: signingReadiness(config),
    session: sessionReadiness(config),
    provider: config.provider,
    liveSendAllowed: config.liveSendAllowed,
    esfEnv: config.esfEnv,
    endpoints: {
      sessionUrl: config.sessionUrl,
      invoiceUploadUrl: config.invoiceUploadUrl,
      invoiceUrl: config.invoiceUrl,
      localServiceUrl: `${config.localServiceUrl}/LocalService`,
    },
    envelopes: {
      createSession,
      syncInvoice,
    },
    operations: ["createSession", "syncInvoice", "queryInvoiceById"] as const,
  };
}

export async function sendInvoiceToEsf(source: EsfInvoiceSourceSnapshot) {
  const config = readEsfConfig();
  const preview = previewInvoiceForEsf(source);
  if (!preview.validation.valid) {
    return { ok: false as const, code: "esf_xsd_invalid", preview, externalId: "", externalStatus: "" };
  }
  const signed = await signInvoiceXml(preview.xml, config);
  if (!signed.ok) {
    return {
      ok: false as const,
      code: signed.code,
      preview: { ...preview, signing: signed },
      externalId: "",
      externalStatus: "",
      externalNumber: "",
    };
  }
  if (config.provider === "mock") {
    const uploaded = mockSyncInvoice({ xml: preview.xml, num: source.outgoingNum });
    if (!uploaded.ok) {
      return {
        ok: false as const,
        code: "esf_upload_declined",
        preview: { ...preview, signing: signed },
        externalId: "",
        externalStatus: "",
        externalNumber: "",
        errors: [],
      };
    }
    return {
      ok: true as const,
      code: "sent",
      preview: { ...preview, signing: signed, provider: "mock" as const },
      externalId: uploaded.invoiceId,
      externalStatus: uploaded.status,
      externalNumber: uploaded.registrationNumber,
      signature: signed.signature,
      provider: "mock" as const,
    };
  }
  if (!config.liveSendAllowed) {
    return {
      ok: false as const,
      code: "esf_send_not_configured",
      preview: {
        ...preview,
        signing: signed,
        envelopes: {
          ...preview.envelopes,
          syncInvoice: buildSyncInvoiceEnvelope({
            sessionId: "[sessionId]",
            invoiceBody: preview.xml,
            signature: signed.signature,
            x509Certificate: config.signCertificatePem || "[ESF_SIGN_CERT_PEM]",
          }),
        },
      },
      externalId: "",
      externalStatus: "",
    };
  }
  const session = await createEsfSession(config);
  if (!session.ok) {
    return { ok: false as const, code: session.code, preview, externalId: "", externalStatus: "" };
  }
  try {
    const envelope = buildSyncInvoiceEnvelope({
      sessionId: session.sessionId,
      invoiceBody: preview.xml,
      signature: signed.signature,
      x509Certificate: config.signCertificatePem || config.authCertificatePem,
    });
    const response = await postSoap(config.invoiceUploadUrl, envelope);
    const fault = parseSoapFault(response.text);
    const uploaded = parseSyncInvoiceResult(response.text);
    if (uploaded.declined || !uploaded.invoiceId) {
      return {
        ok: false as const,
        code: "esf_upload_declined",
        preview,
        externalId: "",
        externalStatus: "",
        errors: uploaded.errors,
        message: fault?.description || uploaded.errors[0]?.text || "syncInvoice declined",
      };
    }
    const status = await queryInvoiceById(session.sessionId, uploaded.invoiceId, config);
    return {
      ok: true as const,
      code: "sent",
      preview,
      externalId: uploaded.invoiceId,
      externalStatus: status.status || "CREATED",
      externalNumber: status.registrationNumber || uploaded.num,
      signature: signed.signature,
      provider: "live" as const,
    };
  } finally {
    await closeEsfSession(session.sessionId, config);
  }
}
