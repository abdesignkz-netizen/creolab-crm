import type { PrismaClient } from "@creolab/db";
import { upsertSupportCatalog, SUPPORT_CATEGORIES } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { requirePlatformAdmin, requireTenant } from "../lib/access.ts";

export const SUPPORT_CATEGORY_TITLES = Object.fromEntries(SUPPORT_CATEGORIES.map((item) => [item.id, item.title]));

export function supportModuleFromRoute(route: string | null | undefined) {
  const raw = String(route || "").toLowerCase();
  const path = raw.split("?")[0];
  if (path.startsWith("/integrations/esf") || raw.includes("esf")) return "esf";
  if (path.includes("/documents/avr") || path.includes("/avr")) return "avr";
  if (raw.includes("whatsapp")) return "whatsapp";
  if (path.startsWith("/documents/invoices") || path.startsWith("/documents")) return "documents";
  if (path.startsWith("/integrations")) return "integrations";
  if (path.startsWith("/control") || path.startsWith("/settings/ai-automation")) return "ai";
  if (path.startsWith("/conversations")) return "conversations";
  if (path.startsWith("/deals")) return "deals";
  if (path.startsWith("/inquiries") || path.startsWith("/requests")) return "inquiries";
  if (path.startsWith("/tasks")) return "tasks";
  if (path.startsWith("/contacts") || path.startsWith("/clients") || path.startsWith("/companies")) return "clients";
  if (path.startsWith("/stats")) return "stats";
  if (path.startsWith("/settings")) return "settings";
  if (path.startsWith("/today")) return "getting-started";
  return "getting-started";
}

