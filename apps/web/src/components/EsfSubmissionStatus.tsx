export const ESF_SEND_PHASES: Record<string, string> = {
  CHECKING: "Проверяем документ…",
  AUTHORIZING: "Входим в кабинет ИС ЭСФ…",
  CONNECTING: "Подключаемся к NCALayer…",
  SIGNING: "Ожидаем подпись документа в NCALayer…",
  SENDING: "Отправляем в ИС ЭСФ. Ожидаем подтверждение…",
  REFRESHING: "Запрашиваем статус в ИС ЭСФ…",
};

export type EsfSubmission = {
  phase?: string;
  error?: string;
  uncertain?: boolean;
  document?: any;
  provider?: string;
};

/** Keep portal receipt separate from a local draft, signature, or an uncertain response. */
export function EsfSubmissionStatus({ document: doc, submission = {}, system, statusLabel }: {
  document?: any;
  submission?: EsfSubmission;
  system?: { provider?: string; esfEnv?: string };
  statusLabel?: string;
}) {
  const type = doc?.type === "ESF" ? "ЭСФ" : "АВР";
  const pending = submission.uncertain || ["SENDING", "SENT", "ACCEPTED"].includes(doc?.status) || doc?.errorCode === "send_result_unknown";
  const error = submission.error || doc?.errorMessage;
  const test = submission.provider === "mock" || system?.provider === "mock" || system?.esfEnv === "test";
  const received = Boolean(doc?.externalId);
  const rejected = ["FAILED", "DECLINED", "DELETED", "CANCELED", "REVOKED"].includes(doc?.externalStatus);
  return <div className="esf-submission-result" role={error ? "alert" : "status"} aria-live="polite" style={{ marginTop: 12 }}>
    {submission.phase ? <p><b>{ESF_SEND_PHASES[submission.phase] || submission.phase}</b></p> : received ? <>
      <p className={rejected ? "error" : "ok"}><b>{rejected ? "ИС ЭСФ отклонила или отозвала документ" : test ? "Тестовая отправка подтверждена" : `Получено подтверждение отправки ${type}`}</b></p>
      {test ? <p className="pdf-import-warnings">CRM работает в тестовом режиме. Это не подтверждение регистрации на рабочем портале ИС ЭСФ.</p> : null}
      <p>{doc.externalNumber ? <>Номер регистрации: <b>{doc.externalNumber}</b></> : "Номер регистрации пока не получен. Обновите статус ИС ЭСФ."}</p>
      <p>Идентификатор в ИС ЭСФ: <b>{doc.externalId}</b>{doc.externalStatus ? <> · Статус ИС ЭСФ: <b>{statusLabel || doc.externalStatus}</b></> : null}</p>
      {doc.sentAt ? <p>Отправлено: {new Date(doc.sentAt).toLocaleString("ru-RU")}</p> : null}
    </> : pending ? <p className="pdf-import-warnings"><b>Результат отправки не подтверждён.</b> Проверьте документ на портале ИС ЭСФ перед повторной отправкой. Повторная отправка заблокирована, чтобы не создать дубликат.</p> : <p className="muted">{error ? "Подтверждения отправки в ИС ЭСФ нет." : `${type} сохранён в CRM. Подтверждения регистрации в ИС ЭСФ пока нет.`}</p>}
    {error ? <p className="error">{error}</p> : null}
  </div>;
}
