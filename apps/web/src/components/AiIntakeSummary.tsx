import { INTAKE_FIELDS, INTAKE_LABELS, type AiIntakeRecord } from "@creolab/contracts";
import { useLocale } from "../lib/session";
import { Link } from "react-router-dom";

export function AiIntakeSummary({ records }: { records?: AiIntakeRecord[] }) {
  const locale = useLocale(); const ix = locale === "kk" ? 1 : locale === "en" ? 2 : 0;
  const t = (ru: string, kk: string, en: string) => [ru, kk, en][ix];
  return <>{records?.map(record => <section key={record.kind} className="panel ai-intake-summary">
    <h3>{INTAKE_LABELS[record.kind][ix]}</h3>
    <p className="muted">{t("Собрано ИИ. Требуется проверка и подтверждение сотрудником.", "ЖИ жинады. Қызметкердің тексеруі мен растауы қажет.", "Collected by AI. Staff review and confirmation required.")}</p>
    <p className="muted">{t("Обновлено", "Жаңартылды", "Updated")}: {new Date(record.updatedAt).toLocaleString(locale === "kk" ? "kk-KZ" : locale === "en" ? "en-GB" : "ru-RU")}</p>
    {record.action !== "collect" && <p><b>{record.action === "cancel" ? t("Клиент просит отменить", "Клиент бас тартуды сұрайды", "Customer requests cancellation") : t("Клиент просит изменить", "Клиент өзгертуді сұрайды", "Customer requests a change")}</b></p>}
    <dl className="kv">{Object.entries(record.fields).filter(([, value]) => value).map(([key, value]) => <div key={key} style={{ minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
      <dt>{INTAKE_FIELDS[key as keyof typeof INTAKE_FIELDS][ix]}</dt>
      <dd>{key === "fulfillment" ? value === "delivery" ? t("Доставка", "Жеткізу", "Delivery") : t("Самовывоз", "Алып кету", "Pickup") : value}</dd>
    </div>)}</dl>
    {record.items.length > 0 && <ol>{record.items.map((item, i) => <li key={i} style={{ margin: "10px 0", overflowWrap: "anywhere" }}><b>{item.name}</b> · {item.quantity ?? t("уточнить количество", "санын нақтылау", "quantity needed")} {item.unit || ""}{item.variant && ` · ${item.variant}`}{item.notes && <div>{item.notes}</div>}</li>)}</ol>}
    {record.missingFields.length > 0 && <p>{t("Ещё нужно уточнить", "Әлі нақтылау керек", "Still needed")}: {record.missingFields.map(key => INTAKE_FIELDS[key][ix]).join(", ")}.</p>}
    {record.taskId && <Link className="btn secondary" to={`/tasks?open=${encodeURIComponent(record.taskId)}`}>{t("Задача на проверку", "Тексеру тапсырмасы", "Review task")}</Link>}
  </section>)}</>;
}
