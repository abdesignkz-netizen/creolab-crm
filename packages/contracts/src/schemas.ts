import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  client: z.enum(["web", "mobile"]).default("web"),
});

export const createInquirySchema = z.object({
  name: z.string().trim().min(1).max(160),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  company: z.string().trim().max(200).optional(),
  subject: z.string().trim().max(200).optional(),
  message: z.string().trim().max(4000).optional(),
  service: z.string().trim().max(200).optional(),
  serviceCategory: z.string().trim().max(80).optional(),
  sourceChannel: z.string().trim().max(80).optional(),
  sourceType: z.string().trim().max(80).optional(),
  contactId: z.string().uuid().optional(),
  forceNewContact: z.boolean().optional(),
});

export const lookupInquiryContactSchema = z.object({
  phone: z.string().min(1),
});

export const updateInquirySchema = z.object({
  status: z
    .enum([
      "new",
      "qualification",
      "qualified",
      "in_progress",
      "waiting_client",
      "proposal",
      "converted",
      "lost",
      "cancelled",
      "invalid",
      "spam",
      "duplicate",
    ])
    .optional(),
  subject: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  service: z.string().trim().max(200).nullable().optional(),
  serviceCategory: z.string().trim().max(80).nullable().optional(),
  serviceSubcategory: z.string().trim().max(80).nullable().optional(),
  companyName: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  desiredDeadline: z.string().trim().max(120).nullable().optional(),
  budgetMin: z.number().int().nullable().optional(),
  budgetMax: z.number().int().nullable().optional(),
  nextStep: z.string().trim().max(400).nullable().optional(),
  assigneeMembershipId: z.string().uuid().nullable().optional(),
  needsReply: z.boolean().optional(),
  aiSummary: z.string().trim().max(4000).nullable().optional(),
  phone: z.string().trim().max(40).optional(),
});

export const loseInquirySchema = z.object({
  reason: z.string().trim().min(1).max(80),
  comment: z.string().trim().max(1000).optional(),
  classification: z.enum(["lost", "invalid", "spam", "duplicate"]).default("lost"),
});

export const convertDealSchema = z.object({
  title: z.string().trim().max(200).optional(),
});

export const completeIntakeSchema = z.object({
  phone: z.string().min(1),
  name: z.string().trim().max(160).optional(),
});

export const conversationModeSchema = z.object({
  mode: z.enum(["ai", "human", "paused"]),
  resumeStrategy: z.enum(["continue", "reply_last"]).optional(),
});

export const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  internal: z.boolean().optional(),
});

export const createTaskSchema = z.object({
  type: z
    .enum([
      "process_inquiry",
      "call",
      "message",
      "follow_up",
      "meeting",
      "proposal",
      "send_documents",
      "prepare_estimate",
      "wait_client",
      "payment",
      "other",
    ])
    .default("other"),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  inquiryId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  dueAt: z.string().datetime().optional(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  ownerMembershipId: z.string().uuid().optional(),
  targetType: z.enum(["client", "group", "none"]).default("none"),
  clientIds: z.array(z.string().uuid()).max(200).optional(),
  segmentSnapshot: z.record(z.string(), z.unknown()).optional(),
});

export const updateTaskSchema = z.object({
  messageDraft: z.string().max(4000).optional(),
  contactId: z.string().uuid().nullable().optional(),
  inquiryId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  dueAt: z.string().datetime().nullable().optional(),
});

export const taskAttachmentSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(1).max(120),
  contentBase64: z.string().min(1),
  documentType: z.enum(["proposal", "contract", "invoice", "presentation", "document", "image", "other"]).optional(),
});

export const completeTaskResultSchema = z.object({
  resultCode: z.string().trim().min(1).max(80),
  resultText: z.string().max(2000).optional(),
  skipNext: z.boolean().optional(),
  nextAction: z
    .object({
      type: z.string().min(1),
      title: z.string().trim().min(1).max(200),
      dueAt: z.string().datetime().optional(),
    })
    .nullable()
    .optional(),
});

export const nextActionSchema = z.object({
  type: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  dueOffsetHours: z.number().nullable().optional(),
});

