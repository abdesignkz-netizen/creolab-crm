import { systemText } from "@creolab/contracts";
import { useLocale } from "../lib/session";
import { FEATURE_LABEL, LIMIT_LABEL, type CatalogItem, type Feature } from "@creolab/contracts";

export type BillingCatalogItem = Pick<CatalogItem, "code" | "name" | "kind" | "product" | "description" | "monthlyPriceMinor" | "yearlyPriceMinor" | "launchMonthlyPriceMinor" | "launchEndsAt" | "chargeType" | "catalogStatus" | "features" | "limits" | "included" | "recommended">;
export type BillingPeriod = "MONTHLY" | "YEARLY";
const DISPLAY_LIMITS = ["USERS", "AI_CREDITS", "AUTOMATION_RUNS", "DOCUMENTS_COUNT", "CAMPAIGN_RECIPIENTS", "WHATSAPP_CONNECTIONS", "STORAGE_GB"] as const;

function resourceText(item: BillingCatalogItem, key: typeof DISPLAY_LIMITS[number], locale: string) {
  const value = Number(item.limits[key]).toLocaleString("ru-RU");
  if (key === "AI_CREDITS" && item.code === "BASQAR_FREE") return systemText(locale, "🎁 {p0} один раз", { p0: value });
  if (["AI_CREDITS", "AUTOMATION_RUNS", "DOCUMENTS_COUNT", "CAMPAIGN_RECIPIENTS"].includes(key)) return systemText(locale, "{p0} / мес", { p0: value });
  return key === "STORAGE_GB" ? systemText(locale, "{p0} ГБ", { p0: value }) : value;
}


export function formatKzt(value: number) {
  return `${value.toLocaleString("ru-RU")} ₸`;
}

export function catalogPrice(item: BillingCatalogItem, period: BillingPeriod) {
  return item.chargeType === "ONE_TIME" || period === "MONTHLY" ? item.monthlyPriceMinor : item.yearlyPriceMinor;
}

const AUDIENCE: Record<string, string> = {
  BASQAR_FREE: "CRM для работы со своими клиентами. ИИ-менеджер — в пробном режиме.",
  CRM_START: "Для ежедневной работы малого бизнеса.",
  CONTROL: "Для отдела продаж и растущей команды.",
  SALES: "Для компаний с большим потоком клиентов и процессов.",
  FULL: "Продажи и расширенная автоматизация бизнеса.",
};

const GROUPS = [
  { id: "main", title: "Тарифы BasQar", text: "Все цены фиксированы. Доступные ресурсы можно увеличить отдельными дополнениями.", codes: ["BASQAR_FREE", "CRM_START", "CONTROL", "SALES"] },
];

// These rows describe the catalog flags; availability and limits always come from the server.
const FEATURE_GROUPS: Array<{ title: string; requires?: Feature; rows: Array<{ key: Feature; label: string }> }> = [
  { title: "CRM", rows: [{key:"CRM_CORE",label:"Ситуация, история, теги и заметки"}] },
  { title: "Клиенты и компании", rows: [{key:"CLIENTS",label:"Клиенты"},{key:"COMPANIES",label:"Компании"},{key:"IMPORT",label:"Импорт клиентов"},{key:"EXPORT",label:"Экспорт и сегментация"}] },
  { title: "Заявки", rows: [{key:"LEADS",label:"Заявки, источники и UTM"}] },
  { title: "Сделки", rows: [{key:"DEALS",label:"Воронка, позиции, суммы, причины потерь и следующий шаг"}] },
  { title: "Задачи и команда", rows: [{key:"TASKS",label:"Задачи"},{key:"TEAM",label:"Команда, роли и права"}] },
  { title: "Аналитика", rows: [{key:"CRM_CORE",label:"Базовая CRM-аналитика"},{key:"AI_CONTROL",label:"AI-анализ данных компании"}] },
  { title: "Документы", rows: ["Единый раздел документов", "Договоры и договор из сделки", "Word-шаблоны, DOCX и PDF", "Счета, АВР и ЭСФ", "Импорт PDF/DOC/DOCX, OCR и распознавание", "NCALayer, подписание и проверка"].map(label => ({key:"DOCUMENTS" as Feature,label})).concat([{key:"ESF",label:"ИС ЭСФ при настроенном подключении"}]) },
  { title: "BasQar Control", rows: [{key:"AI_CONTROL",label:"Сводка, поиск, отчёты и безопасные команды CRM"},{key:"CONTROL_BULK",label:"Массовое назначение, изменение и создание"}] },
  { title: "AI-менеджер продаж", requires: "AI_MANAGER", rows: [{key:"AI_MANAGER",label:"AI-менеджер продаж"},{key:"AI_MANAGER",label:"MANUAL / ASSIST / CONFIRM / AUTO"},{key:"AI_MANAGER",label:"AI knowledge, Conversation Context, follow-up и передача человеку"},{key:"ADVANCED_AUTOMATION",label:"Расширенные правила AI и расписание"}] },
  { title: "Коммуникации", rows: [{key:"MESSAGING",label:"Переписка через подключённый канал"}] },
  { title: "Рассылки", rows: [{key:"MASS_MESSAGING",label:"Кампании, CSV/Excel, сегменты, расписание, статусы и retry"}] },
  { title: "Интеграции", rows: [{key:"CHANNELS",label:"Подключение поддерживаемых коммуникационных каналов"}] },
  { title: "Уведомления", rows: [{key:"CRM_CORE",label:"Внутренние уведомления"}] },
  { title: "Поддержка", rows: [{key:"SUPPORT",label:"База знаний, обращения и переписка с поддержкой"}] },
  { title: "Системные возможности", rows: [{key:"CRM_CORE",label:"Профиль и базовые настройки CRM"},{key:"FILE_STORAGE",label:"Файлы в пределах лимита"}] },
];

