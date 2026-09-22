import { FEATURE_LABEL, LIMIT_LABEL, LIMIT_LIST, type CatalogItem, type Feature } from "@creolab/contracts";

export type BillingCatalogItem = Pick<CatalogItem, "code" | "name" | "kind" | "product" | "description" | "monthlyPriceMinor" | "yearlyPriceMinor" | "chargeType" | "catalogStatus" | "features" | "limits" | "included" | "recommended">;
export type BillingPeriod = "MONTHLY" | "YEARLY";

export function formatKzt(value: number) {
  return `${value.toLocaleString("ru-RU")} ₸`;
}

export function catalogPrice(item: BillingCatalogItem, period: BillingPeriod) {
  return item.chargeType === "ONE_TIME" || period === "MONTHLY" ? item.monthlyPriceMinor : item.yearlyPriceMinor;
}

const AUDIENCE: Record<string, string> = {
  CRM_START: "Для небольшой команды, которой нужно вести клиентов и продажи.",
  CRM_BUSINESS: "Для отдела продаж, которому нужны документы, аналитика и несколько воронок.",
  CRM_PRO: "Для большой команды с несколькими отделами и доступом через API.",
  BUNDLE_CRM_AI: "Для команды, которая ведёт продажи в CRM и поручает переписку AI-менеджеру.",
  BUNDLE_FULL: "Для продаж с AI и управления CRM командами через BasQar Control.",
  AI_SALES: "Для продаж в WhatsApp с AI-менеджером и базового учёта клиентов.",
  CONTROL_STANDALONE: "Для управления задачами и продажами текстовыми командами.",
};

const GROUPS = [
  { id: "crm", title: "CRM для команды", text: "Три уровня: от учёта продаж до работы нескольких отделов. AI-менеджер и номера WhatsApp подключаются дополнительно.", codes: ["CRM_START", "CRM_BUSINESS", "CRM_PRO"] },
  { id: "bundles", title: "CRM вместе с AI", text: "Готовые комплекты на базе CRM Business. Отличаются от CRM Pro составом модулей и лимитами команды.", codes: ["BUNDLE_CRM_AI", "BUNDLE_FULL"] },
  { id: "standalone", title: "Отдельные продукты с CRM Lite", text: "CRM Lite включает клиентов, заявки, сделки и задачи. Работа с компаниями и документами доступна в соответствующих тарифах полной CRM.", codes: ["AI_SALES", "CONTROL_STANDALONE"] },
];

// These rows describe the catalog flags; availability and limits always come from the server.
const FEATURE_ROWS: Array<{ key: Feature; label: string }> = [
  { key: "CLIENTS", label: "Клиенты" }, { key: "COMPANIES", label: "Компании" },
  { key: "LEADS", label: "Заявки" }, { key: "DEALS", label: "Сделки" },
  { key: "TASKS", label: "Задачи" }, { key: "TEAM", label: "Работа в команде" },
  { key: "AUTOMATION", label: "Автоматизации" }, { key: "WORKFLOWS", label: "Сценарии работы со сделками" },
  { key: "DOCUMENTS", label: "Договоры, счета и АВР" }, { key: "ESF", label: "Работа с ИС ЭСФ" },
  { key: "ADVANCED_ANALYTICS", label: "Расширенная аналитика" },
  { key: "ADVANCED_ROLES", label: "Расширенные роли" },
  { key: "MASS_MESSAGING", label: "Массовые рассылки" },
  { key: "AI_MANAGER", label: "AI Manager — продажи в переписке" },
  { key: "AI_CONTROL", label: "BasQar Control — команды к CRM" },
  { key: "API", label: "Доступ через API" },
  { key: "PRIORITY_SUPPORT", label: "Приоритетная поддержка" },
];

function highlights(item: BillingCatalogItem) {
  const f = item.features;
  const rows = [f.CRM_CORE ? "Полная CRM: клиенты, компании, заявки, сделки и задачи" : "CRM Lite: клиенты, заявки, сделки и задачи"];
  if (f.DOCUMENTS) rows.push("Договоры, счета, АВР и работа с ИС ЭСФ");
  if (f.WORKFLOWS) rows.push("Сценарии работы со сделками и расширенная аналитика");
  if (f.ADVANCED_ROLES) rows.push("Расширенные роли и массовые рассылки");
  if (f.AI_MANAGER) rows.push("AI Manager: консультации клиентов и обработка заявок");
  if (f.AI_CONTROL) rows.push("BasQar Control: команды для задач, сделок и статистики");
  if (f.API) rows.push("Доступ через API");
  if (f.PRIORITY_SUPPORT) rows.push("Приоритетная поддержка");
  return rows;
}

