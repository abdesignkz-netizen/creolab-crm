import { useEffect, useMemo, useRef, useState } from "react";
import { AI_KNOWLEDGE_CATEGORIES, AI_KNOWLEDGE_FILE_BYTES, compileAiManagerDraft, knowledgePriceConflicts, type AiManagerDraft, type AiKnowledgeCategory, type AiKnowledgeImportInput, type AiKnowledgeImportPreview } from "@creolab/contracts";
import { useCompanyConfiguration } from "../lib/companyConfiguration";
import { useLocale } from "../lib/session";
import { InlineFeedback } from "./InlineFeedback";

type Material = AiManagerDraft["knowledge"][number];
const categoryNames = { company: ["Компания", "Компания", "Company"], offerings: ["Услуги и товары", "Қызмет пен тауар", "Services and products"], prices: ["Цены", "Бағалар", "Prices"], terms: ["Условия", "Шарттар", "Terms"], faq: ["Ответы на вопросы", "Сұрақтарға жауап", "Answers"], other: ["Другие материалы", "Басқа материалдар", "Other material"] } as const;
const clean = (value: string) => value.replace(/\s+/g, " ").trim();

export function AiKnowledgeMaterials({ draft, onChange, onPendingChange }: { draft: AiManagerDraft; onChange: (items: Material[]) => void; onPendingChange: (pending: boolean) => void }) {
  const { api } = useCompanyConfiguration();
  const locale = useLocale();
  const t = (ru: string, kk: string, en: string) => locale === "kk" ? kk : locale === "en" ? en : ru;
  const categoryLabel = (value: AiKnowledgeCategory) => { const names = categoryNames[value]; return t(names[0], names[1], names[2]); };
  const [mode, setMode] = useState<"url" | null>(null), [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<AiKnowledgeImportPreview | null>(null), [reviewed, setReviewed] = useState(false), [replaceId, setReplaceId] = useState("");
  const [links, setLinks] = useState<AiKnowledgeImportPreview["links"]>([]), [openId, setOpenId] = useState<string | null>(null), [deleteId, setDeleteId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null), previewRef = useRef<HTMLDivElement>(null), requestRef = useRef<AbortController | null>(null), inFlight = useRef(false);
  useEffect(() => { onPendingChange(loading || Boolean(preview)); }, [loading, preview, onPendingChange]);
  useEffect(() => () => { requestRef.current?.abort(); }, []);
  const existing = draft.knowledge.filter(item => item.id !== replaceId);
  const duplicate = Boolean(preview?.content.trim() && existing.some(item => clean(item.content) === clean(preview.content)));
  const unchanged = Boolean(preview && replaceId && draft.knowledge.some(item => item.id === replaceId && item.title === preview.title && clean(item.content) === clean(preview.content) && (item.category || "other") === preview.category));
  const conflicts = useMemo(() => preview ? knowledgePriceConflicts(preview.content, compileAiManagerDraft({ ...draft, knowledge: existing }).knowledge) : [], [preview?.content, draft, replaceId]);
  const proposed = preview ? { id: replaceId || "preview", title: preview.title.trim(), content: preview.content.trim(), category: preview.category, source: { ...preview.source, reviewedAt: new Date().toISOString() } } : null;
  const nextItems = proposed ? replaceId ? draft.knowledge.map(item => item.id === replaceId ? proposed : item) : [...draft.knowledge, proposed] : draft.knowledge;
  const tooLarge = Boolean(proposed && (proposed.content.length > 65000 || compileAiManagerDraft({ ...draft, knowledge: nextItems }).issues.some(item => item.code === "context_size")));
  const canAdd = Boolean(proposed?.title && proposed.content && reviewed && !tooLarge && !duplicate && !unchanged && (replaceId || draft.knowledge.length < 40));

  async function read(input: AiKnowledgeImportInput | (() => Promise<AiKnowledgeImportInput>)) {
    if (inFlight.current) return;
    inFlight.current = true; setLoading(true); setError(""); setNotice(""); setReviewed(false);
    const controller = new AbortController(); requestRef.current = controller;
    try {
      const body = typeof input === "function" ? await input() : input;
      if (controller.signal.aborted) return;
      const result = await api.previewAiKnowledgeImport(body, controller.signal);
      if (controller.signal.aborted) return;
      const sameSource = draft.knowledge.find(item => result.source.kind === "url" ? item.source?.url === result.source.url : item.source?.kind === "file" && item.source.name === result.source.name);
      setReplaceId(sameSource?.id || ""); setPreview(result); setMode(null); setLinks([]);
      requestAnimationFrame(() => { previewRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }); previewRef.current?.focus({ preventScroll: true }); });
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : t("Не удалось прочитать материал", "Материал оқылмады", "Could not read material")); }
    finally { inFlight.current = false; setLoading(false); requestRef.current = null; }
  }
  async function readFile(file: File | undefined) {
    if (!file || inFlight.current) return;
    setError("");
    if (!file.size || file.size > AI_KNOWLEDGE_FILE_BYTES) { setError(t("Выберите непустой файл до 10 МБ.", "10 МБ-қа дейінгі бос емес файлды таңдаңыз.", "Select a non-empty file up to 10 MB.")); return; }
    if (!/\.(pdf|docx|png|jpe?g|xlsx|csv|txt|md)$/i.test(file.name)) { setError(t("Поддерживаются PDF, DOCX, PNG, JPG, XLSX, CSV, TXT и MD.", "PDF, DOCX, PNG, JPG, XLSX, CSV, TXT және MD қолдау көрсетіледі.", "Supported: PDF, DOCX, PNG, JPG, XLSX, CSV, TXT and MD.")); return; }
    await read(async () => {
      const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error(t("Не удалось прочитать файл", "Файл оқылмады", "Could not read file"))); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(file); });
      return { kind: "file", fileName: file.name, fileBase64: base64 };
    });
  }
  function accept() {
    if (!canAdd || !proposed || !preview) return;
    const item = { ...proposed, id: replaceId || crypto.randomUUID() };
    onChange(replaceId ? draft.knowledge.map(current => current.id === replaceId ? item : current) : [...draft.knowledge, item]);
    setOpenId(item.id); setLinks(preview.links); setPreview(null); setReplaceId(""); setReviewed(false);
    setNotice(t("Материал добавлен в анкету. Сохраните черновик; для ответов клиентам изменения начнут действовать после проверки и публикации.", "Материал анкетаға қосылды. Жобаны сақтаңыз; клиент жауаптарына тек тексеру мен жариялаудан кейін қолданылады.", "Material added to the questionnaire. Save the draft; customer replies change only after testing and publishing."));
  }
  function editItem(id: string, patch: Partial<Material>) { onChange(draft.knowledge.map(item => item.id === id ? { ...item, ...patch } : item)); }
  function manual() {
    const id = crypto.randomUUID(); onChange([...draft.knowledge, { id, title: "", content: "", category: "other" }]); setOpenId(id); setNotice("");
  }
  return <div className="ai-knowledge">
    <div className="ai-knowledge-heading"><div><h4>{t("Знания из ваших материалов", "Материалдарыңыздан алынған білім", "Knowledge from your materials")}</h4><p>{t("Добавьте прайс, каталог, описание услуг или страницу сайта. Проверьте текст перед использованием в ответах ИИ.", "Прайс, каталог, қызмет сипаттамасын немесе сайт бетін қосыңыз. ЖИ жауабында қолданар алдында мәтінді тексеріңіз.", "Add a price list, catalog, service description or web page. Review the text before AI uses it.")}</p></div></div>
    <div className="ai-knowledge-methods">
      <button type="button" onClick={() => fileRef.current?.click()} disabled={loading || Boolean(preview)}><b>{t("Загрузить материалы", "Материал жүктеу", "Upload material")}</b><span>PDF · Word · PNG / JPG · Excel</span></button>
      <button type="button" onClick={() => { setMode("url"); setError(""); setNotice(""); }} disabled={loading || Boolean(preview)}><b>{t("Добавить ссылку", "Сілтеме қосу", "Add a link")}</b><span>{t("Сайт или публичная страница", "Сайт немесе ашық бет", "Website or public page")}</span></button>
      <button type="button" onClick={manual} disabled={loading || Boolean(preview) || draft.knowledge.length >= 40}><b>{t("Заполнить вручную", "Қолмен толтыру", "Write manually")}</b><span>{t("Свой текст или готовые ответы", "Өз мәтініңіз не дайын жауаптар", "Your text or approved answers")}</span></button>
    </div>
    <input ref={fileRef} type="file" accept=".pdf,.docx,.png,.jpg,.jpeg,.xlsx,.csv,.txt,.md" hidden onChange={event => { void readFile(event.target.files?.[0]); event.target.value = ""; }} />
    <p className="ai-setup-help">{t("Максимум 10 МБ на файл; для быстрой загрузки рекомендуем до 5 МБ. PDF — до 20 страниц, сканы удобнее загружать по 5–10 страниц. Изображения — до 12 млн пикселей. Сохраняется извлечённый текст; оригиналы файлов в базу знаний не сохраняются.", "Бір файл 10 МБ-қа дейін; жылдам жүктеу үшін 5 МБ-қа дейін ұсынамыз. PDF — 20 бетке дейін; скандарды 5–10 беттен жүктеген ыңғайлы. Сурет — 12 млн пиксельге дейін. Алынған мәтін сақталады; түпнұсқа файл білім базасына сақталмайды.", "Maximum 10 MB per file; up to 5 MB is recommended for quick uploads. PDFs: up to 20 pages; scans work best in 5–10-page batches. Images: up to 12 megapixels. Extracted text is saved; original files are not retained in the knowledge base.")}</p>
    {mode === "url" && !preview && <div className="ai-knowledge-link-form"><label className="ai-setup-field"><span>{t("Ссылка на страницу", "Бет сілтемесі", "Page URL")}</span><input type="url" value={url} placeholder="https://company.kz/services" onChange={event => setUrl(event.target.value)} disabled={loading} /></label><p className="ai-setup-help">{t("Читаем только выбранную страницу. Для соцсетей доступен текст открытых страниц; закрытые профили, ленты, видео и страницы со входом не импортируются. Их текст можно вставить вручную.", "Тек таңдалған бет оқылады. Әлеуметтік желілердің ашық бет мәтіні қолжетімді; жабық профиль, лента, видео және кіру талап етілетін бет импортталмайды. Мәтінді қолмен қоюға болады.", "Only the selected page is read. Public social page text may be available; private profiles, feeds, video and sign-in pages are not imported. Paste their text manually instead.")}</p><div className="ai-setup-actions"><button type="button" className="btn" disabled={loading || !url.trim()} onClick={() => void read({ kind: "url", url: /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}` })}>{t("Прочитать страницу", "Бетті оқу", "Read page")}</button><button type="button" className="btn secondary" disabled={loading} onClick={() => setMode(null)}>{t("Закрыть", "Жабу", "Close")}</button></div></div>}
    {loading && <div className="ai-knowledge-progress" role="status"><b>{t("Читаем материал…", "Материал оқылуда…", "Reading material…")}</b><p>{t("Для сканов распознавание может занять до полутора минут. Страницу можно не прокручивать — результат появится здесь.", "Сканды тану бір жарым минутқа дейін созылуы мүмкін. Нәтиже осы жерде көрсетіледі.", "Scanned documents can take up to 90 seconds. The result will appear here.")}</p></div>}
    {error && <InlineFeedback kind="error">{error}</InlineFeedback>}
    {notice && <InlineFeedback kind="success">{notice}</InlineFeedback>}
    {preview && <div className="ai-knowledge-preview" ref={previewRef} tabIndex={-1}>
      <h4>{t("Проверьте извлечённый текст", "Алынған мәтінді тексеріңіз", "Review extracted text")}</h4>
      <p className="ai-knowledge-source">{t("Источник", "Дереккөз", "Source")}: {preview.source.name}{preview.source.url && <> · <a href={preview.source.url} target="_blank" rel="noopener noreferrer">{t("Открыть страницу", "Бетті ашу", "Open page")}</a></>}{preview.pages > 0 && <> · {preview.pages} {t("стр.", "бет", "page(s)")}</>}</p>
      {preview.warnings.map(warning => <p className="ai-knowledge-warning" key={warning}>{warning}</p>)}
      <div className="ai-setup-row"><label className="ai-setup-field"><span>{t("Название материала", "Материал атауы", "Material title")}</span><input value={preview.title} maxLength={300} onChange={event => { setPreview({ ...preview, title: event.target.value }); setReviewed(false); }} /></label><label className="ai-setup-field"><span>{t("Раздел базы знаний", "Білім базасының бөлімі", "Knowledge category")}</span><select value={preview.category} onChange={event => setPreview({ ...preview, category: event.target.value as AiKnowledgeCategory })}>{AI_KNOWLEDGE_CATEGORIES.map(category => <option key={category} value={category}>{categoryLabel(category)}</option>)}</select></label></div>
      <label className="ai-setup-field"><span>{t("Текст для ответов ИИ — можно исправить", "ЖИ жауабының мәтіні — түзетуге болады", "Text for AI replies — editable")}</span><textarea rows={12} value={preview.content} maxLength={120000} onChange={event => { setPreview({ ...preview, content: event.target.value }); setReviewed(false); }} /></label>
      {draft.knowledge.length > 0 && <label className="ai-setup-field"><span>{t("Как добавить", "Қосу тәсілі", "How to add")}</span><select value={replaceId} onChange={event => { setReplaceId(event.target.value); setReviewed(false); }}><option value="">{t("Новый материал", "Жаңа материал", "New material")}</option>{draft.knowledge.map(item => <option value={item.id} key={item.id}>{t("Обновить", "Жаңарту", "Replace")}: {item.title || t("Без названия", "Атаусыз", "Untitled")}</option>)}</select></label>}
      {replaceId && <details><summary>{t("Посмотреть прежний текст для сравнения", "Салыстыру үшін бұрынғы мәтін", "View previous text to compare")}</summary><pre>{draft.knowledge.find(item => item.id === replaceId)?.content}</pre></details>}
      {conflicts.length > 0 && <div className="ai-knowledge-warning"><b>{t("Возможные расхождения в ценах", "Бағаларда айырмашылық болуы мүмкін", "Possible price conflicts")}</b>{conflicts.map((conflict, i) => <p key={i}>{conflict.title}: «{conflict.previous}» → «{conflict.incoming}»</p>)}<p>{t("Проверьте и исправьте условия. Эта проверка не обнаруживает все смысловые противоречия.", "Шарттарды тексеріп түзетіңіз. Тексеру барлық мағыналық қайшылықтарды анықтамайды.", "Review and correct the terms. This check cannot detect every semantic conflict.")}</p></div>}
      {duplicate && <InlineFeedback kind="info" className="ai-knowledge-warning">{t("Такой текст уже добавлен. Обновите существующий материал или закройте просмотр.", "Мұндай мәтін бұрын қосылған. Бар материалды жаңартыңыз немесе жабыңыз.", "This text is already included. Replace the existing material or close the preview.")}</InlineFeedback>}
      {unchanged && <p role="status">{t("Текст совпадает с сохранённым материалом. Обновление не требуется.", "Мәтін сақталған материалмен бірдей. Жаңарту қажет емес.", "The text matches the saved material. No update is needed.")}</p>}
      {tooLarge && <InlineFeedback kind="info" className="ai-knowledge-warning">{t("Материал превышает доступный объём базы знаний. Сократите текст или удалите ненужные материалы. Ничего не обрезается автоматически.", "Материал білім базасының көлемінен асады. Мәтінді қысқартыңыз немесе қажетсіз материалдарды жойыңыз. Мәтін автоматты түрде қиылмайды.", "This exceeds the knowledge budget. Shorten the text or remove unnecessary material. Nothing is truncated automatically.")}</InlineFeedback>}
      {!replaceId && draft.knowledge.length >= 40 && <p role="alert">{t("Достигнут лимит 40 материалов. Выберите материал для обновления.", "40 материал шегіне жетті. Жаңартылатын материалды таңдаңыз.", "The 40-material limit is reached. Select a material to replace.")}</p>}
      <label className="ai-knowledge-review"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /><span>{t("Я проверил текст, цены и условия. Эти сведения можно использовать в ответах клиентам.", "Мәтін, баға мен шарттарды тексердім. Бұл деректі клиент жауаптарында қолдануға болады.", "I reviewed the text, prices and terms. These facts may be used in customer replies.")}</span></label>
      <div className="ai-setup-actions"><button type="button" className="btn" disabled={!canAdd} onClick={accept}>{replaceId ? t("Обновить в черновике", "Жобада жаңарту", "Replace in draft") : t("Добавить в черновик", "Жобаға қосу", "Add to draft")}</button><button type="button" className="btn secondary" onClick={() => { setPreview(null); setReplaceId(""); setReviewed(false); }}>{t("Не добавлять", "Қоспау", "Discard")}</button></div>
      <p className="ai-setup-help">{t("Затем сохраните черновик, проверьте ответы и опубликуйте изменения на последнем шаге мастера.", "Содан кейін жобаны сақтап, жауаптарды тексеріңіз және шебердің соңғы қадамында жариялаңыз.", "Then save the draft, test replies and publish changes in the final setup step.")}</p>
    </div>}
    {links.length > 0 && !preview && !loading && <details className="ai-knowledge-pages"><summary>{t("Добавить другие страницы этого сайта", "Осы сайттың басқа беттерін қосу", "Add other pages from this website")} · {links.length}</summary><div>{links.map(link => <button className="btn secondary" type="button" key={link.url} onClick={() => void read({ kind: "url", url: link.url })}>{link.title}<small>{link.url}</small></button>)}</div></details>}
    <div className="ai-knowledge-list-heading"><h4>{t("Материалы в анкете", "Анкетадағы материалдар", "Questionnaire materials")}</h4><span>{draft.knowledge.length} / 40</span></div>
    {!draft.knowledge.length && <p className="ai-knowledge-empty">{t("Материалов пока нет. Начните с прайса, описания услуг или страницы «О компании».", "Материал әлі жоқ. Прайс, қызмет сипаттамасы не «Компания туралы» бетінен бастаңыз.", "No material yet. Start with a price list, service description or About page.")}</p>}
    <div className="ai-knowledge-materials">{draft.knowledge.map(item => <details key={item.id} className="ai-knowledge-material" open={openId === item.id} onToggle={event => { if (event.currentTarget.open) setOpenId(item.id); else if (openId === item.id) setOpenId(null); }}>
      <summary><span><b>{item.title || t("Новый материал", "Жаңа материал", "New material")}</b><small>{categoryLabel(item.category || "other")} · {item.source?.name || t("Добавлен вручную", "Қолмен қосылған", "Added manually")}</small></span></summary>
      <div className="ai-knowledge-material-body">
        {item.source && <p className="ai-knowledge-source">{t("Импортирован", "Импортталған", "Imported")}: {new Date(item.source.importedAt).toLocaleDateString(locale === "kk" ? "kk-KZ" : locale === "en" ? "en-GB" : "ru-RU")}{item.source.url && <> · <a href={item.source.url} target="_blank" rel="noopener noreferrer">{t("Источник", "Дереккөз", "Source")}</a></>}</p>}
        <div className="ai-setup-row"><label className="ai-setup-field"><span>{t("Название", "Атауы", "Title")}</span><input id={`ai-setup-knowledge.${draft.knowledge.indexOf(item)}.title`} value={item.title} maxLength={300} onChange={event => editItem(item.id, { title: event.target.value })} /></label><label className="ai-setup-field"><span>{t("Раздел", "Бөлім", "Category")}</span><select value={item.category || "other"} onChange={event => editItem(item.id, { category: event.target.value as AiKnowledgeCategory })}>{AI_KNOWLEDGE_CATEGORIES.map(category => <option key={category} value={category}>{categoryLabel(category)}</option>)}</select></label></div>
        <label className="ai-setup-field"><span>{t("Содержание", "Мазмұны", "Content")}</span><textarea id={`ai-setup-knowledge.${draft.knowledge.indexOf(item)}.content`} rows={7} maxLength={65000} value={item.content} onChange={event => editItem(item.id, { content: event.target.value })} /></label>
        {item.source && !item.source.reviewedAt && <label className="ai-knowledge-review"><input type="checkbox" onChange={event => { if (event.target.checked) editItem(item.id, { source: { ...item.source!, reviewedAt: new Date().toISOString() } }); }} /><span>{t("Сведения проверены и актуальны", "Деректер тексерілген және өзекті", "These facts are reviewed and current")}</span></label>}
        <div className="ai-setup-actions">{item.source?.url && <button type="button" className="btn secondary" disabled={loading || Boolean(preview)} onClick={() => void read({ kind: "url", url: item.source!.url! })}>{t("Проверить обновления страницы", "Бет жаңартуын тексеру", "Check page for updates")}</button>}<button type="button" className="ai-setup-remove" onClick={() => setDeleteId(item.id)}>{t("Удалить материал", "Материалды жою", "Remove material")}</button></div>
        {deleteId === item.id && <div className="ai-knowledge-warning"><p>{t("Удалить из черновика? Действующие ответы изменятся только после публикации.", "Жобадан жою керек пе? Қолданыстағы жауап тек жариялаудан кейін өзгереді.", "Remove from the draft? Live replies change only after publishing.")}</p><div className="ai-setup-actions"><button type="button" className="btn secondary" onClick={() => { onChange(draft.knowledge.filter(current => current.id !== item.id)); setDeleteId(null); }}>{t("Удалить", "Жою", "Remove")}</button><button type="button" className="btn secondary" onClick={() => setDeleteId(null)}>{t("Оставить", "Қалдыру", "Keep")}</button></div></div>}
      </div>
    </details>)}</div>
  </div>;
}
