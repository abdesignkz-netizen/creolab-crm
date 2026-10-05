import { systemText } from "./systemLocale.ts";

export type TaskTitlePresentation = { kind: "inquiry_contact"; subject: string };

/** Recognize the exact system template with provenance; never rewrite a user task. */
export function taskTitlePresentation(task: {
  title?: string | null; source?: string | null; dedupeKey?: string | null;
}): TaskTitlePresentation | null {
  if (task.source !== "rule" || !task.dedupeKey?.startsWith("inquiry-process:")) return null;
  const prefix = "Связаться с клиентом: ";
  if (!task.title?.startsWith(prefix)) return null;
  return { kind: "inquiry_contact", subject: task.title.slice(prefix.length) };
}

export function localizedTaskTitle(locale: string, task: {
  title?: string | null; source?: string | null; dedupeKey?: string | null;
  titlePresentation?: TaskTitlePresentation | null;
}) {
  const presentation = task.titlePresentation || taskTitlePresentation(task);
  if (presentation?.kind !== "inquiry_contact") return task.title || "";
  // Only default subjects are product copy. Real inquiry subjects remain verbatim.
  const subject = ["Заявка из WhatsApp", "Заявка с сайта", "заявка"].includes(presentation.subject)
    ? systemText(locale, presentation.subject) : presentation.subject;
  return systemText(locale, "Связаться с клиентом: {p0}", { p0: subject });
}
