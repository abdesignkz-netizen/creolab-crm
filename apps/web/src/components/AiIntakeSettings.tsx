import { defaultAiIntakeSettings, intakeKindsForRoles, INTAKE_LABELS, INTAKE_FIELDS, INTAKE_ALLOWED_FIELDS, INTAKE_REQUIRED, type AiManagerDraft, type AiSetupState, type AiIntakeSettings as Settings } from "@creolab/contracts";
import { useLocale } from "../lib/session";
import { Link } from "react-router-dom";

export function AiIntakeReadiness({ draft, automation, settingsHref }: { draft: AiManagerDraft; automation: AiSetupState["intakeAutomation"]; settingsHref: string }) {
  const locale = useLocale(); const ix = locale === "kk" ? 1 : locale === "en" ? 2 : 0;
  const t = (ru: string, kk: string, en: string) => [ru, kk, en][ix];
  if (!intakeKindsForRoles([draft.primaryRole, ...draft.additionalRoles]).length) return null;
  return <aside className="ai-setup-guidance" aria-label={t("Сохранение заявок", "Өтінімдерді сақтау", "Saving requests")}>
    <b>{automation?.saveRequests ? t("Сохранение заявок включено", "Өтінімдерді сақтау қосылған", "Request saving is enabled") : t("Сохранение заявок ещё не включено", "Өтінімдерді сақтау әлі қосылмаған", "Request saving is not enabled yet")}</b>
    <p>{automation?.saveRequests ? (automation.createTasks ? t("Собранные сведения попадут в заявку и историю клиента. Когда данных достаточно, сотрудник получит задачу на проверку.", "Жиналған деректер өтінім мен клиент тарихына түседі. Деректер жеткілікті болса, қызметкерге тексеру тапсырмасы беріледі.", "Collected details go to the request and customer history. Once complete, staff receive a review task.") : t("Сведения сохраняются в заявке и истории клиента. Создание задач выключено — включите его, если сотруднику нужна отдельная задача на проверку.", "Деректер өтінім мен клиент тарихына сақталады. Тапсырма құру өшірулі — жеке тексеру тапсырмасы қажет болса, қосыңыз.", "Details are saved to the request and history. Task creation is off; enable it if staff need a separate review task.")) : t("Анкета обучает ИИ собирать сведения. Чтобы они также сохранялись в CRM, включите анализ обращений, обновление CRM и обновление заявок в управлении ИИ.", "Анкета ЖИ-ді мәлімет жинауға үйретеді. CRM-ге сақтау үшін ЖИ басқаруында өтініштерді талдау, CRM және өтінім жаңартуын қосыңыз.", "The questionnaire teaches AI to collect details. To also save them in CRM, enable request analysis, CRM updates and request updates in AI controls.")}</p>
    {automation?.requiresModeChange && <p>{t("Основной режим сейчас не сохраняет изменения автоматически. Выберите режим с применением изменений для нужного канала.", "Негізгі режим өзгерістерді автоматты сақтамайды. Қажетті арна үшін өзгерістерді қолданатын режимді таңдаңыз.", "The default mode does not save changes automatically. Choose a mode that applies changes for the relevant channel.")}</p>}
    <small>{t("Учитываются режим канала, пауза диалога и правила работы при передаче сотруднику.", "Арна режимі, диалог үзілісі және қызметкерге беру ережелері ескеріледі.", "Channel mode, paused conversations and staff handoff rules still apply.")}</small>
    <p><Link to={settingsHref}>{t("Настроить сохранение и задачи", "Сақтау мен тапсырмаларды баптау", "Configure saving and tasks")}</Link></p>
  </aside>;
}

