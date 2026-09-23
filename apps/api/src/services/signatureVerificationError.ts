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
