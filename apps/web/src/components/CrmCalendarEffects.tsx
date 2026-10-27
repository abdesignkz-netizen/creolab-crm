import type { CrmCalendarEffect, CrmProcessQueue } from "@creolab/contracts";
import { useLocale } from "../lib/session";

// Kept with the lazy-loaded review panel, not in the application's initial bundle.
const copy = {
  ru: { heading: "Календарь и очередь действий", pending: "Ожидает синхронизации", removal_pending: "Ожидает удаления из календаря",
    syncing: "Синхронизируется", synced: "Сохранено в календаре", removed: "Удалено из календаря", error: "Ошибка синхронизации",
    uncertain: "Результат не подтверждён", disconnected: "Календарь отключён", unverified: "Нужна сверка с календарём",
    retry: "BasQar повторит синхронизацию. До подтверждения результат в календаре может отличаться.",
    off: "Ранее созданные события могут оставаться в календаре. Отключение связи не удаляет их.",
    old: "Для прежней синхронизации нет результата по этой встрече. Нужна проверка в календаре.",
    reminders: "Напоминания", actions: "Связанные действия", queued: "В очереди", running: "В обработке", processed: "Обработано", canceled: "Отменено", needsCheck: "Нужна проверка",
    queueNote: "Обработка очереди не подтверждает доставку в WhatsApp или на устройство сотрудника.", checked: "Последняя попытка" },
  kk: { heading: "Күнтізбе және әрекеттер кезегі", pending: "Синхрондауды күтуде", removal_pending: "Күнтізбеден жоюды күтуде",
    syncing: "Синхрондалуда", synced: "Күнтізбеде сақталды", removed: "Күнтізбеден жойылды", error: "Синхрондау қатесі",
    uncertain: "Нәтиже расталмады", disconnected: "Күнтізбе ажыратылған", unverified: "Күнтізбемен салыстыру қажет",
    retry: "BasQar синхрондауды қайталайды. Расталғанға дейін күнтізбедегі нәтиже өзгеше болуы мүмкін.",
    off: "Бұрын жасалған оқиғалар күнтізбеде қалуы мүмкін. Байланысты ажырату оларды жоймайды.",
    old: "Бұрынғы синхрондауда осы кездесу бойынша нәтиже жоқ. Күнтізбеде тексеру қажет.",
    reminders: "Еске салулар", actions: "Байланысты әрекеттер", queued: "Кезекте", running: "Өңделуде", processed: "Өңделді", canceled: "Бас тартылды", needsCheck: "Тексеру қажет",
    queueNote: "Кезектің өңделуі хабардың WhatsApp-қа немесе қызметкердің құрылғысына жеткізілгенін растамайды.", checked: "Соңғы әрекет" },
};

export default function CrmCalendarEffects({ effects = [], queues = [] }: { effects?: CrmCalendarEffect[]; queues?: CrmProcessQueue[] }) {
  const locale = useLocale(), t = copy[locale === "kk" ? "kk" : "ru"];
  if (!effects.length && !queues.length) return null;
  return <details className="crm-review-effects" open>
    <summary>{t.heading}</summary>
    {effects.map(effect => <div className="crm-review-effect" key={`${effect.integrationId}:${effect.agreementId}`}>
      <b>{effect.title}</b><span>{effect.calendar} · {t[effect.state]}</span>
      {effect.state === "error" || effect.state === "uncertain" ? <p className="crm-review-warning">{t.retry}</p> : null}
      {effect.state === "disconnected" || effect.state === "unverified" ? <p className="muted">{t[effect.state === "disconnected" ? "off" : "old"]}</p> : null}
      {effect.checkedAt ? <small>{t.checked}: {new Date(effect.checkedAt).toLocaleString(locale === "kk" ? "kk-KZ" : "ru-RU", { dateStyle: "short", timeStyle: "short" })}</small> : null}
    </div>)}
    {queues.map(queue => <div className="crm-review-effect" key={queue.kind}><b>{t[queue.kind]}</b>
      <dl className="crm-review-queue">{(["queued", "running", "processed", "canceled", "needsCheck"] as const).filter(key => queue[key] > 0).map(key => <div key={key}><dt>{t[key]}</dt><dd>{queue[key]}</dd></div>)}</dl>
    </div>)}
    {queues.length ? <p className="muted">{t.queueNote}</p> : null}
  </details>;
}
