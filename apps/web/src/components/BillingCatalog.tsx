import { FEATURE_LABEL, LIMIT_LABEL, type CatalogItem, type Feature } from "@creolab/contracts";

export type BillingCatalogItem = Pick<CatalogItem, "code" | "name" | "kind" | "product" | "description" | "monthlyPriceMinor" | "yearlyPriceMinor" | "launchMonthlyPriceMinor" | "launchEndsAt" | "chargeType" | "catalogStatus" | "features" | "limits" | "included" | "recommended">;
export type BillingPeriod = "MONTHLY" | "YEARLY";
const DISPLAY_LIMITS = ["USERS", "AI_CREDITS", "AUTOMATION_RUNS", "DOCUMENTS_COUNT", "CAMPAIGN_RECIPIENTS", "WHATSAPP_CONNECTIONS", "STORAGE_GB"] as const;

function resourceText(item: BillingCatalogItem, key: typeof DISPLAY_LIMITS[number]) {
  const value = Number(item.limits[key]).toLocaleString("ru-RU");
  if (key === "AI_CREDITS" && item.code === "BASQAR_FREE") return `🎁 ${value} один раз`;
  if (["AI_CREDITS", "AUTOMATION_RUNS", "DOCUMENTS_COUNT", "CAMPAIGN_RECIPIENTS"].includes(key)) return `${value} / мес`;
  return key === "STORAGE_GB" ? `${value} ГБ` : value;
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

function highlights(item: BillingCatalogItem) {
  const f = item.features;
  const rows = [f.CRM_CORE ? "Полная CRM: клиенты, компании, заявки, сделки и задачи" : "CRM Lite: клиенты, заявки, сделки и задачи"];
  if (f.DOCUMENTS) rows.push("Договоры, счета, АВР и работа с ИС ЭСФ");
  if (f.WORKFLOWS) rows.push("Сценарии работы со сделками и расширенная аналитика");
  if (f.MASS_MESSAGING) rows.push("Массовые кампании с подтверждением запуска"); else rows.push("Массовые рассылки — с тарифа Start");
  if (f.CONTROL_BULK) rows.push("Массовые действия Control и расширенные правила AI");
  if (f.SUPPORT) rows.push("Импорт, экспорт и поддержка команды");
  if (f.AI_MANAGER) {
    rows.push(item.code === "BASQAR_FREE"
      ? "AI Manager: пробный режим для ознакомления с консультациями клиентов и обработкой заявок"
      : "AI Manager: консультации клиентов и обработка заявок");
  }
  if (f.AI_CONTROL) rows.push("BasQar Control: команды для задач, сделок и статистики");
  if (f.API) rows.push("Доступ через API");
  if (f.PRIORITY_SUPPORT) rows.push("Приоритетная поддержка");
  return rows.slice(0, 7);
}

export function BillingCatalog({ items, period, selected, current, disabled, onSelect }: {
  items: BillingCatalogItem[]; period: BillingPeriod; selected: string; current?: string;
  disabled: boolean; onSelect: (code: string) => void;
}) {
  const available = items.filter((item) => item.kind !== "addon" && item.catalogStatus === "AVAILABLE");
  const enterprise = available.find((item) => item.code === "CRM_ENTERPRISE");
  const comparison = GROUPS[0].codes.flatMap(code => available.find(item => item.code === code) || []);
  const periodLabel = period === "YEARLY" ? "год" : "месяц";
  const priceText = (item: BillingCatalogItem) => {
    if (period === 'MONTHLY' && item.launchMonthlyPriceMinor && item.launchEndsAt && new Date(item.launchEndsAt) >= new Date()) {
      return <><strong>{formatKzt(item.launchMonthlyPriceMinor)}</strong> <span>/ месяц</span><br/><del className="muted">{formatKzt(item.monthlyPriceMinor)}</del> <small>Спеццена до 31.12.2026</small><br/><small>С 1 января 2027 года и при следующем продлении после акции — 14 990 ₸/мес.</small></>;
    }
    if (period === 'YEARLY' && item.monthlyPriceMinor > 0) return <><strong>{formatKzt(Math.round(item.yearlyPriceMinor / 12))}</strong> <span>/ мес при оплате за год</span><br/><small>{formatKzt(item.yearlyPriceMinor)} за 12 месяцев · 2 месяца бесплатно</small><br/><del className="muted">{formatKzt(item.monthlyPriceMinor)} / мес</del><br/><small>Экономия {formatKzt(item.monthlyPriceMinor * 12 - item.yearlyPriceMinor)} относительно стандартной цены {formatKzt(item.monthlyPriceMinor)} / мес.</small></>;
    return <><strong>{formatKzt(catalogPrice(item, period))}</strong>{item.code !== "BASQAR_FREE" ? <span> / {periodLabel}</span> : <span> навсегда</span>}</>;
  };
  function card(item: BillingCatalogItem) {
    const free = item.code === "BASQAR_FREE";
    const selectedItem = selected === item.code;
    return <article key={item.code} className={`panel billing-plan-card ${selectedItem ? "is-selected" : ""} ${item.recommended ? "is-recommended" : ""}`}>
      <div className="billing-card-badges">
        {item.recommended ? <span className="billing-recommend">Популярный</span> : null}
        {current === item.code ? <span className="billing-recommend">Ваш тариф</span> : null}
      </div>
      <h4>{item.name}</h4>
      <p className="muted billing-audience">{AUDIENCE[item.code] || item.description}</p>
      {item.included?.length ? <p className="billing-composition">В составе: {item.included.map((row) => items.find((entry) => entry.code === row.code)?.name || row.code).join(" + ")}.</p> : null}
      <p className="billing-price">{priceText(item)}</p>
      <p className="muted billing-price-note">{free ? "Ручная работа с клиентами, сделками и задачами. Без оплаты и подтверждения администратора." : "Указана стоимость базовой конфигурации. Дополнительные подключения и ресурсы оплачиваются отдельно."}</p>
      <dl className="billing-plan-limits">
        {DISPLAY_LIMITS.map((key) => <div key={key}><dt>{key === "AI_CREDITS" ? "AI-кредиты" : key === "AUTOMATION_RUNS" ? "Запуски автоматизации" : key === "DOCUMENTS_COUNT" ? "Документы" : key === "CAMPAIGN_RECIPIENTS" ? "Рассылки · получатели" : LIMIT_LABEL[key]}</dt><dd>{item.limits[key] === -1 ? "Без квоты" : item.limits[key] === 0 && key === "CAMPAIGN_RECIPIENTS" ? "С тарифа Start" : item.limits[key] == null ? "По условиям тарифа" : resourceText(item, key)}</dd></div>)}
      </dl>
      {item.code === "CRM_START" ? <p className="muted">По сравнению с Free: ×10 автоматизаций и документов, до 3 пользователей, 5 ГБ хранилища, ежемесячные AI-кредиты и рассылки до 300 получателей.</p> : null}
      <ul className="billing-feature-list">{highlights(item).map((text) => <li key={text}>{text}</li>)}</ul>
      <button type="button" className={`btn ${selectedItem ? "" : "secondary"}`} aria-pressed={selectedItem} disabled={disabled || current === item.code} data-tip={`Выбрать ${item.name} и посмотреть расчёт`} onClick={() => onSelect(item.code)}>
        {current === item.code ? "Ваш тариф" : free ? "Начать бесплатно" : selectedItem ? `Выбран ${item.name}` : `Выбрать ${item.name}`}
      </button>
    </article>;
  }
  return <div id="billing-catalog" className="billing-catalog stack">
    <div><h3>Выберите тариф под свою задачу</h3><p className="muted">Один продукт — четыре масштаба работы. CRM и BasQar Control доступны во всех тарифах. ИИ-менеджер: пробный режим в Free, включён в Business и Pro. Массовые рассылки доступны со Start.</p></div>
    <p className="muted">1 AI-кредит ≈ одно стандартное AI-действие. Ресурсы обновляются каждый расчётный месяц, в том числе при оплате за год, и не переносятся. 100 AI-кредитов Free выдаются один раз, в том числе для ознакомления с ИИ-менеджером. AI-кредиты Start используются для BasQar Control и других доступных AI-действий; ИИ-менеджер в Start не входит. Стоимость услуг внешнего WhatsApp-провайдера не входит в тариф BasQar.</p>
    <nav className="billing-section-links" aria-label="Группы тарифов">
      {GROUPS.map((group) => <a key={group.id} href={`#billing-${group.id}`}>{group.title}</a>)}
      <a href="#billing-comparison">Сравнить возможности</a>
    </nav>
    {GROUPS.map((group) => {
      const plans = group.codes.flatMap((code) => available.find((item) => item.code === code) || []);
      if (!plans.length) return null;
      return <section key={group.id} id={`billing-${group.id}`} className="billing-plan-group">
        <h3>{group.title}</h3><p className="muted">{group.text}</p>
        <div className={`billing-plan-grid ${plans.length === 3 ? "three" : ""}`}>{plans.map(card)}</div>
      </section>;
    })}
    <details id="billing-comparison" className="panel billing-comparison">
      <summary>Подробное сравнение всех тарифов</summary>
      <p className="muted">«Включено» означает доступ по тарифу. Каналы связи и ИС ЭСФ требуют настройки подключения. Количество подключений коммуникационных каналов указано в лимитах.</p>
      <div className="billing-table-scroll" tabIndex={0} role="region" aria-label="Сравнение тарифов">
        <table><caption className="muted">Возможности базовых тарифов без дополнительных модулей</caption><thead><tr><th scope="col">Возможность</th>{comparison.map((item) => <th scope="col" key={item.code}>{item.name}</th>)}</tr></thead>
          <tbody>
            <tr><th scope="row">Цена / {periodLabel}</th>{comparison.map((item) => <td key={item.code}>{formatKzt(catalogPrice(item, period))}</td>)}</tr>
            {DISPLAY_LIMITS.map((key) => <tr key={key}><th scope="row">{LIMIT_LABEL[key]}</th>{comparison.map((item) => <td key={item.code}>{item.limits[key] === -1 ? "Без квоты" : item.limits[key] === 0 && key === "CAMPAIGN_RECIPIENTS" ? "С тарифа Start" : item.limits[key] == null ? "По условиям тарифа" : resourceText(item, key)}</td>)}</tr>)}
            {FEATURE_GROUPS.flatMap(group => [<tr key={group.title}><th colSpan={comparison.length + 1}>{group.title}</th></tr>, ...group.rows.map(({ key, label }) => <tr key={`${group.title}-${label}`}><th scope="row">{label || FEATURE_LABEL[key]}</th>{comparison.map((item) => <td key={item.code} className={item.features[key] && (!group.requires || item.features[group.requires]) ? "billing-included" : "muted"}>{item.features[key] && (!group.requires || item.features[group.requires]) ? (key === "AI_MANAGER" && item.code === "BASQAR_FREE" ? "Пробный режим · 100 AI-кредитов один раз" : "Включено") : "—"}</td>)}</tr>)])}
          </tbody>
        </table>
      </div>
    </details>
    {enterprise ? <section className="panel billing-enterprise">
      <div><h3>Enterprise</h3><p className="billing-plan-price">Индивидуально</p><p>Для компаний, которым нужны индивидуальные лимиты, дополнительные интеграции и особые условия обслуживания.</p><p className="muted">Состав функций, лимиты, интеграции и стоимость формируются индивидуально под задачи компании.</p></div>
      <button className="btn secondary" type="button" disabled={disabled} onClick={() => onSelect(enterprise.code)}>Обсудить Enterprise</button>
    </section> : null}

  </div>;
}
