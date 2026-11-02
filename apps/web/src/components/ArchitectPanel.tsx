import { useEffect, useRef, useState } from "react";
import type { ArchitectAnswers, ArchitectPreview, ArchitectSavedDraft, ArchitectState } from "@creolab/contracts";
import { architectApi } from "../lib/aiArchitect";
import { useLocale } from "../lib/session";
import { InlineFeedback } from "./InlineFeedback";
import { ArchitectReview } from "./ArchitectReview";
import { ArchitectApplication } from "./ArchitectApplication";
import "./architect.css";

export default function ArchitectPanel() {
  const locale = useLocale() === "kk" ? "kk" : "ru", t = (ru: string, kk: string) => locale === "kk" ? kk : ru;
  const [state, setState] = useState<ArchitectState | null>(null), [answers, setAnswers] = useState<ArchitectAnswers | null>(null);
  const [step, setStep] = useState(0), [loading, setBusy] = useState(false), [error, setError] = useState("");
  const [applying, setApplying] = useState(false), busy = loading || applying;
  const [preview, setPreview] = useState<ArchitectPreview | null>(null), [stored, setStored] = useState<ArchitectSavedDraft | null>(null);
  const [notice, setNotice] = useState(""), heading = useRef<HTMLHeadingElement>(null), requestId = useRef<string | null>(null), active = useRef(true), loadVersion = useRef(0);
  useEffect(() => { active.current = true; void load(false); return () => { active.current = false; loadVersion.current++; }; }, []);
  useEffect(() => { if (state) heading.current?.focus(); }, [step]);
  async function load(preserve: boolean) {
    const version = ++loadVersion.current;
    setBusy(true); setError("");
    try {
      const result = await architectApi.get(); if (!active.current || version !== loadVersion.current) return;
      setState(result); setStored(result.draft); requestId.current = null; setNotice("");
      if (!preserve) { setAnswers({ ...(result.draft?.answers || result.defaults), locale }); setPreview(result.draft?.answers.locale === locale ? result.draft.preview : null); if (result.draft) setStep(2); }
      else { setPreview(null); setNotice(t("Текущие настройки проверены. Ваши ответы оставлены в форме; сформируйте проект заново.", "Қазіргі баптаулар тексерілді. Жауаптарыңыз формада қалды; жобаны қайта жасаңыз.")); }
    } catch (e) { if (active.current && version === loadVersion.current) setError(e instanceof Error ? e.message : t("Не удалось загрузить проект", "Жобаны жүктеу мүмкін болмады")); }
    finally { if (active.current && version === loadVersion.current) setBusy(false); }
  }
  function change<K extends keyof ArchitectAnswers>(key: K, value: ArchitectAnswers[K]) {
    setAnswers(a => a && ({ ...a, [key]: value, locale })); setPreview(null); setNotice(""); requestId.current = null;
  }
  async function prepare() {
    if (!answers || busy) return; setBusy(true); setError(""); setNotice("");
    try { const result = await architectApi.preview({ ...answers, locale }); if (active.current) { setPreview(result); setStep(2); requestId.current = null; heading.current?.focus(); } }
    catch (e) { if (active.current) setError(e instanceof Error ? e.message : t("Не удалось подготовить проект", "Жобаны дайындау мүмкін болмады")); }
    finally { if (active.current) setBusy(false); }
  }
  async function save() {
    if (!state || !answers || !preview || busy) return; setBusy(true); setError(""); setNotice("");
    requestId.current ||= crypto.randomUUID();
    try {
      const result = await architectApi.save({ answers: { ...answers, locale }, revision: state.revision, requestId: requestId.current, baseRevision: preview.baseRevision, previewHash: preview.previewHash });
      if (!active.current) return;
      setStored(result); setState(s => s && ({ ...s, revision: result.revision, draft: result }));
      setNotice(t("Проект сохранён. Рабочие настройки компании не изменились.", "Жоба сақталды. Компанияның жұмыс баптаулары өзгерген жоқ."));
    } catch (e) { if (active.current) setError(e instanceof Error ? e.message : t("Не удалось сохранить проект", "Жобаны сақтау мүмкін болмады")); }
    finally { if (active.current) setBusy(false); }
  }
  const kinds = [["unknown", t("Помогите определиться", "Таңдауға көмектесіңіз")], ["services", t("Услуги и проекты", "Қызметтер мен жобалар")], ["retail", t("Продажа товаров", "Тауар сату")], ["booking", t("Запись на услугу", "Қызметке жазылу")], ["food", t("Еда и продукты", "Тағам мен азық-түлік")], ["other", t("Другой процесс", "Басқа процесс")]];
  const goals = [["unknown", t("Пока не определено", "Әлі анықталмаған")], ["consultation", t("Консультировать", "Кеңес беру")], ["sales", t("Помогать продавать", "Сатуға көмектесу")], ["qualification", t("Выяснять потребность клиента", "Клиент қажеттілігін анықтау")], ["booking", t("Собирать заявки на запись", "Жазылу өтінімдерін жинау")], ["product_order", t("Собирать заказы товаров", "Тауар тапсырыстарын жинау")], ["food_order", t("Собирать заказы еды", "Тағам тапсырыстарын жинау")], ["support", t("Помогать с вопросами после покупки", "Сатып алғаннан кейін көмектесу")]];
  const channels = { whatsapp: "WhatsApp", telegram: "Telegram", instagram: "Instagram Direct", "website-chat": t("Чат на сайте", "Сайттағы чат"), form: t("Форма заявки", "Өтінім формасы") };
  const steps = [t("Ваш бизнес", "Сіздің бизнес"), t("Работа с клиентами", "Клиенттермен жұмыс"), t("Проект настройки", "Баптау жобасы")];
  const fieldStep = (key: keyof ArchitectAnswers) => ["businessKind", "description", "offerings", "audience", "goal", "languages"].includes(key) ? 0 : 1;
  function editField(key: keyof ArchitectAnswers) { setStep(fieldStep(key)); requestAnimationFrame(() => document.getElementById(`architect-${key}`)?.focus()); }
  return <section className="architect" aria-busy={busy}>
    <header><span className="setup-kicker">BASQAR · {t("ПРОЕКТ НАСТРОЙКИ", "БАПТАУ ЖОБАСЫ")}</span><h1>{t("Настроим процесс под ваш бизнес", "Процесті бизнесіңізге бейімдейік")}</h1><p>{t("Ответьте на несколько вопросов. Получите предложения с объяснениями и сохраните их для проверки.", "Бірнеше сұраққа жауап беріңіз. Түсіндірмелері бар ұсыныстарды алып, тексеруге сақтаңыз.")}</p></header>
    {error && <div className="setup-error"><InlineFeedback kind="error">{error}</InlineFeedback><button type="button" className="btn secondary" disabled={busy} onClick={() => void load(Boolean(answers))}>{t("Проверить текущие настройки", "Қазіргі баптауларды тексеру")}</button></div>}
    {notice && <InlineFeedback className="architect-notice" kind="success">{notice}</InlineFeedback>}
    {!state || !answers ? <p role="status">{busy ? t("Загружаем настройки…", "Баптаулар жүктелуде…") : t("Проект пока не загружен", "Жоба әлі жүктелген жоқ")}</p> : <>
      <nav className="architect-steps" aria-label={t("Шаги проекта", "Жоба қадамдары")}>{steps.map((label, i) => <button key={i} type="button" className={step === i ? "selected" : ""} aria-current={step === i ? "step" : undefined} disabled={busy} onClick={() => setStep(i)}><span>{i + 1}</span>{label}</button>)}</nav>
      <div className="architect-context"><span>{state.companyName} · {state.timezone}</span><span>{t("Изменения применяются после отдельного подтверждения", "Өзгерістер бөлек растаудан кейін қолданылады")}</span></div>
      <div className="architect-content"><h2 ref={heading} tabIndex={-1}>{steps[step]}</h2>
        {step < 2 ? <form onSubmit={e => { e.preventDefault(); if (step === 0) setStep(1); else void prepare(); }}>
          <fieldset disabled={busy}>
            {step === 0 ? <>
              <label htmlFor="architect-description">{t("Чем занимается компания?", "Компания немен айналысады?")}<textarea id="architect-description" rows={3} maxLength={3000} value={answers.description} onChange={e => change("description", e.target.value)} placeholder={t("Например: делаем презентации для компаний. Клиенты пишут в WhatsApp, мы уточняем задачу и готовим предложение.", "Мысалы: компанияларға презентация жасаймыз. Клиенттер WhatsApp-қа жазады, біз міндетін анықтап, ұсыныс дайындаймыз.")} /></label>
              <div className="architect-fields"><label htmlFor="architect-businessKind">{t("Основной процесс", "Негізгі процесс")}<select id="architect-businessKind" value={answers.businessKind} onChange={e => change("businessKind", e.target.value as ArchitectAnswers["businessKind"])}>{kinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label htmlFor="architect-goal">{t("Главная задача ИИ", "ЖИ-дің негізгі міндеті")}<select id="architect-goal" value={answers.goal} onChange={e => change("goal", e.target.value as ArchitectAnswers["goal"])}>{goals.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
              <label htmlFor="architect-offerings">{t("Какие товары или услуги предлагаете?", "Қандай тауарлар не қызметтер ұсынасыз?")}<textarea id="architect-offerings" rows={2} maxLength={1500} value={answers.offerings} onChange={e => change("offerings", e.target.value)} placeholder={t("Основные предложения. Цены можно добавить позже в базу знаний.", "Негізгі ұсыныстар. Бағаларды білім қорына кейін қосуға болады.")} /></label>
              <label htmlFor="architect-audience">{t("Кто ваши клиенты?", "Клиенттеріңіз кім?")}<input id="architect-audience" maxLength={600} value={answers.audience} onChange={e => change("audience", e.target.value)} placeholder={t("Например: компании Казахстана", "Мысалы: Қазақстан компаниялары")} /></label>
              <fieldset className="architect-checks"><legend>{t("Языки клиентов", "Клиенттер тілі")}</legend>{(["ru", "kk"] as const).map(lang => <label key={lang}><input type="checkbox" checked={answers.languages.includes(lang)} disabled={answers.languages.length === 1 && answers.languages.includes(lang)} onChange={e => change("languages", e.target.checked ? [...answers.languages, lang] : answers.languages.filter(v => v !== lang))} />{lang === "ru" ? "Русский" : "Қазақша"}</label>)}</fieldset>
            </> : <>
              <fieldset id="architect-channels" tabIndex={-1}><legend>{t("Откуда приходят обращения?", "Өтінімдер қайдан келеді?")}</legend><div className="architect-channels">{state.channels.map(c => <label key={c.kind} className={`setup-option ${answers.channels.includes(c.kind) ? "selected" : ""}`}><input type="checkbox" checked={answers.channels.includes(c.kind)} onChange={e => change("channels", e.target.checked ? [...answers.channels, c.kind] : answers.channels.filter(v => v !== c.kind))} /><span><b>{channels[c.kind]}</b><small>{!c.available ? t("Недоступно в текущих настройках", "Ағымдағы баптауда қолжетімсіз") : c.connected ? t("Уже подключён", "Қосылған") : t("Подключим отдельно", "Бөлек қосылады")}</small></span></label>)}</div></fieldset>
              <div className="architect-fields"><label htmlFor="architect-replyMode">{t("Кто отвечает клиенту?", "Клиентке кім жауап береді?")}<select id="architect-replyMode" value={answers.replyMode} onChange={e => change("replyMode", e.target.value as ArchitectAnswers["replyMode"])}><option value="manual">{t("Сотрудник", "Қызметкер")}</option><option value="assist">{t("ИИ подсказывает сотруднику", "ЖИ қызметкерге көмектеседі")}</option><option value="auto">{t("ИИ отвечает сам после настройки", "ЖИ бапталғаннан кейін өзі жауап береді")}</option></select></label>
                <label htmlFor="architect-replyAudience">{t("Кому отвечает ИИ?", "ЖИ кімге жауап береді?")}<select id="architect-replyAudience" value={answers.replyAudience} onChange={e => change("replyAudience", e.target.value as ArchitectAnswers["replyAudience"])}><option value="all">{t("Всем клиентам", "Барлық клиенттерге")}</option><option value="new">{t("Только новым", "Тек жаңаларына")}</option><option value="existing">{t("Только существующим", "Тек бар клиенттерге")}</option></select></label></div>
              {!state.aiAvailable && answers.replyMode !== "manual" && <p className="architect-notice">{t("Для выбранного режима потребуется доступ к ИИ-менеджеру. Подписка не изменяется.", "Бұл режимге ЖИ-менеджерге қолжетімділік қажет. Тариф өзгермейді.")}</p>}
              <label htmlFor="architect-hours">{t("Когда обрабатывать обращения?", "Өтінімдерді қашан өңдеу керек?")}<select id="architect-hours" value={answers.hours.mode} onChange={e => change("hours", { ...answers.hours, mode: e.target.value as ArchitectAnswers["hours"]["mode"] })}><option value="unknown">{t("Нужно уточнить", "Нақтылау керек")}</option><option value="always">{t("Круглосуточно", "Тәулік бойы")}</option><option value="schedule">{t("В выбранные дни и часы", "Таңдалған күндер мен уақытта")}</option></select></label>
              {answers.hours.mode === "schedule" && <div><fieldset className="architect-checks"><legend>{t("Дни недели", "Апта күндері")}</legend>{[1, 2, 3, 4, 5, 6, 0].map((day, i) => <label key={day}><input type="checkbox" checked={answers.hours.days.includes(day)} onChange={e => change("hours", { ...answers.hours, days: e.target.checked ? [...answers.hours.days, day] : answers.hours.days.filter(v => v !== day) })} />{(locale === "kk" ? ["Дс", "Сс", "Ср", "Бс", "Жм", "Сб", "Жс"] : ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"])[i]}</label>)}</fieldset><div className="architect-fields"><label>{t("С", "Басталуы")}<input type="time" value={answers.hours.start} onChange={e => change("hours", { ...answers.hours, start: e.target.value })} required /></label><label>{t("До", "Аяқталуы")}<input type="time" value={answers.hours.end} onChange={e => change("hours", { ...answers.hours, end: e.target.value })} required /></label></div><small>{state.timezone}</small></div>}
              <div className="architect-fields"><label htmlFor="architect-responsibleMembershipId">{t("Кому передавать сложные вопросы?", "Күрделі сұрақтар кімге беріледі?")}<select id="architect-responsibleMembershipId" value={answers.responsibleMembershipId || ""} onChange={e => change("responsibleMembershipId", e.target.value || null)}><option value="">{t("Выберу позже", "Кейін таңдаймын")}</option>{state.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
                <label htmlFor="architect-firstResponseMinutes">{t("Желаемое время первого ответа", "Алғашқы жауаптың қалаулы уақыты")}<select id="architect-firstResponseMinutes" value={answers.firstResponseMinutes || ""} onChange={e => change("firstResponseMinutes", e.target.value ? Number(e.target.value) as ArchitectAnswers["firstResponseMinutes"] : null)}><option value="">{t("Пока не задано", "Әлі көрсетілмеген")}</option>{[5, 10, 15, 30, 60].map(n => <option value={n} key={n}>{n} {t("минут", "минут")}</option>)}</select></label></div>
              <details><summary>{t("Дополнительные пожелания", "Қосымша тілектер")}</summary><label htmlFor="architect-otherRequirements">{t("Что ещё нужно учесть?", "Тағы нені ескеру керек?")}<textarea id="architect-otherRequirements" rows={3} maxLength={1000} value={answers.otherRequirements} onChange={e => change("otherRequirements", e.target.value)} /></label><small>{t("Сохраним для проверки. Неподдерживаемые операции не будут включены автоматически.", "Тексеру үшін сақталады. Қолдау жоқ әрекеттер автоматты қосылмайды.")}</small></details>
            </>}
            <p className="muted">{t("Пароли, токены и ключи сюда вводить не нужно. Если не знаете ответ, оставьте его для уточнения.", "Құпиясөз, токен мен кілттерді мұнда енгізбеңіз. Жауапты білмесеңіз, нақтылауға қалдырыңыз.")}</p>
            <div className="architect-actions">{step === 1 && <button type="button" className="btn secondary" onClick={() => setStep(0)}>{t("Назад", "Артқа")}</button>}<button className="btn" type="submit">{busy ? t("Подготавливаем…", "Дайындалуда…") : step === 0 ? t("Продолжить", "Жалғастыру") : t("Посмотреть проект", "Жобаны көру")}</button></div>
          </fieldset>
        </form> : <>
          {stored && stored.appliedRevision !== stored.revision && (stored.stale || stored.expired) && <p className="architect-notice" role="status">{t("Сохранённый проект устарел: настройки изменились или прошло 7 дней. Пересоберите его по текущим данным.", "Сақталған жоба ескірді: баптаулар өзгерді немесе 7 күн өтті. Қазіргі деректермен қайта жасаңыз.")}</p>}
          {!preview ? <div className="architect-empty"><p>{t("Просмотрите предложения по вашим ответам. Можно сохранить и неполный проект, чтобы вернуться к нему позже.", "Жауаптарыңызға сай ұсыныстарды қараңыз. Кейін оралу үшін толық емес жобаны да сақтауға болады.")}</p><button type="button" className="btn" disabled={busy} onClick={() => void prepare()}>{t("Сформировать проект", "Жобаны жасау")}</button></div> : <>
            <ArchitectReview preview={preview} locale={locale} busy={busy} onEdit={editField} />
            <div className="architect-actions"><button className="btn secondary" type="button" disabled={busy} onClick={() => setStep(0)}>{t("Изменить ответы", "Жауаптарды өзгерту")}</button><button className="btn secondary" type="button" disabled={busy} onClick={() => void prepare()}>{t("Пересобрать по текущим данным", "Қазіргі дерекпен қайта жасау")}</button><button className="btn" type="button" disabled={busy} onClick={() => void save()}>{busy ? t("Сохраняем…", "Сақталуда…") : t("Сохранить проект", "Жобаны сақтау")}</button></div>
            {stored && <p className="muted">{t("Последнее сохранение", "Соңғы сақтау")}: {new Date(stored.savedAt).toLocaleString(locale === "kk" ? "kk-KZ" : "ru-KZ", { timeZone: state.timezone })}. {t("Версия", "Нұсқа")} {stored.revision}.</p>}
            {stored && stored.preview.previewHash === preview.previewHash && <ArchitectApplication key={`${stored.id}:${stored.revision}`} draftId={stored.id} revision={stored.revision} locale={locale} resume={Boolean(stored.applicationRunId)} onPending={setApplying} onRun={run => setStored(s => s && ({ ...s, applicationRunId: run.id, ...(run.status === "succeeded" ? { appliedRevision: s.revision, appliedAt: run.finishedAt } : {}) }))} />}
          </>}
        </>}
      </div>
    </>}
  </section>;
}