function highlights(item: BillingCatalogItem, locale: string) {
  const f = item.features;
  const rows = [f.CRM_CORE ? systemText(locale, "Полная CRM: клиенты, компании, заявки, сделки и задачи") : systemText(locale, "CRM Lite: клиенты, заявки, сделки и задачи")];
  if (f.DOCUMENTS) rows.push(systemText(locale, "Договоры, счета, АВР и работа с ИС ЭСФ"));
  if (f.WORKFLOWS) rows.push(systemText(locale, "Сценарии работы со сделками и расширенная аналитика"));
  if (f.MASS_MESSAGING) rows.push(systemText(locale, "Массовые кампании с подтверждением запуска")); else rows.push(systemText(locale, "Массовые рассылки — с тарифа Start"));
  if (f.CONTROL_BULK) rows.push(systemText(locale, "Массовые действия Control и расширенные правила AI"));
  if (f.SUPPORT) rows.push(systemText(locale, "Импорт, экспорт и поддержка команды"));
  if (f.AI_MANAGER) {
    rows.push(item.code === "BASQAR_FREE"
      ? systemText(locale, "AI Manager: пробный режим для ознакомления с консультациями клиентов и обработкой заявок")
      : systemText(locale, "AI Manager: консультации клиентов и обработка заявок"));
  }
  if (f.AI_CONTROL) rows.push(systemText(locale, "BasQar Control: команды для задач, сделок и статистики"));
  if (f.API) rows.push(systemText(locale, "Доступ через API"));
  if (f.PRIORITY_SUPPORT) rows.push(systemText(locale, "Приоритетная поддержка"));
  return rows.slice(0, 7);
}