export const segmentPreviewSchema = z.object({
  q: z.string().trim().max(200).optional(),
  serviceCategories: z.array(z.string()).max(20).optional(),
  datePreset: z
    .enum(["today", "yesterday", "last_3_days", "last_7_days", "last_30_days", "this_month", "last_month", "custom"])
    .optional(),
  dateField: z.enum(["lastContact", "firstContact", "inquiryCreated", "lastMessage"]).default("lastContact"),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  statuses: z.array(z.string()).max(20).optional(),
  lifecycleStatuses: z.array(z.string()).max(20).optional(),
  sources: z.array(z.string()).max(20).optional(),
  acquisition: z.array(z.string()).max(20).optional(),
  ownerMembershipIds: z.array(z.string().uuid()).max(40).optional(),
  tags: z.array(z.string()).max(20).optional(),
  needsReply: z.boolean().optional(),
  hasOverdueTask: z.boolean().optional(),
  hasActiveDeal: z.boolean().optional(),
  missingNextAction: z.boolean().optional(),
  hot: z.boolean().optional(),
  excludeWon: z.boolean().optional(),
  proposalSentDaysAgo: z.number().int().min(0).max(90).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const parseTaskCommandSchema = z.object({
  text: z.string().trim().min(2).max(2000),
  contactId: z.string().uuid().optional(),
  contactIds: z.array(z.string().uuid()).max(500).optional(),
  phone: z.string().trim().min(5).max(40).optional(),
  phones: z.array(z.string().trim().min(5).max(40)).max(500).optional(),
  phoneListText: z.string().max(100_000).optional(),
});

export const createFromCommandSchema = z
  .object({
    text: z.string().trim().min(2).max(2000),
    parsedCommand: z.record(z.string(), z.unknown()),
    clientIds: z.array(z.string().uuid()).max(500).default([]),
    phone: z.string().trim().min(5).max(40).optional(),
    phones: z.array(z.string().trim().min(5).max(40)).max(500).optional(),
    contactName: z.string().trim().min(1).max(160).optional(),
    contactNames: z.array(z.string().trim().max(160)).max(500).optional(),
    messageDraft: z.string().max(4000).optional(),
    executionMode: z.enum(["execute", "prepare_only"]).default("execute"),
    ownerMembershipId: z.string().uuid().optional(),
    dueAt: z.string().datetime().optional(),
    asCampaign: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const phones = [...(value.phones || []), ...(value.phone ? [value.phone] : [])];
    if (!value.clientIds.length && !phones.length) {
      ctx.addIssue({ code: "custom", message: "Укажите клиента или телефон", path: ["clientIds"] });
    }
  });

export const parsePhoneListSchema = z.object({
  text: z.string().min(1).max(100_000),
});

export const createCampaignSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  channel: z.enum(["whatsapp"]).default("whatsapp"),
  source: z.enum(["manual", "ai_command", "import", "segment"]).default("manual"),
  messageDraft: z.string().max(4000).optional(),
  messageMode: z.enum(["manual", "ai", "file_only"]).default("manual"),
  personalizeEach: z.boolean().optional(),
  createMissingClients: z.boolean().default(true),
  scheduledAt: z.string().datetime().optional().nullable(),
  rawCommandText: z.string().max(4000).optional(),
  contactIds: z.array(z.string().uuid()).max(500).optional(),
  phoneListText: z.string().max(100_000).optional(),
  phones: z.array(z.string().trim().min(5).max(40)).max(500).optional(),
  segment: segmentPreviewSchema.optional(),
});

export const updateCampaignSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  messageDraft: z.string().max(4000).nullable().optional(),
  messageMode: z.enum(["manual", "ai", "file_only"]).optional(),
  personalizeEach: z.boolean().optional(),
  createMissingClients: z.boolean().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  recipientIdsInclude: z.array(z.string().uuid()).max(500).optional(),
  recipientIdsExclude: z.array(z.string().uuid()).max(500).optional(),
  recipientDrafts: z
    .array(
      z.object({
        id: z.string().uuid(),
        messageDraft: z.string().max(4000).nullable(),
      }),
    )
    .max(500)
    .optional(),
});

export const personalizeCampaignRecipientsSchema = z.object({
  useLlm: z.boolean().optional(),
});

export const campaignAttachmentSchema = z.object({
  fileName: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(3).max(120),
  contentBase64: z.string().min(8),
  documentType: z.enum(["proposal", "presentation", "contract", "invoice", "document", "image", "other"]).default("document"),
});

export const parseContactImportSchema = z.object({
  fileName: z.string().trim().min(1).max(240),
  contentBase64: z.string().min(8),
  mapping: z.record(z.string(), z.enum(["name", "phone", "company", "email", "service", "comment", "skip"])).optional(),
});

export const assignTaskSchema = z.object({
  membershipId: z.string().uuid().optional(),
});

export const snoozeSituationSchema = z.object({
  itemId: z.string().min(3).max(120),
  until: z.string().datetime(),
  reason: z.string().trim().max(400).optional(),
});

export const createContactSchema = z.object({
  name: z.string().trim().min(1).max(160),
  phone: z.string().optional(),
  source: z.string().trim().max(80).default("manual"),
  comment: z.string().trim().max(2000).optional(),
  companyName: z.string().trim().max(200).optional(),
});

