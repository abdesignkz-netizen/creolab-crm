/** Explain validation failures without exposing the certificate or personal IDs. */
export function signatureVerificationFailureMessage(reason: unknown): string {
  const suffix = " Договор не подписан.";
  switch (reason) {
    case "bin_mismatch":
      return "БИН в выбранной ЭЦП не совпадает с БИН стороны договора. Выберите ЭЦП нужной организации." + suffix;
    case "iin_mismatch":
      return "ИИН в выбранной ЭЦП не совпадает с ИИН стороны договора. Выберите соответствующую ЭЦП." + suffix;
    case "certificate_expired":
      return "Срок действия сертификата ЭЦП истёк. Выберите действующий сертификат." + suffix;
    case "certificate_not_yet_valid":
      return "Срок действия сертификата ЭЦП ещё не наступил. Проверьте выбранный сертификат." + suffix;
    case "certificate_revoked":
      return "Сертификат ЭЦП отозван НУЦ. Выберите действующий сертификат." + suffix;
    case "signer_iin_missing":
      return "В сертификате ЭЦП не найден ИИН подписанта. Выберите сертификат подписи НУЦ РК." + suffix;
    case "certificate_missing":
      return "В ответе NCALayer не найден сертификат подписанта. Повторите подписание." + suffix;
    case "cms_parse_failed":
    case "detached_signature_required":
      return "Формат ответа NCALayer не подходит для проверки подписи договора. Обновите страницу и повторите подписание." + suffix;
    default:
      return "Не удалось подтвердить подпись для этой версии договора. Обновите страницу и подпишите договор повторно. Если ошибка повторится, обратитесь к администратору." + suffix;
  }
}

/** Infrastructure errors must not be presented as an invalid user signature. */
export function signatureVerificationUnavailableMessage(reason: unknown): string {
  const suffix = " Договор не подписан.";
  switch (reason) {
    case "gost_kalkan_adapter_missing":
      return "На сервере CRM не подключён сервис проверки ЭЦП. Администратору сервера нужно настроить Kalkan." + suffix;
    case "kalkan_unreachable":
      return "CRM не может связаться с сервисом проверки ЭЦП. Администратору сервера нужно проверить запуск Kalkan." + suffix;
    case "kalkan_timeout":
      return "Сервис проверки ЭЦП не ответил вовремя. Повторите попытку; если ошибка повторится, обратитесь к администратору сервера." + suffix;
    case "unauthorized":
    case "kalkan_http_401":
    case "kalkan_http_403":
      return "Сервис проверки ЭЦП отклонил доступ CRM. Администратору сервера нужно проверить настройки подключения Kalkan." + suffix;
    case "kalkan_jars_missing":
    case "knca_util_missing":
    case "ca_certs_missing":
    case "issuer_cert_not_found":
      return "На сервере проверки ЭЦП не хватает библиотек или сертификатов НУЦ. Обратитесь к администратору сервера." + suffix;
    case "ocsp_unreachable":
    case "ocsp_unchecked":
    case "crl_unchecked":
      return "Не удалось проверить действительность сертификата через НУЦ (OCSP/CRL). Повторите попытку; если ошибка повторится, обратитесь к администратору сервера." + suffix;
    default:
      return "Серверная проверка ЭЦП не завершена. Повторите попытку или обратитесь к администратору сервера." + suffix;
  }
}
