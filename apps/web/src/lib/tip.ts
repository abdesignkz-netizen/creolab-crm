/** Hover hint props for buttons/links. Prefer data-tip for styled tooltip; title as fallback. */
export function tip(text: string): { "data-tip": string; title: string } {
  return { "data-tip": text, title: text };
}
