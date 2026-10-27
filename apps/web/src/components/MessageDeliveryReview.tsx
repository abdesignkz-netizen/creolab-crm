import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MessageDeliveryReview as Review, MessageRetryBlock } from "@creolab/contracts";
import { api } from "../lib/api";
import { useLocale } from "../lib/session";
import "./messageDeliveryReview.css";

const copy = {
  ru: {
    title: "Результат отправки", close: "Закрыть", loading: "Загружаем результат…", refresh: "Обновить",
    text: "Сообщение", recipient: "Получатель", accepted: "Отправлено", failed: "Не отправлено", pending: "Ещё не отправлено", providerId: "Номер отправки",
    unknown: "Нужно проверить", sending: "Отправляется", checked: "Сверено сотрудником", provider: "Подтверждено WhatsApp",
    check: "WhatsApp не подтвердил результат. Откройте переписку с этим клиентом в WhatsApp и проверьте каждую отмеченную часть.",
    receipt: "Отправка не означает, что клиент получил или прочитал сообщение. Ручная сверка отмечается отдельно от подтверждения WhatsApp.",
    reconcile: "Записать результат проверки", outcome: "Что увидели в WhatsApp?", choose: "Выберите результат",
    sent: "Эта часть есть в отправленных", absent: "Убедился: эта часть не отправлена", note: "Где и что проверили",
    placeholder: "Например: проверил WhatsApp компании — файл клиенту не отправлен.",
    caution: "Проверяйте именно WhatsApp. Запись в BasQar не доказывает отправку. Сохранение результата ничего не отправит клиенту.",
    save: "Сохранить результат", cancel: "Отмена", saved: "Результат сохранён. Новых сообщений не отправлено.",
    retry: "Повторить неотправленное", confirm: "Отправить эти части", retryTitle: "Проверьте повторную отправку",
    retryHelp: "Будут отправлены только части из списка ниже. Уже отправленные части останутся без изменений.",
    retryDone: "Попытка завершена. Ниже — результат каждой части.", error: "Не удалось выполнить действие. Обновите результат и повторите проверку.",
    changed: "Результат изменился в другом окне или при отправке. Проверьте актуальные данные перед следующим действием.",
    refreshed: "Данные обновлены.", queued: "Повтор поставлен в очередь. Обновите результат через несколько секунд.",
  },
  kk: {
    title: "Жіберу нәтижесі", close: "Жабу", loading: "Нәтиже жүктелуде…", refresh: "Жаңарту",
    text: "Хабарлама", recipient: "Алушы", accepted: "Жіберілді", failed: "Жіберілмеді", pending: "Әлі жіберілмеді", providerId: "Жіберу нөмірі",
    unknown: "Тексеру қажет", sending: "Жіберілуде", checked: "Қызметкер тексерді", provider: "WhatsApp растады",
    check: "WhatsApp нәтижені растамады. Осы клиентпен WhatsApp хат алмасуын ашып, белгіленген әр бөлікті тексеріңіз.",
    receipt: "Жіберу клиенттің хабарламаны алғанын немесе оқығанын білдірмейді. Қолмен тексеру WhatsApp растауынан бөлек белгіленеді.",
    reconcile: "Тексеру нәтижесін жазу", outcome: "WhatsApp-та не көрдіңіз?", choose: "Нәтижені таңдаңыз",
    sent: "Бұл бөлік жіберілгендерде бар", absent: "Тексердім: бұл бөлік жіберілмеген", note: "Қайда және нені тексердіңіз",
    placeholder: "Мысалы: компанияның WhatsApp-ын тексердім — файл клиентке жіберілмеген.",
    caution: "WhatsApp-ты тексеріңіз. BasQar жазбасы жіберілгенін дәлелдемейді. Нәтижені сақтау клиентке ештеңе жібермейді.",
    save: "Нәтижені сақтау", cancel: "Бас тарту", saved: "Нәтиже сақталды. Жаңа хабарлама жіберілген жоқ.",
    retry: "Жіберілмегенді қайталау", confirm: "Осы бөліктерді жіберу", retryTitle: "Қайта жіберуді тексеріңіз",
    retryHelp: "Тек төмендегі тізімдегі бөліктер жіберіледі. Жіберілген бөліктер өзгермейді.",
    retryDone: "Әрекет аяқталды. Төменде әр бөліктің нәтижесі көрсетілген.", error: "Әрекет орындалмады. Нәтижені жаңартып, қайта тексеріңіз.",
    changed: "Нәтиже басқа терезеде немесе жіберу кезінде өзгерді. Келесі әрекет алдында өзекті деректерді тексеріңіз.",
    refreshed: "Деректер жаңартылды.", queued: "Қайталау кезекке қойылды. Бірнеше секундтан кейін нәтижені жаңартыңыз.",
  },
};
const telegramCopy = {
  ru: {
    provider: "Подтверждено Telegram",
    check: "Telegram не подтвердил результат. Проверьте наличие каждой отмеченной части у клиента или в независимом журнале бота. Если проверить нельзя, оставьте результат неизвестным.",
    receipt: "Подтверждение Telegram означает принятие сообщения ботом, а не прочтение клиентом. Ручная сверка отмечается отдельно.",
    outcome: "Что удалось подтвердить?",
    placeholder: "Например: клиент подтвердил, что получил текст, но файл не получил.",
    caution: "Сверяйте результат именно этого бота и клиента. Запись в BasQar сама по себе не доказывает отправку. Сохранение результата ничего не отправит клиенту.",
  },
  kk: {
    provider: "Telegram растады",
    check: "Telegram нәтижені растамады. Белгіленген әр бөліктің бар-жоғын клиенттен немесе боттың тәуелсіз журналынан тексеріңіз. Тексере алмасаңыз, нәтижені белгісіз күйінде қалдырыңыз.",
    receipt: "Telegram растауы хабарламаның бот арқылы қабылданғанын білдіреді, клиенттің оқығанын емес. Қолмен тексеру бөлек белгіленеді.",
    outcome: "Нені растай алдыңыз?",
    placeholder: "Мысалы: клиент мәтінді алғанын, бірақ файлды алмағанын растады.",
    caution: "Дәл осы бот пен клиенттің нәтижесін тексеріңіз. BasQar жазбасы өздігінен жіберуді дәлелдемейді. Нәтижені сақтау клиентке ештеңе жібермейді.",
  },
};
const cloudCopy = {
  ru: {
    check: "WhatsApp Cloud не подтвердил результат. Сверьте каждую отмеченную часть с получателем или в журнале провайдера. Если проверить нельзя, оставьте результат неизвестным.",
    outcome: "Что удалось подтвердить?", placeholder: "Например: провайдер подтвердил, что файл с указанным номером не доставлен.",
    caution: "Сверяйте именно этот номер компании, клиента и часть сообщения. Запись в BasQar сама по себе не доказывает доставку. Сохранение результата ничего не отправит клиенту.",
  },
  kk: {
    check: "WhatsApp Cloud нәтижені растамады. Белгіленген әр бөлікті алушымен немесе провайдер журналымен салыстырыңыз. Тексере алмасаңыз, нәтижені белгісіз күйінде қалдырыңыз.",
    outcome: "Нені растай алдыңыз?", placeholder: "Мысалы: провайдер көрсетілген нөмірі бар файлдың жеткізілмегенін растады.",
    caution: "Дәл осы компания нөмірін, клиентті және хабарлама бөлігін тексеріңіз. BasQar жазбасы жеткізілгенін дәлелдемейді. Нәтижені сақтау клиентке ештеңе жібермейді.",
  },
};
const instagramCopy = {
  ru: { provider: "Подтверждено Instagram", check: "Instagram не подтвердил результат. Проверьте именно этот ответ в переписке с клиентом в Instagram.",
    outcome: "Что удалось подтвердить?", placeholder: "Например: проверил Direct компании — этого ответа клиенту нет.",
    caution: "Сверяйте оригинал переписки Instagram. Запись в BasQar не доказывает отправку. Сохранение результата ничего не отправляет клиенту.",
    receipt: "Принятие ответа Instagram не означает его прочтения клиентом. Ручная сверка отмечается отдельно." },
  kk: { provider: "Instagram растады", check: "Instagram нәтижені растамады. Дәл осы жауапты клиентпен Instagram хат алмасуынан тексеріңіз.",
    outcome: "Нені растай алдыңыз?", placeholder: "Мысалы: компанияның Direct хаттарын тексердім — бұл жауап жіберілмеген.",
    caution: "Instagram хат алмасуын тексеріңіз. BasQar жазбасы жіберуді дәлелдемейді. Нәтижені сақтау клиентке ештеңе жібермейді.",
    receipt: "Instagram жауапты қабылдауы клиенттің оны оқығанын білдірмейді. Қолмен тексеру бөлек белгіленеді." },
};
const aiCopy = {
  ru: { title: "Результат отправки ответа ИИ", text: "Сохранённый ответ ИИ", retry: "Повторить сохранённый ответ", retryHelp: "Клиенту уйдёт сохранённый текст ниже. Новый ответ ИИ не формируется. Если вопрос или настройки изменились, повтор будет остановлен.",
    help: "Сверка не отправляет ответ и не включает ИИ. Повтор — отдельное действие после проверки результата. Если ответ устарел, подготовьте новый в диалоге." },
  kk: { title: "ЖИ жауабын жіберу нәтижесі", text: "Сақталған ЖИ жауабы", retry: "Сақталған жауапты қайталау", retryHelp: "Клиентке төмендегі сақталған мәтін жіберіледі. Жаңа ЖИ жауабы жасалмайды. Сұрақ немесе баптаулар өзгерсе, қайталау тоқтатылады.",
    help: "Тексеру жауап жібермейді және ЖИ-ді қоспайды. Қайталау — тексеруден кейінгі бөлек әрекет. Жауап ескірсе, диалогта жаңасын дайындаңыз." },
};
const blocks: Record<"ru" | "kk", Record<Exclude<MessageRetryBlock, null>, string>> = {
  ru: { permissions: "Сверить результат и повторить отправку может руководитель компании.", busy: "Отправка ещё выполняется. Обновите результат через несколько секунд.",
    unknown: "Перед повтором нужно проверить все части с неизвестным результатом.", complete: "Все части отправлены. Повтор не требуется.",
    conversation_changed: "Диалог или его получатель изменился. Повтор этой отправки недоступен.", access_changed: "У первоначального отправителя больше нет нужного доступа. Повтор недоступен.",
    connection_changed: "Подключение изменилось или отключено. Повтор через другой номер или бот недоступен.", campaign_stopped: "Рассылка остановлена. Результат можно сверить, но повтор сейчас недоступен.",
    campaign_changed: "Получатель, содержание или подтверждение рассылки изменились. Повтор этой отправки недоступен.", plan: "Текущий тариф не позволяет повторить эту отправку.",
    window_closed: "Прошло 24 часа после сообщения клиента. Канал разрешит ответ после нового сообщения клиента.",
    policy_changed: "Настройки, инструкция или база знаний ИИ изменились либо ответы сейчас запрещены. Подготовьте актуальный ответ в диалоге." },
  kk: { permissions: "Нәтижені тексеріп, қайта жіберуді компания басшысы орындай алады.", busy: "Жіберу әлі орындалуда. Бірнеше секундтан кейін нәтижені жаңартыңыз.",
    unknown: "Қайталамас бұрын нәтижесі белгісіз барлық бөлікті тексеру қажет.", complete: "Барлық бөлік жіберілді. Қайталау қажет емес.",
    conversation_changed: "Диалог немесе алушы өзгерді. Бұл жіберуді қайталау қолжетімсіз.", access_changed: "Бастапқы жіберушінің қажетті рұқсаты жоқ. Қайталау қолжетімсіз.",
    connection_changed: "Қосылым өзгерді немесе өшірілді. Басқа нөмір немесе бот арқылы қайталау қолжетімсіз.", campaign_stopped: "Тарату тоқтатылды. Нәтижені тексеруге болады, бірақ қазір қайта жіберу қолжетімсіз.",
    campaign_changed: "Таратудың алушысы, мазмұны немесе растауы өзгерді. Бұл жіберуді қайталау қолжетімсіз.", plan: "Қазіргі тариф бұл жіберуді қайталауға мүмкіндік бермейді.",
    window_closed: "Клиенттің хабарламасынан кейін 24 сағат өтті. Арна клиент жаңа хабарлама жібергеннен кейін жауап беруге рұқсат береді.",
    policy_changed: "ЖИ баптаулары, нұсқаулығы немесе білім базасы өзгерді не қазір жауап беруге тыйым салынған. Диалогта өзекті жауап дайындаңыз." },
};

