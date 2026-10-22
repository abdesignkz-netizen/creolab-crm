import { z } from "zod";

export const AI_KNOWLEDGE_FILE_BYTES = 10 * 1024 * 1024;
export const AI_KNOWLEDGE_CATEGORIES = ["company", "offerings", "prices", "terms", "faq", "other"] as const;
export type AiKnowledgeCategory = typeof AI_KNOWLEDGE_CATEGORIES[number];
export const aiKnowledgeSourceSchema = z.object({
  kind: z.enum(["file", "url"]),
  name: z.string().trim().min(1).max(300),
  url: z.string().url().max(2000).refine(value => {
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
    catch { return false; }
  }).optional(),
  importedAt: z.string().datetime(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  ocr: z.boolean(),
  reviewedAt: z.string().datetime().optional(),
}).strict().refine(source => source.kind !== "url" || Boolean(source.url), { message: "Для веб-материала нужна ссылка на источник", path: ["url"] });
export type AiKnowledgeSource = z.infer<typeof aiKnowledgeSourceSchema>;
export type AiKnowledgeImportPreview = {
  title: string;
  content: string;
  category: AiKnowledgeCategory;
  source: AiKnowledgeSource;
  warnings: string[];
  pages: number;
  links: Array<{ title: string; url: string }>;
};
export type AiKnowledgeImportInput = { kind: "file"; fileName: string; fileBase64: string } | { kind: "url"; url: string };

/** Compare literal price statements only; this is a review hint, not a semantic fact checker. */
export function knowledgePriceConflicts(incoming: string, existing: Array<{ title: string; content: string }>) {
  const price = /\d[\d \t\u00a0.,]*[ \t\u00a0]*(?:₸|тенге|тг\.?|KZT|руб\.?|₽|USD|EUR|\$|€)/giu;
  function statements(content: string) {
    return content.split(/\n/).flatMap(line => {
      const amounts = [...line.matchAll(price)].map(match => match[0].replace(/\s/g, "").toLowerCase());
      const key = line.toLowerCase().replace(price, "#").replace(/[^\p{L}#]/gu, "");
      return amounts.length && key.replace(/#/g, "").length >= 5 ? [{ key, amounts: amounts.join("|"), line: line.trim().slice(0, 300) }] : [];
    });
  }
  const byKey = new Map<string, ReturnType<typeof statements>>();
  for (const value of statements(incoming)) byKey.set(value.key, [...(byKey.get(value.key) || []), value].slice(0, 8));
  const result: Array<{ title: string; previous: string; incoming: string }> = [];
  for (const item of existing) for (const previous of statements(item.content)) for (const value of byKey.get(previous.key) || []) {
    if (value.amounts !== previous.amounts) result.push({ title: item.title, previous: previous.line, incoming: value.line });
    if (result.length >= 8) return result;
  }
  return result;
}
