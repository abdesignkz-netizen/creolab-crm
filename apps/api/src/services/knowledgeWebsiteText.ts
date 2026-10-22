import { publicMediaUrl } from "../lib/publicMedia.ts";
import { ApiError } from "../errors.ts";

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£" };
export function decodeKnowledgeHtml(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (original, entity: string) => {
    if (!entity.startsWith("#")) return entities[entity] ?? original;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}
const normalize = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const omitted = new Set(["script", "style", "template", "noscript", "svg", "canvas", "nav", "header", "footer", "form", "button", "iframe", "object", "embed"]);
const rawText = new Set(["script", "style", "textarea", "title"]);
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const blocks = new Set(["p", "div", "section", "article", "main", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "br", "hr"]);

/** A bounded text-only reader. Never executes scripts, renders markup or follows page assets. */
export function extractKnowledgeWebsite(html: string, pageUrl: string) {
  if (html.length > 2_000_000) throw new ApiError(422, "knowledge_page_large", "Страница слишком большая. Добавьте ссылку на отдельную услугу или вставьте нужный текст.");
  const base = publicMediaUrl(pageUrl);
  const stack: Array<{ tag: string; hidden: boolean; focused: boolean; head: boolean; href?: string; anchor: string[] }> = [];
  const body: string[] = [], focused: string[] = [], titles: string[] = [];
  const links: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  // Tag scanning is linear; quotes inside attributes cannot terminate a tag.
  const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+|</g;
  let match: RegExpExecArray | null;
  function addText(value: string) {
    const text = decodeKnowledgeHtml(value);
    const top = stack.at(-1);
    const anchor = [...stack].reverse().find(item => item.tag === "a");
    if (anchor && anchor.anchor.length < 30) anchor.anchor.push(text);
    if (top?.tag === "title") { titles.push(text); return; }
    if (top?.hidden || top?.head) return;
    body.push(text);
    if (top?.focused) focused.push(text);
  }
  function close(tag: string) {
    const index = stack.map(item => item.tag).lastIndexOf(tag);
    if (index < 0) return;
    for (const item of stack.splice(index)) {
      if (item.tag !== "a" || !item.href || links.length >= 30) continue;
      try {
        const url = publicMediaUrl(new URL(item.href, base).href); url.hash = "";
        if (url.origin !== base.origin || url.href === base.href || seen.has(url.href) || url.href.length > 2000) continue;
        const title = normalize(item.anchor.join("")).slice(0, 150);
        if (!title) continue;
        links.push({ title, url: url.href }); seen.add(url.href);
      } catch { /* Exclude unsupported or private-looking links from the picker. */ }
    }
  }
  while ((match = tokens.exec(html))) {
    const token = match[0], top = stack.at(-1);
    if (rawText.has(top?.tag || "")) {
      if (new RegExp(`^<\\/\\s*${top!.tag}\\s*>$`, "i").test(token)) close(top!.tag);
      else if (top?.tag === "title") titles.push(decodeKnowledgeHtml(token));
      continue;
    }
    if (token.startsWith("<!")) continue;
    const closing = token.match(/^<\/([\w:-]+)/);
    if (closing) { const tag = closing[1].toLowerCase(); if (blocks.has(tag)) addText("\n"); close(tag); continue; }
    const opening = token.match(/^<([\w:-]+)/);
    if (!opening) { addText(token); continue; }
    const tag = opening[1].toLowerCase();
    const attrs: Record<string, string> = {};
    for (const attribute of token.slice(opening[0].length, -1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[attribute[1].toLowerCase()] = decodeKnowledgeHtml(attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    if (blocks.has(tag)) addText("\n");
    if (tag === "td" || tag === "th") addText(" | ");
    if (!voidTags.has(tag)) {
      if (stack.length > 128) throw new ApiError(422, "knowledge_page_unreadable", "Не удалось разобрать страницу. Вставьте её текст или загрузите документ.");
      stack.push({ tag, hidden: Boolean(top?.hidden || omitted.has(tag) || "hidden" in attrs || attrs["aria-hidden"] === "true" || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style || "")),
        focused: Boolean(top?.focused || tag === "main" || tag === "article"), head: Boolean(top?.head || tag === "head"), href: tag === "a" ? attrs.href : undefined, anchor: [] });
    }
  }
  const main = normalize(focused.join(""));
  const content = main.length >= 80 ? main : normalize(body.join(""));
  const title = normalize(titles.join(" ")).slice(0, 300) || base.hostname;
  if (content.length < 60 || /(?:^|\s)(?:log in|login|sign in|вход|войти)(?:\s|$)/i.test(title)
    || /(?:enable javascript|checking your browser|verify you are human|доступ ограничен|подтвердите, что вы человек)/i.test(content.slice(0, 800))) {
    throw new ApiError(422, "knowledge_page_unreadable", "На странице нет доступного текста или требуется вход. Загрузите PDF, изображение или вставьте текст публикации вручную.");
  }
  return { title, content, links };
}