function normalizeSearch(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-z0-9а-я\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreArticle(
  article: { title: string; content: string; keywords: string; category: string },
  query: string,
  module: string | null,
) {
  const q = normalizeSearch(query);
  if (!q) return module && article.category === module ? 8 : 1;
  const title = normalizeSearch(article.title);
  const keywords = normalizeSearch(article.keywords);
  const content = normalizeSearch(article.content);
  const category = normalizeSearch(SUPPORT_CATEGORY_TITLES[article.category] || article.category);
  let score = 0;
  if (title.includes(q)) score += 24;
  if (keywords.includes(q)) score += 16;
  if (category.includes(q)) score += 10;
  if (content.includes(q)) score += 6;
  for (const word of q.split(" ").filter((item) => item.length > 2)) {
    if (title.includes(word)) score += 5;
    if (keywords.includes(word)) score += 3;
    if (content.includes(word)) score += 1;
  }
  if (module && article.category === module) score += 8;
  if (module === "whatsapp" && article.category === "integrations") score += 3;
  if (module === "integrations" && (article.category === "whatsapp" || article.category === "esf")) score += 6;
  if (module === "esf" && (article.category === "avr" || article.category === "documents")) score += 3;
  if (module === "avr" && (article.category === "documents" || article.category === "esf")) score += 3;
  return score;
}

function publicArticle(row: {
  id: string;
  category: string;
  title: string;
  slug: string;
  content: string;
  keywords: string;
  sortOrder: number;
  isPopular: boolean;
  relatedRoute: string | null;
  relatedLabel: string | null;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    category: row.category,
    categoryTitle: SUPPORT_CATEGORY_TITLES[row.category] || row.category,
    title: row.title,
    slug: row.slug,
    content: row.content,
    keywords: row.keywords,
    sortOrder: row.sortOrder,
    isPopular: row.isPopular,
    relatedRoute: row.relatedRoute,
    relatedLabel: row.relatedLabel,
    updatedAt: row.updatedAt,
  };
}

export async function ensureSupportCatalog(prisma: PrismaClient) {
  const count = await prisma.supportArticle.count();
  if (count > 0) return { seeded: false };
  await upsertSupportCatalog(prisma);
  return { seeded: true };
}

export async function searchSupportArticles(
  prisma: PrismaClient,
  auth: AuthContext,
  query: { q?: string; route?: string; limit?: number },
) {
  if (!auth.user.id) throw new ApiError(401, "unauthorized", "Нужна авторизация");
  await ensureSupportCatalog(prisma);
  const module = supportModuleFromRoute(query.route);
  const published = await prisma.supportArticle.findMany({
    where: { isPublished: true },
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
  });
  const q = String(query.q || "").trim();
  const ranked = published
    .map((article) => ({ article, score: scoreArticle(article, q, module) }))
    .filter((row) => (q ? row.score > 0 : true))
    .sort((a, b) => b.score - a.score || a.article.sortOrder - b.article.sortOrder);
  const popular = published.filter((item) => item.isPopular).sort((a, b) => a.sortOrder - b.sortOrder);
  const contextual = published
    .filter((item) => {
      if (item.category === module) return true;
      if (module === "whatsapp" && item.category === "integrations") return true;
      if (module === "integrations" && (item.category === "whatsapp" || item.category === "esf")) return true;
      if (module === "avr" && item.category === "documents") return true;
      return false;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const limit = Math.min(30, Math.max(5, Number(query.limit) || 12));
  return {
    module,
    categories: SUPPORT_CATEGORIES.map((item) => ({ id: item.id, title: item.title })),
    popular: popular.map(publicArticle),
    contextual: contextual.map(publicArticle),
    items: ranked.slice(0, limit).map((row) => publicArticle(row.article)),
  };
}

export async function getSupportArticle(prisma: PrismaClient, auth: AuthContext, idOrSlug: string) {
  if (!auth.user.id) throw new ApiError(401, "unauthorized", "Нужна авторизация");
  const article = await prisma.supportArticle.findFirst({
    where: {
      isPublished: true,
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
    },
  });
  if (!article) throw new ApiError(404, "not_found", "Статья не найдена");
  let myFeedback: boolean | null = null;
  if (auth.activeMembership) {
    const row = await prisma.supportArticleFeedback.findUnique({
      where: { articleId_userId: { articleId: article.id, userId: auth.user.id } },
    });
    myFeedback = row ? row.helpful : null;
  }
  return { ...publicArticle(article), myFeedback };
}

export async function submitSupportArticleFeedback(
  prisma: PrismaClient,
  auth: AuthContext,
  articleId: string,
  helpful: boolean,
) {
  const membership = requireTenant(auth);
  const article = await prisma.supportArticle.findFirst({ where: { id: articleId, isPublished: true } });
  if (!article) throw new ApiError(404, "not_found", "Статья не найдена");
  await prisma.supportArticleFeedback.upsert({
    where: { articleId_userId: { articleId, userId: auth.user.id } },
    update: { helpful, tenantId: membership.tenantId },
    create: {
      articleId,
      tenantId: membership.tenantId,
      userId: auth.user.id,
      helpful,
    },
  });
  return { ok: true, helpful };
}

export async function listAdminSupportArticles(prisma: PrismaClient, auth: AuthContext) {
  requirePlatformAdmin(auth);
  const items = await prisma.supportArticle.findMany({ orderBy: [{ sortOrder: "asc" }, { title: "asc" }] });
  return {
    categories: SUPPORT_CATEGORIES,
    items: items.map((item) => ({
      ...publicArticle(item),
      isPublished: item.isPublished,
      createdAt: item.createdAt,
    })),
  };
}

export async function upsertAdminSupportArticle(
  prisma: PrismaClient,
  auth: AuthContext,
  input: {
    id?: string;
    category: string;
    title: string;
    slug: string;
    content: string;
    keywords?: string;
    sortOrder?: number;
    isPopular?: boolean;
    isPublished?: boolean;
    relatedRoute?: string | null;
    relatedLabel?: string | null;
  },
) {
  requirePlatformAdmin(auth);
  const slug = String(input.slug || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug || !input.title.trim() || !input.content.trim()) {
    throw new ApiError(422, "invalid", "Нужны название, адрес статьи и текст");
  }
  const data = {
    category: String(input.category || "getting-started").slice(0, 40),
    title: input.title.trim().slice(0, 180),
    slug,
    content: input.content.trim().slice(0, 20000),
    keywords: String(input.keywords || "").slice(0, 500),
    sortOrder: Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 100,
    isPopular: Boolean(input.isPopular),
    isPublished: input.isPublished !== false,
    relatedRoute: input.relatedRoute && String(input.relatedRoute).startsWith("/") ? String(input.relatedRoute).slice(0, 180) : null,
    relatedLabel: input.relatedLabel ? String(input.relatedLabel).slice(0, 80) : null,
  };
  const row = input.id
    ? await prisma.supportArticle.update({ where: { id: input.id }, data })
    : await prisma.supportArticle.create({ data });
  return publicArticle(row);
}

export async function deleteAdminSupportArticle(prisma: PrismaClient, auth: AuthContext, id: string) {
  requirePlatformAdmin(auth);
  await prisma.supportArticle.delete({ where: { id } }).catch(() => {
    throw new ApiError(404, "not_found", "Статья не найдена");
  });
  return { ok: true };
}