export function BillingCatalog({ items, period, selected, current, disabled, onSelect }: {
  items: BillingCatalogItem[]; period: BillingPeriod; selected: string; current?: string;
  disabled: boolean; onSelect: (code: string) => void;
}) {
  const available = items.filter((item) => item.kind !== "addon" && item.catalogStatus === "AVAILABLE");
  const enterprise = available.find((item) => item.code === "CRM_ENTERPRISE");
  const comparison = available.filter((item) => item.code !== "CRM_ENTERPRISE");
  const periodLabel = period === "YEARLY" ? "год" : "месяц";
  function card(item: BillingCatalogItem) {
    const selectedItem = selected === item.code;
    const savings = item.monthlyPriceMinor * 12 - item.yearlyPriceMinor;
    return <article key={item.code} className={`panel billing-plan-card ${selectedItem ? "is-selected" : ""} ${item.recommended ? "is-recommended" : ""}`}>
      <div className="billing-card-badges">
        {item.recommended ? <span className="billing-recommend">Рекомендуем</span> : null}
        {current === item.code ? <span className="billing-recommend">Ваш тариф</span> : null}
      </div>
      <h4>{item.name}</h4>
      <p className="muted billing-audience">{AUDIENCE[item.code] || item.description}</p>
      {item.included?.length ? <p className="billing-composition">В составе: {item.included.map((row) => items.find((entry) => entry.code === row.code)?.name || row.code).join(" + ")}.</p> : null}
      <p className="billing-price"><strong>{formatKzt(catalogPrice(item, period))}</strong><span> / {periodLabel}</span></p>
      <p className="muted billing-price-note">{period === "YEARLY" ? `Оплата за год целиком${savings > 0 ? `. Экономия ${formatKzt(savings)}` : ""}.` : "Стоимость за компанию, с указанным числом пользователей."}</p>
      <dl className="billing-plan-limits">
        {LIMIT_LIST.map((key) => <div key={key}><dt>{LIMIT_LABEL[key]}</dt><dd>{item.limits[key] ? Number(item.limits[key]).toLocaleString("ru-RU") : "Не включено"}</dd></div>)}
      </dl>
      <ul className="billing-feature-list">{highlights(item).map((text) => <li key={text}>{text}</li>)}</ul>
      <button type="button" className={`btn ${selectedItem ? "" : "secondary"}`} aria-pressed={selectedItem} disabled={disabled} data-tip={`Выбрать ${item.name} и посмотреть расчёт`} onClick={() => onSelect(item.code)}>
        {selectedItem ? `Выбран ${item.name}` : `Выбрать ${item.name}`}
      </button>
    </article>;
  }
  return <div id="billing-catalog" className="billing-catalog stack">
    <div><h3>Выберите тариф под свою задачу</h3><p className="muted">Все цены в тенге. Лимиты ниже включены в стоимость. AI-взаимодействия указаны на период подписки.</p></div>
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
    {enterprise ? <section className="panel billing-enterprise">
      <div><h3>Enterprise — индивидуальные условия</h3><p>Для компаний, которым нужны особые лимиты, условия поддержки и стоимость.</p><p className="muted">Состав модулей, число пользователей и условия обслуживания согласуем перед подключением.</p></div>
      <button className="btn secondary" type="button" disabled={disabled} onClick={() => onSelect(enterprise.code)}>Обсудить Enterprise</button>
    </section> : null}
    <details id="billing-comparison" className="panel billing-comparison">
      <summary>Подробное сравнение всех тарифов</summary>
      <p className="muted">«Включено» означает доступ по тарифу. Каналы связи и ИС ЭСФ требуют настройки подключения. Номера WhatsApp указаны в лимитах выше.</p>
      <div className="billing-table-scroll" tabIndex={0} role="region" aria-label="Сравнение тарифов">
        <table><caption className="muted">Возможности базовых тарифов без дополнительных модулей</caption><thead><tr><th scope="col">Возможность</th>{comparison.map((item) => <th scope="col" key={item.code}>{item.name}</th>)}</tr></thead>
          <tbody>
            <tr><th scope="row">Цена / {periodLabel}</th>{comparison.map((item) => <td key={item.code}>{formatKzt(catalogPrice(item, period))}</td>)}</tr>
            {LIMIT_LIST.map((key) => <tr key={key}><th scope="row">{LIMIT_LABEL[key]}</th>{comparison.map((item) => <td key={item.code}>{item.limits[key] ? Number(item.limits[key]).toLocaleString("ru-RU") : "Не включено"}</td>)}</tr>)}
            {FEATURE_ROWS.map(({ key, label }) => <tr key={key}><th scope="row">{label || FEATURE_LABEL[key]}</th>{comparison.map((item) => <td key={item.code} className={item.features[key] ? "billing-included" : "muted"}>{item.features[key] ? "Включено" : "Не включено"}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
    </details>
  </div>;
}
