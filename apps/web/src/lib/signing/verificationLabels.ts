import { uiText, useUiText, localizeUiOptions } from "../uiText";
export function signatureCheckLabel(signer: {
  verificationStatus?: string | null;
  cryptoStatus?: string | null;
  authorityStatus?: string | null;
}) {
  if (signer.authorityStatus === "REVOKED") return uiText("Сертификат отозван НУЦ");
  if (signer.verificationStatus === "FAILED") return uiText("Подпись не прошла проверку");
  if (signer.cryptoStatus === "VERIFIED" || signer.verificationStatus === "VERIFIED") {
    if (signer.authorityStatus === "VALID") return uiText("ГОСТ проверен, сертификат НУЦ действителен");
    return uiText("ГОСТ проверен, статус отзыва НУЦ не подтверждён");
  }
  if (signer.verificationStatus === "PARSED") return uiText("Сертификат прочитан, криптопроверка ГОСТ не выполнена");
  return "";
}