export function BillingCatalog({ items, period, selected, current, disabled, onSelect }: {
  items: BillingCatalogItem[]; period: BillingPeriod; selected: string; current?: string;
  disabled: boolean; onSelect: (code: string) => void;
}) {
  const locale = useLocale();
  const bt = (ru: string, kk: string, en: string) => locale === "kk" ? kk : locale === "en" ? en : ru;
  const available = items.filter((item) => item.kind !== "addon" && item.catalogStatus === "AVAILABLE");
  const enterprise = available.find((item) => item.code === "CRM_ENTERPRISE");
  const comparison = GROUPS[0].codes.flatMap(code => available.find(item => item.code === code) || []);
  const periodLabel = period === "YEARLY" ? systemText(locale, "год") : systemText(locale, "месяц");
  const priceText = (item: BillingCatalogItem) => {
    if (period === 'MONTHLY' && item.launchMonthlyPriceMinor && item.launchEndsAt && new Date(item.launchEndsAt) >= new Date()) {
      return <><strong>{formatKzt(item.launchMonthlyPriceMinor)}</strong> <span>{systemText(locale, "/ месяц")}</span><br/><del className="muted">{formatKzt(item.monthlyPriceMinor)}</del> <small>{systemText(locale, "Спеццена до 31.12.2026")}</small><br/><small>{systemText(locale, "С 1 января 2027 года и при следующем продлении после акции — 14 990 ₸/мес.")}</small></>;
    }
    if (period === 'YEARLY' && item.monthlyPriceMinor > 0) return <><strong>{formatKzt(Math.round(item.yearlyPriceMinor / 12))}</strong> <span>{systemText(locale, "/ мес при оплате за год")}</span><br/><small>{formatKzt(item.yearlyPriceMinor)} {" "}{systemText(locale, "за 12 месяцев · 2 месяца бесплатно")}</small><br/><del className="muted">{formatKzt(item.monthlyPriceMinor)} {" "}{systemText(locale, "/ мес")}</del><br/><small>{systemText(locale, "Экономия {saving} относительно стандартной цены {price} / мес.", { saving: formatKzt(item.monthlyPriceMinor * 12 - item.yearlyPriceMinor), price: formatKzt(item.monthlyPriceMinor) })}</small></>;
    return <><strong>{formatKzt(catalogPrice(item, period))}</strong>{item.code !== "BASQAR_FREE" ? <span> / {periodLabel}</span> : <span> {" "}{systemText(locale, "навсегда")}</span>}</>;
  };
  function card(item: BillingCatalogItem) {
    const free = item.code === "BASQAR_FREE";
    const selectedItem = selected === item.code;
    return <article key={item.code} className={`panel billing-plan-card ${selectedItem ? "is-selected" : ""} ${item.recommended ? "is-recommended" : ""}`}>
      <div className="billing-card-badges">
        {item.recommended ? <span className="billing-recommend">{systemText(locale, "Популярный")}</span> : null}
        {current === item.code ? <span className="billing-recommend">{systemText(locale, "Ваш тариф")}</span> : null}
      </div>
      <h4>{item.name}</h4>
      <p className="muted billing-audience">{systemText(locale, AUDIENCE[item.code] || item.description)}</p>
      {item.included?.length ? <p className="billing-composition">{systemText(locale, "В составе:")}{" "}{item.included.map((row) => items.find((entry) => entry.code === row.code)?.name || row.code).join(" + ")}.</p> : null}
      <p className="billing-price">{priceText(item)}</p>
      <dl className="billing-plan-limits">
        {DISPLAY_LIMITS.filter(key => ["USERS", "AI_CREDITS", "WHATSAPP_CONNECTIONS", "STORAGE_GB"].includes(key)).map((key) => <div key={key}><dt>{key === "AI_CREDITS" ? systemText(locale, "AI-кредиты") : key === "AUTOMATION_RUNS" ? systemText(locale, "Запуски автоматизации") : key === "DOCUMENTS_COUNT" ? systemText(locale, "Документы") : key === "CAMPAIGN_RECIPIENTS" ? systemText(locale, "Рассылки · получатели") : systemText(locale, LIMIT_LABEL[key])}</dt><dd>{item.limits[key] === -1 ? systemText(locale, "Без квоты") : item.limits[key] === 0 && key === "CAMPAIGN_RECIPIENTS" ? systemText(locale, "С тарифа Start") : item.limits[key] == null ? systemText(locale, "По условиям тарифа") : resourceText(item, key, locale)}</dd></div>)}
      </dl>
      <button type="button" className={`btn ${selectedItem ? "" : "secondary"}`} aria-pressed={selectedItem} disabled={disabled || current === item.code} data-tip={systemText(locale, "Выбрать {p0} и посмотреть расчёт", { p0: item.name })} onClick={() => onSelect(item.code)}>
        {current === item.code ? systemText(locale, "Ваш тариф") : free ? systemText(locale, "Начать бесплатно") : selectedItem ? systemText(locale, "Выбран {p0}", { p0: item.name }) : systemText(locale, "Выбрать {p0}", { p0: item.name })}
      </button>
      <details className="billing-details"><summary>{bt("Что входит в тариф", "Тарифке не кіреді", "What’s included")}</summary>
      <p className="muted billing-price-note">{free ? systemText(locale, "Ручная работа с клиентами, сделками и задачами. Без оплаты и подтверждения администратора.") : systemText(locale, "Указана стоимость базовой конфигурации. Дополнительные подключения и ресурсы оплачиваются отдельно.")}</p>
      {item.code === "CRM_START" ? <p className="muted">{systemText(locale, "По сравнению с Free: ×10 автоматизаций и документов, до 3 пользователей, 5 ГБ хранилища, ежемесячные AI-кредиты и рассылки до 300 получателей.")}</p> : null}
      <ul className="billing-feature-list">{highlights(item, locale).map((text) => <li key={text}>{text}</li>)}</ul>
      </details>
    </article>;
  }
  return <div id="billing-catalog" className="billing-catalog stack">
    <div><h3>{systemText(locale, "Выберите тариф под свою задачу")}</h3><p className="muted">{systemText(locale, "Один продукт — четыре масштаба работы. CRM и BasQar Control доступны во всех тарифах. ИИ-менеджер: пробный режим в Free, включён в Business и Pro. Массовые рассылки доступны со Start.")}</p></div>
    {GROUPS.map((group) => {
      const plans = group.codes.flatMap((code) => available.find((item) => item.code === code) || []);
      if (!plans.length) return null;
      return <section key={group.id} id={`billing-${group.id}`} className="billing-plan-group">
        <h3>{systemText(locale, group.title)}</h3><p className="muted">{systemText(locale, group.text)}</p>
        <div className={`billing-plan-grid ${plans.length === 3 ? "three" : ""}`}>{plans.map(card)}</div>
      </section>;
    })}
    <details className="panel billing-details"><summary>{bt("Как считаются лимиты и AI-кредиты", "Лимиттер мен AI-кредиттер қалай есептеледі", "How limits and AI credits work")}</summary>
    <p className="muted">{systemText(locale, "1 AI-кредит ≈ одно стандартное AI-действие. Ресурсы обновляются каждый расчётный месяц, в том числе при оплате за год, и не переносятся. 100 AI-кредитов Free выдаются один раз, в том числе для ознакомления с ИИ-менеджером. AI-кредиты Start используются для BasQar Control и других доступных AI-действий; ИИ-менеджер в Start не входит. Стоимость услуг внешнего WhatsApp-провайдера не входит в тариф BasQar.")}</p>
    </details>
    <details id="billing-comparison" className="panel billing-comparison">
      <summary>{systemText(locale, "Подробное сравнение всех тарифов")}</summary>
      <p className="muted">{systemText(locale, "«Включено» означает доступ по тарифу. Каналы связи и ИС ЭСФ требуют настройки подключения. Количество подключений коммуникационных каналов указано в лимитах.")}</p>
      <div className="billing-table-scroll" tabIndex={0} role="region" aria-label={systemText(locale, "Сравнение тарифов")}>
        <table><caption className="muted">{systemText(locale, "Возможности базовых тарифов без дополнительных модулей")}</caption><thead><tr><th scope="col">{systemText(locale, "Возможность")}</th>{comparison.map((item) => <th scope="col" key={item.code}>{item.name}</th>)}</tr></thead>
          <tbody>
            <tr><th scope="row">{systemText(locale, "Цена /")}{" "}{periodLabel}</th>{comparison.map((item) => <td key={item.code}>{formatKzt(catalogPrice(item, period))}</td>)}</tr>
            {DISPLAY_LIMITS.map((key) => <tr key={key}><th scope="row">{systemText(locale, LIMIT_LABEL[key])}</th>{comparison.map((item) => <td key={item.code}>{item.limits[key] === -1 ? systemText(locale, "Без квоты") : item.limits[key] === 0 && key === "CAMPAIGN_RECIPIENTS" ? systemText(locale, "С тарифа Start") : item.limits[key] == null ? systemText(locale, "По условиям тарифа") : resourceText(item, key, locale)}</td>)}</tr>)}
            {FEATURE_GROUPS.flatMap(group => [<tr key={systemText(locale, group.title)}><th colSpan={comparison.length + 1}>{systemText(locale, group.title)}</th></tr>, ...group.rows.map(({ key, label }) => <tr key={`${systemText(locale, group.title)}-${label}`}><th scope="row">{systemText(locale, label || FEATURE_LABEL[key])}</th>{comparison.map((item) => <td key={item.code} className={item.features[key] && (!group.requires || item.features[group.requires]) ? "billing-included" : "muted"}>{item.features[key] && (!group.requires || item.features[group.requires]) ? (key === "AI_MANAGER" && item.code === "BASQAR_FREE" ? systemText(locale, "Пробный режим · 100 AI-кредитов один раз") : systemText(locale, "Включено")) : "—"}</td>)}</tr>)])}
          </tbody>
        </table>
      </div>
    </details>
    {enterprise ? <section className="panel billing-enterprise">
      <div><h3>Enterprise</h3><p className="billing-plan-price">{systemText(locale, "Индивидуально")}</p><p>{systemText(locale, "Для компаний, которым нужны индивидуальные лимиты, дополнительные интеграции и особые условия обслуживания.")}</p><p className="muted">{systemText(locale, "Состав функций, лимиты, интеграции и стоимость формируются индивидуально под задачи компании.")}</p></div>
      <button className="btn secondary" type="button" disabled={disabled} onClick={() => onSelect(enterprise.code)}>{systemText(locale, "Обсудить Enterprise")}</button>
    </section> : null}

  </div>;
}
