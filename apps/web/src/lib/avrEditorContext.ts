/** A saved document owns its requisites; current cards must not impersonate its parties. */
export function avrEditorContext(context: any, document: any) {
  const source = document?.source;
  if (!source?.seller || !source?.buyer) return context;
  return {
    ...context,
    organization: { ...source.seller },
    company: { ...source.buyer, id: document.companyId || context.company?.id },
  };
}

export function mergeAvrRequisitesRefresh(current: "seller" | "buyer" | "all" | undefined, next: "seller" | "buyer") {
  return current && current !== next ? "all" : next;
}
