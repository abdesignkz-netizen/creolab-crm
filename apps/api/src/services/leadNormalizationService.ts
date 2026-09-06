/** Lead normalization for LEAD_SUBMISSION events — never mix with NormalizedMessage */

export type NormalizedLead = {
  externalLeadId?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
  service?: string | null;
  message?: string | null;
  budget?: string | null;
  deadline?: string | null;
  city?: string | null;
  acquisitionSource?: string | null;
  entryChannel?: string | null;
  landingPage?: string | null;
  pageUrl?: string | null;
  pageTitle?: string | null;
  referrer?: string | null;
  utm?: {
    source?: string | null;
    medium?: string | null;
    campaign?: string | null;
    content?: string | null;
    term?: string | null;
  };
  integrationId: string;
  mappingVersion: number;
  isTest?: boolean;
  customFields?: Record<string, unknown>;
};

export type FieldMappingConfig = {
  version: number;
  fields: Record<string, string>;
};

const DEFAULT_FORM_FIELDS: Record<string, string> = {
  name: "name",
  phone: "phone",
  email: "email",
  company: "company",
  service: "service",
  subject: "service",
  message: "message",
  comment: "message",
  budget: "budget",
  deadline: "deadline",
  city: "city",
  customer_name: "name",
  mobile: "phone",
  business: "company",
  request_text: "message",
};

/** Accept flat { name: "name" } or versioned { version, fields } */
export function parseFieldMapping(raw: unknown): FieldMappingConfig {
  if (!raw || typeof raw !== "object") {
    return { version: 1, fields: { ...DEFAULT_FORM_FIELDS } };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.fields && typeof obj.fields === "object") {
    return {
      version: typeof obj.version === "number" ? obj.version : 1,
      fields: { ...DEFAULT_FORM_FIELDS, ...(obj.fields as Record<string, string>) },
    };
  }
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && k !== "version") flat[k] = v;
  }
  return { version: 1, fields: { ...DEFAULT_FORM_FIELDS, ...flat } };
}

function pick(body: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (body[key] != null && String(body[key]).trim() !== "") return body[key];
  }
  return undefined;
}

function str(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

/**
 * Map provider payload → NormalizedLead using versioned field mapping.
 * Mapping changes do not rewrite historical leads (version stored on lead).
 */
export function normalizeLeadFromFormPayload(args: {
  body: Record<string, unknown>;
  mappingJson: unknown;
  integrationId: string;
  entryChannel?: string;
  isTest?: boolean;
}): NormalizedLead {
  const mapping = parseFieldMapping(args.mappingJson);
  const reverse: Record<string, string[]> = {};
  for (const [sourceKey, target] of Object.entries(mapping.fields)) {
    reverse[target] = reverse[target] || [];
    reverse[target].push(sourceKey);
  }

  const byTarget = (target: string, extra: string[] = []) =>
    str(pick(args.body, [...(reverse[target] || []), ...extra]));

  const utmSource = str(args.body.utm_source || args.body.utmSource);
  const utmMedium = str(args.body.utm_medium || args.body.utmMedium);
  const utmCampaign = str(args.body.utm_campaign || args.body.utmCampaign);
  const utmContent = str(args.body.utm_content || args.body.utmContent);
  const utmTerm = str(args.body.utm_term || args.body.utmTerm);

  const knownTargets = new Set(Object.values(mapping.fields));
  const reserved = new Set([
    "website",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "utmSource",
    "utmMedium",
    "utmCampaign",
    "utmContent",
    "utmTerm",
    "pageUrl",
    "page_url",
    "pageTitle",
    "page_title",
    "referrer",
    "landingPage",
    "landing_page",
    "submission_id",
    "is_test",
    "isTest",
    "test",
  ]);
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args.body)) {
    if (reserved.has(key)) continue;
    if (mapping.fields[key] && knownTargets.has(mapping.fields[key])) continue;
    if (["name", "phone", "email", "company", "service", "message", "subject"].includes(key)) continue;
    customFields[key] = value;
  }

  return {
    externalLeadId: str(args.body.submission_id || args.body.externalLeadId || args.body.lead_id),
    name: byTarget("name", ["name"]),
    phone: byTarget("phone", ["phone", "mobile"]),
    email: byTarget("email", ["email"]),
    company: byTarget("company", ["company", "business"]),
    service: byTarget("service", ["service", "subject"]),
    message: byTarget("message", ["message", "comment", "request_text"]),
    budget: byTarget("budget", ["budget"]),
    deadline: byTarget("deadline", ["deadline"]),
    city: byTarget("city", ["city"]),
    acquisitionSource: utmSource || str(args.body.acquisitionSource) || null,
    entryChannel: args.entryChannel || "website_form",
    landingPage: str(args.body.landingPage || args.body.landing_page || args.body.pageUrl || args.body.page_url),
    pageUrl: str(args.body.pageUrl || args.body.page_url),
    pageTitle: str(args.body.pageTitle || args.body.page_title),
    referrer: str(args.body.referrer),
    utm: {
      source: utmSource,
      medium: utmMedium,
      campaign: utmCampaign,
      content: utmContent,
      term: utmTerm,
    },
    integrationId: args.integrationId,
    mappingVersion: mapping.version,
    isTest: Boolean(args.isTest || args.body.is_test || args.body.isTest || args.body.test === true || args.body.test === "1"),
    customFields: Object.keys(customFields).length ? customFields : undefined,
  };
}

export function normalizeLeadFromWebhookPayload(args: {
  parsed: {
    event_id: string;
    contact?: { name?: string; methods?: Array<{ type: string; value: string }>; external_id?: string };
    inquiry?: { subject?: string; message?: string; custom_fields?: Record<string, unknown> };
    attribution?: Record<string, unknown>;
  };
  mappingJson: unknown;
  integrationId: string;
  isTest?: boolean;
}): NormalizedLead {
  const mapping = parseFieldMapping(args.mappingJson);
  const phone = args.parsed.contact?.methods?.find((m) => m.type === "phone")?.value || null;
  const email = args.parsed.contact?.methods?.find((m) => m.type === "email")?.value || null;
  const attr = args.parsed.attribution || {};
  return {
    externalLeadId: args.parsed.event_id || args.parsed.contact?.external_id || null,
    name: args.parsed.contact?.name || null,
    phone,
    email,
    company: str(attr.company) || null,
    service: args.parsed.inquiry?.subject || null,
    message: args.parsed.inquiry?.message || null,
    acquisitionSource: str(attr.utm_source || attr.source) || null,
    entryChannel: "webhook",
    landingPage: str(attr.landing_page || attr.landingPage) || null,
    referrer: str(attr.referrer) || null,
    utm: {
      source: str(attr.utm_source),
      medium: str(attr.utm_medium),
      campaign: str(attr.utm_campaign),
      content: str(attr.utm_content),
      term: str(attr.utm_term),
    },
    integrationId: args.integrationId,
    mappingVersion: mapping.version,
    isTest: Boolean(args.isTest),
    customFields: args.parsed.inquiry?.custom_fields,
  };
}
