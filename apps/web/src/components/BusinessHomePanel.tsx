import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { BusinessHomeFocus } from "@creolab/contracts";
import { api } from "../lib/api";
import { useLocale } from "../lib/session";
import { InlineFeedback } from "./InlineFeedback";
import { nameWithPhone } from "../lib/contactDisplay";
import "./business-home.css";

export default function BusinessHomePanel({ overview, personal = false, onDetails, links, onAccessLost }: { overview: any; personal?: boolean; onDetails?: () => void; onAccessLost?: () => void; links?: { inquiries: string; sales: string; payments: string; tasks: string } }) {
  const locale = useLocale(), navigate = useNavigate(), kk = locale === "kk";
  const w = (ru: string, kz: string) => kk ? kz : ru;
  const [focus, setFocus] = useState<BusinessHomeFocus | null>(null), [failure, setFailure] = useState(false);
  const [text, setText] = useState(""), [error, setError] = useState(""), [sending, setSending] = useState(false);
  const alive = useRef(true), lock = useRef(false), retry = useRef<{ text: string; id: string } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true; setFocus(null); setFailure(false);
    if (!personal) api.request<BusinessHomeFocus>("/api/v1/workspace/home").then(r => { if (active) { if (r.scope === "personal") onAccessLost?.(); else setFocus(r); } }).catch(e => { if (active) { setFailure(true); if ([401, 403].includes(Number(e?.status))) onAccessLost?.(); } });
    return () => { active = false; };
  }, [overview.asOf, personal]);
  async function ask(value: string) {
    value = value.trim(); if (!value || lock.current) return;
    lock.current = true; setSending(true); setError("");
    if (retry.current?.text !== value) retry.current = { text: value, id: crypto.randomUUID() };
    try {
      // The same command endpoint, history and confirmation flow as the Control page.
      await api.sendControlChat(value, retry.current.id);
      retry.current = null;
      if (alive.current) navigate("/control");
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : w("Не удалось открыть ответ Control. Повторите запрос.", "Control жауабын ашу мүмкін болмады. Қайталап көріңіз.")); }
    finally { lock.current = false; if (alive.current) setSending(false); }
  }
  function submit(e: FormEvent) { e.preventDefault(); void ask(text); }
  const items = personal ? overview.items || [] : overview.attention?.items || [];
  const first = items.find((i: any) => i.href);
  const pending = focus?.actions.items[0];
  const r = overview.result || {}, summary = overview.attention?.summary || {};
  const scope = overview.scope === "mine" ? w("Назначены мне", "Маған тағайындалған") : overview.scope === "unassigned" ? w("Без ответственного", "Жауаптысы жоқ") : w("Компания", "Компания");
  return <div className="business-home">
    <section className="home-next" aria-labelledby="home-next-title">
      <div>
        <span className="home-eyebrow">{w("Ближайший шаг", "Келесі қадам")}</span>
        <h3 id="home-next-title">{first ? first.whyLabel || first.reason || first.title : pending ? w("Проверьте план действий", "Әрекеттер жоспарын тексеріңіз") : w("С чего начнём сегодня?", "Бүгін неден бастаймыз?")}</h3>
        {first ? <p>{first.contactName || first.phone ? nameWithPhone(first.contactName, first.phone, locale) : first.title}{first.subtitle ? ` · ${first.subtitle}` : ""}</p>
          : <p>{pending ? pending.title : w("Откройте свои задачи или задайте вопрос Control. Подключение каналов и настройка ИИ доступны в помощнике начала работы.", "Тапсырмаларды ашыңыз немесе Control-ға сұрақ қойыңыз. Арналарды қосу мен ЖИ баптаулары жұмысты бастау көмекшісінде қолжетімді.")}</p>}
      </div>
      <div className="home-next-links">
        <Link className="btn" to={first?.href || pending?.href || "/tasks"}>{first ? w("Перейти к действию", "Әрекетке өту") : pending ? w("Проверить план", "Жоспарды тексеру") : w("Открыть задачи", "Тапсырмаларды ашу")}</Link>
        {onDetails && <button type="button" className="btn secondary" onClick={onDetails}>{w("Вся очередь", "Барлық кезек")}</button>}
        {!first && !pending && <Link to="/start">{w("Настроить работу", "Жұмысты баптау")}</Link>}
      </div>
    </section>
    {!personal && <>
      <div className="home-section-line"><span>{scope} · {overview.period?.label}</span><span>{w("По данным CRM", "CRM деректері бойынша")}</span></div>
      <div className="home-pulses">
        <Link to={links?.inquiries || "/inquiries"}><span>{w("Обращения", "Өтінімдер")}</span><strong>{r.inquiries ?? "—"}</strong><small>{w("Новые за выбранный период", "Таңдалған кезеңдегі жаңалары")}</small></Link>
        <Link to={links?.sales || "/stats?tab=sales"}><span>{w("Продажи", "Сатылымдар")}</span><strong>{r.wonDeals ?? "—"}</strong><small>{w("Успешные сделки", "Сәтті мәмілелер")}{r.wonAmountLabel ? ` · ${r.wonAmountLabel}` : ""}</small></Link>
        <Link to={links?.payments || "/stats?tab=sales"}><span>{w("Оплаты", "Төлемдер")}</span><strong className="home-money">{overview.payments?.paidInPeriodLabel || "—"}</strong><small>{overview.payments ? w("Внесены в CRM за период", "Кезеңде CRM-ге енгізілген") : w("Поступления пока не внесены", "Түсімдер әлі енгізілмеген")}</small></Link>
        <Link to={links?.tasks || "/tasks?filter=overdue"}><span>{w("Работа команды", "Команда жұмысы")}</span><strong>{summary.overdueTasks ?? "—"}</strong><small>{w("Просроченных задач сейчас", "Қазір мерзімі өткен тапсырмалар")}</small></Link>
      </div>
    </>}
    <section className="home-control" aria-labelledby="home-control-title">
      <div className="home-section-line"><h3 id="home-control-title">BasQar Control</h3><Link to="/control">{w("История и ответы", "Тарих және жауаптар")} →</Link></div>
      <form onSubmit={submit}>
        <label className="sr-only" htmlFor="home-control-question">{w("Вопрос или команда Control", "Control сұрағы немесе командасы")}</label>
        <input id="home-control-question" value={text} onChange={e => setText(e.target.value)} maxLength={2000} placeholder={w("Что требует внимания? Какие задачи на сегодня?", "Не назар аударуды қажет етеді? Бүгінгі тапсырмалар қандай?")} disabled={sending} />
        <button className="btn" disabled={sending || !text.trim()}>{sending ? w("Обрабатываем…", "Өңделуде…") : w("Отправить", "Жіберу")}</button>
      </form>
      <div className="home-quick">{[w("Задачи на сегодня", "Бүгінгі тапсырмалар"), w("Что требует внимания", "Назар аудару керек"), ...(!personal ? [w("Анализ бизнеса", "Бизнесті талда")] : [])].map(command => <button key={command} className="btn secondary" disabled={sending} onClick={() => { setText(command); void ask(command); }}>{command}</button>)}</div>
      <p className="muted">{w("Пишите сразу, без меню. Изменения — после проверки и подтверждения в Control.", "Мәзірсіз бірден жазыңыз. Өзгерістер Control-да тексеріліп, расталғаннан кейін орындалады.")}</p>
      {error && <InlineFeedback kind="error">{error} <Link to="/control">{w("Открыть Control", "Control-ды ашу")}</Link></InlineFeedback>}
    </section>
    {!personal && <>
      {failure && <InlineFeedback kind="error">{w("Дополнительный обзор не загрузился. Основные показатели показаны выше.", "Қосымша шолу жүктелмеді. Негізгі көрсеткіштер жоғарыда.")} <Link to="/control">{w("Открыть Control", "Control-ды ашу")}</Link></InlineFeedback>}
      {!focus && !failure && <p role="status" className="muted">{w("Проверяем выводы, действия и цели…", "Қорытындылар, әрекеттер және мақсаттар тексерілуде…")}</p>}
      {focus && <BusinessFocusSections focus={focus} locale={locale} />}
    </>}
  </div>;
}

