import type { AvrSourceSnapshot } from "../../services/avrMapper.ts";
import { mapAvrSnapshotToAwpXml, type AwpBuildExtras } from "./avr/EsfAvrAdapter.ts";
import { ESF_OFFICIAL, readEsfConfig } from "./EsfConfig.ts";
import { mockUploadAwp } from "./EsfMock.ts";
import { createEsfSession, closeEsfSession, sessionReadiness } from "./EsfSessionService.ts";
import { signAwpXml, signingReadiness } from "./EsfSignatureService.ts";
import {
  buildCreateSessionEnvelope,
  buildUploadAwpEnvelope,
  parseAwpUploadResult,
  parseSoapFault,
  postSoap,
} from "./EsfSoap.ts";
import { queryAwpStatusById } from "./sync/EsfDocumentSyncService.ts";

export function previewAvrForEsf(source: AvrSourceSnapshot, extras: AwpBuildExtras = {}) {
  const config = readEsfConfig();
  const mapped = mapAvrSnapshotToAwpXml(source, extras);
  const createSession = buildCreateSessionEnvelope({
    tin: source.seller.bin || source.seller.iin || config.tin || "TIN",
    x509Certificate: "[ESF_AUTH_CERT_PEM]",
    sourceType: ESF_OFFICIAL.sourceTypeOther,
  });
  const uploadAwp = buildUploadAwpEnvelope({
    sessionId: "[sessionId]",
    awpBody: mapped.xml,
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
      awpUrl: config.awpUrl,
      localServiceUrl: `${config.localServiceUrl}/LocalService`,
    },
    envelopes: {
      createSession,
      uploadAwp,
    },
    operations: ["createSession", "uploadAwp", "queryAwpStatusById"] as const,
  };
}

export async function sendAvrToEsf(source: AvrSourceSnapshot, extras: AwpBuildExtras = {}) {
  const config = readEsfConfig();
  const preview = previewAvrForEsf(source, extras);
  if (!preview.validation.valid) {
    return { ok: false as const, code: "esf_xsd_invalid", preview, externalId: "", externalStatus: "" };
  }
  const signed = await signAwpXml(preview.xml, config);
  if (!signed.ok) {
    return { ok: false as const, code: signed.code, preview: { ...preview, signing: signed }, externalId: "", externalStatus: "", externalNumber: "" };
  }
  if (config.provider === "mock") {
    const uploaded = mockUploadAwp({ xml: preview.xml, number: extras.number || "AVR" });
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
      externalId: uploaded.awpId,
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
          uploadAwp: buildUploadAwpEnvelope({
            sessionId: "[sessionId]",
            awpBody: preview.xml,
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
    const envelope = buildUploadAwpEnvelope({
      sessionId: session.sessionId,
      awpBody: preview.xml,
      signature: signed.signature,
      x509Certificate: config.signCertificatePem || config.authCertificatePem,
    });
    const response = await postSoap(config.awpUrl, envelope);
    const fault = parseSoapFault(response.text);
    const uploaded = parseAwpUploadResult(response.text);
    if (uploaded.declined || !uploaded.awpId) {
      return {
        ok: false as const,
        code: "esf_upload_declined",
        preview,
        externalId: "",
        externalStatus: "",
        errors: uploaded.errors,
        message: fault?.description || uploaded.errors[0]?.text || "uploadAwp declined",
      };
    }
    const status = await queryAwpStatusById(session.sessionId, uploaded.awpId, config);
    return {
      ok: true as const,
      code: "sent",
      preview,
      externalId: uploaded.awpId,
      externalStatus: status.status || "NOT_VIEWED",
      externalNumber: status.registrationNumber || uploaded.number,
      signature: signed.signature,
      provider: "live" as const,
    };
  } finally {
    await closeEsfSession(session.sessionId, config);
  }
}
