import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Prisma } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";

export const LEGAL_VERSION = "2026-09-28.1";
const titles = { offer: "Публичная оферта", privacy: "Политика конфиденциальности", consent: "Согласие на обработку персональных данных" } as const;
export type LegalSlug = keyof typeof titles;
export type LegalProfile = {
  companyName: string; bin: string; address: string; legalEmail: string;
  effectiveDate: string; hosting: string; processors: string;
  release: { approved: boolean; emailVerified: boolean; storageKzVerified: boolean; processorsReviewed: boolean; retentionOperational: boolean; securityReviewed: boolean };
};
export const legalProfile = JSON.parse(readFileSync(new URL("../../legal/profile.json", import.meta.url), "utf8")) as LegalProfile;
const templates = Object.fromEntries(Object.keys(titles).map(slug => [slug, readFileSync(new URL(`../../legal/${slug}.md`, import.meta.url), "utf8")])) as Record<LegalSlug, string>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function legalReleaseIssues(profile: LegalProfile) {
  const issues: string[] = [];
  for (const key of ["companyName", "bin", "address", "legalEmail", "effectiveDate", "hosting", "processors"] as const) {
    if (!profile[key]?.trim()) issues.push(`profile.${key}`);
  }
  if (!/^\d{12}$/.test(profile.bin)) issues.push("profile.bin.format");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.legalEmail)) issues.push("profile.legalEmail.format");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(profile.effectiveDate) || !Number.isFinite(Date.parse(profile.effectiveDate)) || new Date(profile.effectiveDate).toISOString().slice(0, 10) !== profile.effectiveDate || Date.parse(profile.effectiveDate) > Date.now()) issues.push("profile.effectiveDate.valid");
  for (const key of ["approved", "emailVerified", "storageKzVerified", "processorsReviewed", "retentionOperational", "securityReviewed"] as const) {
    if (profile.release?.[key] !== true) issues.push(`release.${key}`);
  }
  return issues;
}

export function getLegalBundle(profile = legalProfile, requested = process.env.BASQAR_LEGAL_PUBLISHED === "1") {
  const issues = legalReleaseIssues(profile);
  if (requested && issues.length) throw new Error(`Legal publication prerequisites missing: ${issues.join(", ")}`);
  const active = requested && issues.length === 0;
  const documents = (Object.keys(titles) as LegalSlug[]).map(slug => {
    const text = templates[slug].replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      const value = profile[key as keyof LegalProfile];
      return typeof value === "string" && value.trim() ? value : "[требует утверждения]";
    });
    return { slug, title: titles[slug], version: LEGAL_VERSION, text, sha256: digest(text) };
  });
  const revision = digest(documents.map(doc => `${doc.slug}:${doc.sha256}`).join("\n"));
  return { active, revision, version: LEGAL_VERSION, documents };
}
export type LegalBundle = ReturnType<typeof getLegalBundle>;
export type LegalAcceptance = { revision: string; offerAccepted: boolean; personalDataAccepted: boolean; authorizedRepresentative: boolean };

export function validateLegalAcceptance(input: LegalAcceptance | undefined, bundle: LegalBundle) {
  if (!bundle.active) return;
  if (!input || input.offerAccepted !== true || input.personalDataAccepted !== true || input.authorizedRepresentative !== true) {
    throw new ApiError(422, "legal_consent_required", "Прочитайте оферту и согласие на обработку персональных данных и подтвердите свой выбор.");
  }
  if (input.revision !== bundle.revision) throw new ApiError(409, "legal_revision_changed", "Документы обновились. Обновите страницу и прочитайте новую редакцию перед регистрацией.");
}

export async function recordRegistrationAcceptance(tx: Prisma.TransactionClient, id: string, bundle: LegalBundle, subject: { name: string; email: string; companyName: string }) {
  if (!bundle.active) return;
  // Evidence is part of the registration transaction: no successful registration
  // when its consent record could not be written. Never include passwords or codes.
  await writeAudit(tx, {
    action: "legal.registration_accepted", entityType: "PendingRegistration", entityId: id,
    changes: { revision: bundle.revision, version: bundle.version, acceptedAt: new Date().toISOString(), subject,
      offerAccepted: true, personalDataAccepted: true, authorizedRepresentative: true,
      identityVerified: false, documents: bundle.documents },
  });
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
export function renderLegalDocument(bundle: LegalBundle, slug: string) {
  const doc = bundle.documents.find(doc => doc.slug === slug);
  if (!doc) return null;
  // The deliberately small renderer supports only headings and paragraphs. No raw
  // HTML or arbitrary links from configuration can execute in a legal document.
  const body = doc.text.trim().split(/\n\s*\n/).map(block => {
    const heading = /^(#{1,2}) (.+)$/.exec(block);
    return heading ? `<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>` : `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`;
  }).join("\n");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${bundle.active ? "index,follow" : "noindex,nofollow"}"><title>${escapeHtml(doc.title)} — BasQar</title><style>body{margin:0;background:#f5f7fb;color:#182338;font:17px/1.65 system-ui,sans-serif}main{max-width:840px;margin:32px auto;padding:32px;background:white;border-radius:16px}a{color:#1663bd}nav{display:flex;gap:20px;flex-wrap:wrap}h1{font-size:30px;line-height:1.2}h2{font-size:21px;margin-top:32px}p{overflow-wrap:anywhere}.draft{padding:16px;background:#fff3d4}footer{overflow-wrap:anywhere;font-size:13px;color:#536078;margin-top:32px}@media(max-width:600px){main{margin:0;padding:20px;border-radius:0}h1{font-size:25px}}</style></head><body><main><nav><a href="/login">BasQar</a>${bundle.documents.map(item => `<a href="/legal/${item.slug}">${escapeHtml(item.title)}</a>`).join("")}</nav>${bundle.active ? "" : '<p class="draft"><strong>Проект для согласования.</strong> Эта редакция не введена в действие и не является предложением заключить договор. Реквизиты размещения и организационные меры ещё требуют подтверждения.</p>'}${body}<footer>Редакция ${escapeHtml(bundle.version)} · SHA-256 ${doc.sha256}<br>Политика: <a href="/legal/privacy">/legal/privacy</a> · Согласие: <a href="/legal/consent">/legal/consent</a></footer></main></body></html>`;
}