export function AiIntakeSettings({ draft, onChange }: { draft: AiManagerDraft; onChange: (value: Settings) => void }) {
  const locale = useLocale(); const ix = locale === "kk" ? 1 : locale === "en" ? 2 : 0;
  const t = (ru: string, kk: string, en: string) => [ru, kk, en][ix];
  const kinds = intakeKindsForRoles([draft.primaryRole, ...draft.additionalRoles]);
  if (!kinds.length) return null;
  const settings = draft.intake || defaultAiIntakeSettings();
  return <section className="ai-intake-settings" aria-label={t("Запись и заказы", "Жазылу және тапсырыстар", "Bookings and orders")}>
    <h3>{t("Как принимать заявки", "Өтінімдерді қалай қабылдау керек", "How to collect requests")}</h3>
    <p className="ai-setup-help">{t("Выберите, что ИИ должен уточнить перед передачей заявки сотруднику. Уже известные сведения он не должен спрашивать повторно.", "Өтінімді қызметкерге берер алдында ЖИ нені нақтылауы керегін таңдаңыз. Белгілі мәліметті қайта сұрамауы тиіс.", "Choose what AI should clarify before staff review. It should not ask again for details already provided.")}</p>
    <fieldset className="ai-intake-options"><legend>{t("Кто подтверждает", "Кім растайды", "Who confirms")}</legend>
      <label><input type="radio" name="intake-confirmation" checked={settings.confirmation === "staff"} onChange={() => onChange({ ...settings, confirmation: "staff" })} />{t("Сотрудник после проверки", "Тексеруден кейін қызметкер", "Staff after review")}</label>
      <label className="ai-setup-help"><input type="radio" name="intake-confirmation" disabled checked={settings.confirmation === "automatic"} readOnly />{t("Автоматически — пока недоступно", "Автоматты түрде — әзірге қолжетімсіз", "Automatically — not yet available")}</label>
      <p className="ai-setup-help">{t("Для автоматического оформления нужна проверка свободного времени или остатков и подтверждение операции. Сейчас ИИ не бронирует места, не резервирует товары и не отправляет заказ на кухню.", "Автоматты рәсімдеу үшін бос уақыт не қор тексеруі және операция растауы қажет. Қазір ЖИ орын не тауар резервтемейді, асүйге тапсырыс жібермейді.", "Automatic fulfillment requires availability or stock checks and a confirmed operation. AI does not reserve slots or stock, or send orders to the kitchen.")}</p>
    </fieldset>
    {kinds.some(k => k !== "booking") && <fieldset className="ai-intake-options"><legend>{t("Как клиент получает заказ", "Клиент тапсырысты қалай алады", "Fulfillment options")}</legend>
      {(["delivery", "pickup"] as const).map(mode => <label key={mode}><input type="checkbox" checked={settings.fulfillment.includes(mode)} disabled={settings.fulfillment.length === 1 && settings.fulfillment.includes(mode)} onChange={e => onChange({ ...settings, fulfillment: e.target.checked ? [...settings.fulfillment, mode] : settings.fulfillment.filter(v => v !== mode) })} />{mode === "delivery" ? t("Доставка", "Жеткізу", "Delivery") : t("Самовывоз", "Алып кету", "Pickup")}</label>)}
      <p className="ai-setup-help">{t("Адрес обязателен только для доставки. Стоимость, зоны и время укажите на шаге «Условия».", "Мекенжай тек жеткізуге қажет. Баға, аймақ және уақытты «Шарттар» қадамында көрсетіңіз.", "An address is required only for delivery. Set fees, areas and timing in Terms.")}</p>
    </fieldset>}
    {kinds.map(kind => <fieldset className="ai-intake-options" key={kind}><legend>{INTAKE_LABELS[kind][ix]}</legend>
      <p className="ai-setup-help">{t("Какие сведения обязательно собрать", "Қандай мәліметтер міндетті", "Required details to collect")}</p>
      <div className="ai-intake-fields">{INTAKE_ALLOWED_FIELDS[kind].filter(key => key !== "address").map(key => <label key={key}><input type="checkbox" checked={settings[kind].requiredFields.includes(key)} disabled={INTAKE_REQUIRED[kind].includes(key)} onChange={e => onChange({ ...settings, [kind]: { ...settings[kind], requiredFields: e.target.checked ? [...settings[kind].requiredFields, key] : settings[kind].requiredFields.filter(v => v !== key) } })} />{INTAKE_FIELDS[key][ix]}{INTAKE_REQUIRED[kind].includes(key) && " *"}</label>)}</div>
      <label className="ai-setup-field">{t("Особенности приёма заявки", "Өтінім қабылдау ерекшеліктері", "Specific intake instructions")}
        <textarea rows={3} maxLength={4000} value={settings[kind].instructions} onChange={e => onChange({ ...settings, [kind]: { ...settings[kind], instructions: e.target.value } })} placeholder={kind === "booking" ? t("Например: уточнить филиал и желаемого специалиста.", "Мысалы: филиал мен қалаған маманды нақтылау.", "Example: ask for the branch and preferred specialist.") : t("Например: уточнить размер, замену товара и удобное время получения.", "Мысалы: өлшем, тауар ауыстыру және алу уақытын нақтылау.", "Example: clarify size, substitutions and preferred delivery time.")} />
      </label>
    </fieldset>)}
  </section>;
}
