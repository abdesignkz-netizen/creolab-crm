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

export function signatureRequestLabel(status: string) {
  const labels: Record<string, string> = {
    PENDING: uiText("Ожидает подписания"),
    OPENED: uiText("Ссылка открыта"),
    SIGNED: uiText("Документ подписан"),
    DECLINED: uiText("Подписание отклонено"),
    EXPIRED: uiText("Срок ссылки истёк"),
    CANCELLED: uiText("Запрос отменён"),
  };
  return labels[status] || status;
}
