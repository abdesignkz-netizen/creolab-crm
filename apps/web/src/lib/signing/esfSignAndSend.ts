import { ESF_MODULE_REQUIRED_MESSAGE, sanitizeEsfSignerPublicMeta } from "@creolab/contracts";
import { api } from "../api";
import { createEsfNcaLayerClient } from "./esfNcaLayerClient";
import { NcalayerError } from "./ncalayerClient";

export { ESF_MODULE_REQUIRED_MESSAGE };

export async function signAndSendEsfDocument(documentId: string) {
  const client = createEsfNcaLayerClient();
  try {
    if (!(await client.isAvailable())) {
      throw new NcalayerError("NCALAYER_NOT_RUNNING", "Запустите NCALayer и повторите подпись");
    }
    const probe = await client.probe();
    if (!probe.officialModuleInstalled) {
      throw new NcalayerError("SIGNATURE_FAILED", ESF_MODULE_REQUIRED_MESSAGE);
    }
    const prepared = (await api.esfPayloadToSign(documentId)) as {
      payload: string;
      payloadSha256: string;
    };
    const signed = await client.signPlainData(prepared.payload);
    const sent = await api.sendElectronicDocumentEsfSigned(documentId, {
      signature: signed.signature,
      publicCertificate: signed.publicCertificate,
      payloadSha256: prepared.payloadSha256,
      metadata: {
        algorithm: signed.keyInfo.algorithm,
        certificateSerial: signed.keyInfo.serialNumber,
        subjectCn: signed.keyInfo.subjectCn,
      },
    });
    return {
      sent,
      probe,
      meta: sanitizeEsfSignerPublicMeta(signed),
    };
  } finally {
    client.disconnect();
  }
}