export function BusinessFocusSections({ focus, locale }: { focus: BusinessHomeFocus; locale: string }) {
  if (focus.scope !== "company") return null;
  const kk = locale === "kk", w = (ru: string, kz: string) => kk ? kz : ru;
  const stamp = (at: string | null) => at ? new Date(at).toLocaleString(kk ? "kk-KZ" : "ru-RU", { dateStyle: "short", timeStyle: "short" }) : "";
  const unavailable = w("Не удалось проверить данные. Откройте раздел и повторите загрузку.", "Деректерді тексеру мүмкін болмады. Бөлімді ашып, қайта жүктеңіз.");
  return <div className="home-focus-grid">
        <section><h3>{w("На что обратить внимание", "Неге назар аудару керек")}</h3>
          {focus.insights.status === "unavailable" ? <p>{unavailable}</p> : focus.insights.items.length ? focus.insights.items.map(i => <Link className="home-focus-item" key={i.id} to={i.href}><b>{i.title}</b><span>{i.detail}</span><small>{i.limitation}</small></Link>) : <p>{focus.insights.scannedAt ? w("В выборке нет актуальных сигналов. Полную картину проверьте в Control.", "Іріктемеде өзекті сигналдар жоқ. Толық көріністі Control-дан тексеріңіз.") : w("Первичная проверка ещё не завершена. Выводы появятся по мере обработки данных.", "Бастапқы тексеру әлі аяқталмады. Деректер өңделген соң қорытындылар шығады.")}</p>}
          <small className="muted">{w("Выборка последних проверенных сигналов", "Соңғы тексерілген сигналдардың іріктемесі")}{focus.insights.scannedAt ? ` · ${stamp(focus.insights.scannedAt)}` : ""}</small>
          <Link to="/control?view=insights">{w("Все выводы", "Барлық қорытындылар")} →</Link>
        </section>
        <section><h3>{w("Мои действия и результаты", "Менің әрекеттерім мен нәтижелерім")}</h3>
          {focus.actions.status === "unavailable" ? <p>{unavailable}</p> : <>
            {focus.actions.items.map(a => <Link className="home-focus-item" key={a.id} to={a.href}><b>{a.title}</b><span>{a.status === "draft" ? w("Ждёт проверки и подтверждения", "Тексеру мен растауды күтуде") : w("Выполняется", "Орындалуда")}</span></Link>)}
            {focus.actions.recent.map(a => <Link className="home-focus-item" key={a.id} to={a.href}><b>{a.title}</b><span>{a.status === "succeeded" ? w("Шаги выполнены", "Қадамдар орындалды") : w("Нужно проверить результат", "Нәтижені тексеру керек")} · {a.completed}/{a.steps}</span><small>{stamp(a.at)}</small></Link>)}
            {!focus.actions.items.length && !focus.actions.recent.length && <p>{w("Пока нет ожидающих планов или результатов за 7 дней. Попросите Control подготовить план действий.", "Күтудегі жоспарлар немесе соңғы 7 күндегі нәтижелер жоқ. Control-дан әрекеттер жоспарын сұраңыз.")}</p>}
          </>}
          <Link to="/control?view=plans">{w("Все мои планы", "Менің барлық жоспарларым")} →</Link>
        </section>
        <section><h3>{w("Цели компании", "Компания мақсаттары")}</h3>
          {focus.goals.status === "unavailable" ? <p>{unavailable}</p> : focus.goals.items.length ? focus.goals.items.map(g => <Link className="home-focus-item" key={g.id} to={g.href}><b>{g.title}</b><span>{g.ended ? w("Период завершён — проверьте итог", "Кезең аяқталды — қорытындыны тексеріңіз") : g.stale ? w("Измерение устарело", "Өлшем ескірген") : g.progress === null ? w("Недостаточно данных для оценки", "Бағалау үшін деректер жеткіліксіз") : `${g.progress}% · ${g.reached ? w("Цель достигнута", "Мақсатқа қол жеткізілді") : w("В работе", "Орындалуда")}`}</span>{g.asOf && <small>{stamp(g.asOf)}</small>}</Link>) : <p>{w("Задайте измеримую цель и ответственного, чтобы отслеживать результат.", "Нәтижені бақылау үшін өлшенетін мақсат пен жауапты адамды белгілеңіз.")}</p>}
          <Link to="/control?view=goals">{w("Все цели", "Барлық мақсаттар")} →</Link>
        </section>
      </div>;
}