export const updateContactSchema = z
  .object({
    name: z.string().trim().max(160).nullable().optional(),
    firstName: z.string().trim().max(80).nullable().optional(),
    lastName: z.string().trim().max(80).nullable().optional(),
    middleName: z.string().trim().max(80).nullable().optional(),
    companyName: z.string().trim().max(200).nullable().optional(),
    jobTitle: z.string().trim().max(120).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    country: z.string().trim().max(120).nullable().optional(),
    language: z.string().trim().max(40).optional(),
    summary: z.string().trim().max(4000).nullable().optional(),
    lifecycleStatus: z.enum(["new", "in_progress", "active", "paused", "lost", "archived"]).optional(),
    leadTemperature: z.enum(["hot", "warm", "cold", "unknown"]).optional(),
    leadScore: z.number().int().min(0).max(100).nullable().optional(),
    ownerMembershipId: z.string().uuid().nullable().optional(),
    archived: z.boolean().optional(),
  })
  .partial();

export const contactNoteSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  pinned: z.boolean().optional(),
});

export const contactTagSchema = z.object({
  name: z.string().trim().min(1).max(40),
});

export const paymentSchema = z.object({
  amountMinor: z.number().int(),
  currency: z.string().default("KZT"),
  comment: z.string().max(500).optional(),
});

export const changeDealStageSchema = z.object({
  stageId: z.string().uuid().optional(),
  systemKey: z.string().min(1).max(64).optional(),
  note: z.string().max(500).optional(),
}).refine((v) => Boolean(v.stageId || v.systemKey), { message: "Укажите stageId или systemKey" });

export const updateDealSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  offerAmountMinor: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().min(1).max(8).optional(),
  probability: z.number().int().min(0).max(100).optional(),
  paymentStatus: z
    .enum([
      "NOT_REQUIRED",
      "NOT_INVOICED",
      "INVOICED",
      "PARTIALLY_PAID",
      "PAID",
      "OVERDUE",
      "CANCELLED",
    ])
    .optional(),
  fulfillmentStatus: z.enum(["NOT_STARTED", "IN_PROGRESS", "DELIVERED", "COMPLETED"]).optional(),
  nextAction: z.string().max(500).nullable().optional(),
  nextActionAt: z.string().datetime().nullable().optional(),
  expectedCloseAt: z.string().datetime().nullable().optional(),
  assigneeMembershipId: z.string().uuid().nullable().optional(),
});

export const markDealWonSchema = z.object({
  wonAmountMinor: z.number().int().nonnegative().nullable().optional(),
});

export const markDealLostSchema = z.object({
  lossReason: z.string().trim().min(1).max(120),
  note: z.string().max(1000).optional(),
});

export const integrationEventSchema = z.object({
  schema_version: z.number().int().default(1),
  event_id: z.string().min(1).max(120),
  event_type: z.literal("inquiry.created"),
  occurred_at: z.string().optional(),
  contact: z
    .object({
      external_id: z.string().optional(),
      name: z.string().optional(),
      methods: z
        .array(
          z.object({
            type: z.string(),
            value: z.string(),
          }),
        )
        .default([]),
    })
    .default({ methods: [] }),
  inquiry: z
    .object({
      subject: z.string().optional(),
      message: z.string().optional(),
      custom_fields: z.record(z.string(), z.unknown()).optional(),
    })
    .default({}),
  attribution: z.record(z.string(), z.unknown()).optional(),
  contact_permission: z.record(z.string(), z.unknown()).optional(),
  tenant_id: z.unknown().optional(),
  role: z.unknown().optional(),
  assignee_id: z.unknown().optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateInquiryInput = z.infer<typeof createInquirySchema>;

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(200),
  legalName: z.string().trim().max(300).nullable().optional(),
  shortName: z.string().trim().max(120).nullable().optional(),
  bin: z.string().trim().max(20).nullable().optional(),
  industry: z.string().trim().max(120).nullable().optional(),
  website: z.string().trim().max(300).nullable().optional(),
  email: z.string().trim().max(200).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  address: z.string().trim().max(400).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  lifecycleStatus: z
    .enum(["PROSPECT", "CUSTOMER", "INACTIVE_CUSTOMER", "PARTNER", "ARCHIVED"])
    .optional(),
  assigneeMembershipId: z.string().uuid().nullable().optional(),
  initialSource: z.string().trim().max(120).nullable().optional(),
  bankDetailsJson: z.record(z.string(), z.unknown()).nullable().optional(),
  forceCreate: z.boolean().optional(),
});

export const updateCompanySchema = createCompanySchema.partial().omit({ forceCreate: true });

export const companyContactSchema = z.object({
  contactId: z.string().uuid(),
  position: z.string().trim().max(160).nullable().optional(),
  department: z.string().trim().max(160).nullable().optional(),
  isPrimary: z.boolean().optional(),
  isDecisionMaker: z.boolean().optional(),
  isBillingContact: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const updateCompanyContactSchema = companyContactSchema.partial().omit({ contactId: true });

export const dealContactSchema = z.object({
  contactId: z.string().uuid(),
  role: z.string().trim().max(120).nullable().optional(),
  isPrimary: z.boolean().optional(),
});
