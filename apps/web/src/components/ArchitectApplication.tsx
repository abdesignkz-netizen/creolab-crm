import { useEffect, useRef, useState } from "react";
import type { ActionRunView, ArchitectApplyReview } from "@creolab/contracts";
import { architectApi } from "../lib/aiArchitect";
import { actionApi } from "../lib/aiActions";
import { InlineFeedback } from "./InlineFeedback";
import { ArchitectApplicationReview } from "./ArchitectApplicationReview";

export function ArchitectApplication({ draftId, revision, locale, resume, onRun, onPending }: {
  draftId: string; revision: number; locale: "ru" | "kk"; resume: boolean; onRun: (run: ActionRunView) => void; onPending: (pending: boolean) => void;
}) {
  const t = (ru: string, kk: string) => locale === "kk" ? kk : ru;
  const [review, setReview] = useState<ArchitectApplyReview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [confirmed, setConfirmed] = useState(false);
  const active = useRef(true), version = useRef(0), request = useRef<{ hash: string; id: string } | null>(null), cancelId = useRef<string | null>(null);
  const callbacks = useRef({ onRun, onPending }); callbacks.current = { onRun, onPending };
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; version.current++; callbacks.current.onPending(false); }; }, []);
  useEffect(() => { if (resume) void refresh(); }, []);
  useEffect(() => { cancelId.current = null; }, [review?.run?.id]);
  function receive(next: ArchitectApplyReview) {
    setReview(next);
    if (next.canApply && next.run && ["failed", "cancelled", "expired"].includes(next.run.status)) request.current = null;
    if (next.run) callbacks.current.onRun(next.run);
    callbacks.current.onPending(Boolean(next.run && ["queued", "running"].includes(next.run.status)));
  }
  async function refresh() {
    if (busy) return; const v = ++version.current; setBusy(true); setError(""); setConfirmed(false);
    try { const next = await architectApi.review(draftId, revision); if (active.current && v === version.current) { receive(next); heading.current?.focus(); } }
    catch (e) { if (active.current && v === version.current) setError(e instanceof Error ? e.message : t("Не удалось проверить проект", "Жобаны тексеру мүмкін болмады")); }
    finally { if (active.current && v === version.current) setBusy(false); }
  }
  useEffect(() => {
    if (!review?.run || !["queued", "running"].includes(review.run.status) || error) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const v = version.current;
      try { const next = await architectApi.review(draftId, revision); if (stopped || !active.current) return; if (v === version.current) receive(next); }
      catch (e) { if (!stopped && active.current && v === version.current) setError(e instanceof Error ? e.message : t("Не удалось обновить результат. Проверьте ещё раз.", "Нәтижені жаңарту мүмкін болмады. Қайта тексеріңіз.")); }
      if (!stopped) timer = setTimeout(poll, 4000);
    };
    timer = setTimeout(poll, 2000); return () => { stopped = true; clearTimeout(timer); };
  }, [review?.run?.id, review?.run?.status, error, draftId, revision]);
  async function apply() {
    if (!review?.canApply || !confirmed || busy) return;
    const v = ++version.current; setBusy(true); setError("");
    if (request.current?.hash !== review.applicationHash) request.current = { hash: review.applicationHash, id: crypto.randomUUID() };
    try {
      const run = await architectApi.apply(draftId, { revision, confirmed: true, applicationHash: review.applicationHash, requestId: request.current.id });
      if (active.current && v === version.current) { receive({ ...review, canApply: false, run }); setConfirmed(false); }
    } catch (e) { if (active.current && v === version.current) setError(e instanceof Error ? e.message : t("Не удалось применить проект. Обновите проверку.", "Жобаны қолдану мүмкін болмады. Тексеруді жаңартыңыз.")); }
    finally { if (active.current && v === version.current) setBusy(false); }
  }
  async function cancel() {
    if (!review?.run?.canCancel || busy) return;
    const v = ++version.current; setBusy(true); setError(""); cancelId.current ||= crypto.randomUUID();
    try { const run = await actionApi.cancel(review.run, cancelId.current); if (active.current && v === version.current) { receive({ ...review, canApply: false, run }); setConfirmed(false); } }
    catch (e) { if (active.current && v === version.current) setError(e instanceof Error ? e.message : t("Не удалось отменить применение", "Қолдануды тоқтату мүмкін болмады")); }
    finally { if (active.current && v === version.current) setBusy(false); }
  }
  return <section className="architect-application" aria-busy={busy}>
    <h2 ref={heading} tabIndex={-1}>{t("Применение проекта", "Жобаны қолдану")}</h2>
    {error && <InlineFeedback kind="error">{error}</InlineFeedback>}
    {!review ? <><p>{t("Проект сохранён. Проверьте точный список изменений, прежде чем подтвердить применение.", "Жоба сақталды. Қолдануды растаудан бұрын нақты өзгерістер тізімін тексеріңіз.")}</p><button className="btn" type="button" disabled={busy} onClick={() => void refresh()}>{busy ? t("Проверяем…", "Тексерілуде…") : t("Проверить и применить", "Тексеру және қолдану")}</button></>
      : <ArchitectApplicationReview review={review} locale={locale} busy={busy} confirmed={confirmed} onConfirm={setConfirmed} onApply={() => void apply()} onCancel={() => void cancel()} onRefresh={() => void refresh()} />}
  </section>;
}
