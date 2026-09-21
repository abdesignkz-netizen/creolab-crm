export function signatureCheckLabel(signer: {
  verificationStatus?: string | null;
  cryptoStatus?: string | null;
  authorityStatus?: string | null;
}) {
  if (signer.authorityStatus === "REVOKED") return "Сертификат отозван НУЦ";
  if (signer.verificationStatus === "FAILED") return "Подпись не прошла проверку";
  if (signer.cryptoStatus === "VERIFIED" || signer.verificationStatus === "VERIFIED") {
    if (signer.authorityStatus === "VALID") return "ГОСТ проверен, сертификат НУЦ действителен";
    return "ГОСТ проверен, статус отзыва НУЦ не подтверждён";
  }
  if (signer.verificationStatus === "PARSED") return "Сертификат прочитан, криптопроверка ГОСТ не выполнена";
  return "";
}