export default function MessageDeliveryReview({ conversationId, messageId, onClose, onChanged }: {
  conversationId: string; messageId: string; onClose: () => void; onChanged: () => void;
}) {
  const language = useLocale() === "kk" ? "kk" : "ru";
  const heading = useId(), dialog = useRef<HTMLDivElement>(null), alive = useRef(false), busyRef = useRef(false);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const [data, setData] = useState<Review | null>(null), [busy, setBusy] = useState(false);
  const t = { ...copy[language], ...(data?.channel === "telegram" ? telegramCopy[language] : data?.channel === "whatsapp_cloud" ? cloudCopy[language] : data?.channel === "instagram" ? instagramCopy[language] : {}), ...(data?.aiReply ? aiCopy[language] : {}) };
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [partId, setPartId] = useState(""), [outcome, setOutcome] = useState<"sent" | "not_sent" | "">("");
  const [note, setNote] = useState(""), [confirmRetry, setConfirmRetry] = useState(false);
  const url = `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/delivery`;
  const resetForm = () => { setPartId(""); setOutcome(""); setNote(""); setConfirmRetry(false); };
  async function run(action?: "reconcile" | "retry") {
    if (busyRef.current || (action && !data)) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const value = await api.request<Review>(action ? `${url}/${action}` : url, action ? {
        method: "POST", body: JSON.stringify(action === "reconcile" ? { revision: data!.revision, partId, outcome, note: note.trim() } : { revision: data!.revision }),
      } : {});
      if (!alive.current) return;
      setData(value); resetForm(); setNotice(action === "reconcile" ? t.saved : action === "retry" ? value.busy ? t.queued : t.retryDone : t.refreshed);
      if (action) onChanged();
    } catch (err) {
      if (!alive.current) return;
      resetForm();
      const stale = (err as { code?: string }).code === "delivery_changed";
      setError(stale ? t.changed : language === "ru" && err instanceof Error ? err.message : t.error);
      // Never leave stale buttons enabled after a lost response. Refresh before offering a next action.
      setData(null);
      if (action) {
        try { const latest = await api.request<Review>(url); if (alive.current) setData(latest); } catch { /* Refresh button remains available. */ }
        if (alive.current) onChanged();
      }
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    busyRef.current = true; setBusy(true);
    const controller = new AbortController();
    api.request<Review>(url, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(err => { if (!controller.signal.aborted) setError(language === "ru" ? err.message : t.error); })
      .finally(() => { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false); } });
    return () => { alive.current = false; controller.abort(); };
  }, [url]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') || []);
      if (!items.length) { event.preventDefault(); dialog.current?.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); document.body.style.overflow = overflow; if (before?.isConnected) before.focus(); };
  }, []);
  const part = data?.parts.find(row => row.id === partId);
  const label = (id: string, name: string) => id === "text" ? t.text : name;
  return createPortal(<div className="delivery-review-overlay" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="delivery-review" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={heading} aria-busy={busy}>
      <header><h2 id={heading}>{t.title}</h2><button className="btn secondary" type="button" onClick={onClose}>{t.close}</button></header>
      {error ? <p className="delivery-review-error" role="alert">{error}</p> : null}
      {notice ? <p className="delivery-review-notice" role="status">{notice}</p> : null}
      {!data && !error ? <p role="status">{t.loading}</p> : null}
      {data ? <>
        {data.aiReply ? <p>{aiCopy[language].help}</p> : null}
        <div className="delivery-review-recipient"><span>{t.recipient}</span><strong>{data.recipient}</strong>
          <time dateTime={data.createdAt}>{new Date(data.createdAt).toLocaleString(language === "kk" ? "kk-KZ" : "ru-RU")}</time></div>
        {data.text ? <details><summary>{t.text}</summary><p className="delivery-review-text">{data.text}</p></details> : null}
        {data.needsCheck ? <p className="delivery-review-warning">{t.check}</p> : null}
        <ul className="delivery-review-parts">{data.parts.map(row => <li key={row.id}>
          <div className="delivery-review-part-heading"><strong>{label(row.id, row.label)}</strong><span className="delivery-review-state" data-state={row.state}>{t[row.state]}</span></div>
          {row.checkedBy ? <div className="delivery-review-evidence"><span>{t.checked}: {row.checkedBy}{row.checkedAt ? ` · ${new Date(row.checkedAt).toLocaleString(language === "kk" ? "kk-KZ" : "ru-RU")}` : ""}</span><p>{row.note}</p></div>
            : row.state === "accepted" ? <small>{t.provider}</small> : null}
          {row.providerMessageId ? <small>{t.providerId}: {row.providerMessageId}</small> : null}
          {data.canReconcile && row.state === "unknown" && partId !== row.id ? <button type="button" className="btn secondary" disabled={busy} onClick={() => {
            setPartId(row.id); setOutcome(""); setNote(""); setConfirmRetry(false); setNotice(""); setError("");
          }}>{t.reconcile}</button> : null}
        </li>)}</ul>
        {part && data.canReconcile && part.state === "unknown" ? <form className="delivery-review-form" onSubmit={event => { event.preventDefault(); if (outcome && note.trim().length >= 8) void run("reconcile"); }}>
          <h3>{label(part.id, part.label)}</h3><p>{t.caution}</p>
          <label>{t.outcome}<select value={outcome} disabled={busy} required onChange={event => setOutcome(event.target.value as typeof outcome)}>
            <option value="">{t.choose}</option><option value="sent">{t.sent}</option><option value="not_sent">{t.absent}</option></select></label>
          <label>{t.note}<textarea value={note} disabled={busy} required minLength={8} maxLength={1000} rows={3} placeholder={t.placeholder} onChange={event => setNote(event.target.value)} /></label>
          <div className="actions"><button className="btn" disabled={busy || !outcome || note.trim().length < 8}>{t.save}</button><button className="btn secondary" type="button" disabled={busy} onClick={resetForm}>{t.cancel}</button></div>
        </form> : null}
        {data.retryBlock ? <p>{blocks[language][data.retryBlock]}</p> : null}
        {data.canRetry && !confirmRetry ? <button className="btn" type="button" disabled={busy} onClick={() => { resetForm(); setConfirmRetry(true); setNotice(""); }}>{t.retry}</button> : null}
        {data.canRetry && confirmRetry ? <section className="delivery-review-form" aria-label={t.retryTitle}>
          <h3>{t.retryTitle}</h3><strong>{data.recipient}</strong><p>{t.retryHelp}</p>
          {data.aiReply ? <p className="delivery-review-text">{data.text}</p> : null}
          <ul>{data.parts.filter(row => row.state !== "accepted").map(row => <li key={row.id}>{label(row.id, row.label)}</li>)}</ul>
          <div className="actions"><button className="btn" type="button" disabled={busy} onClick={() => void run("retry")}>{t.confirm}</button><button className="btn secondary" type="button" disabled={busy} onClick={resetForm}>{t.cancel}</button></div>
        </section> : null}
        <small className="delivery-review-footnote">{t.receipt}</small>
      </> : null}
      <button className="btn secondary" type="button" disabled={busy} onClick={() => void run()}>{t.refresh}</button>
    </div>
  </div>, document.body);
}
