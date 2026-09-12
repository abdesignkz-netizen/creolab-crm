export type ClientOptions = {
  baseUrl: string;
  getToken?: () => string | null | Promise<string | null>;
  getTenantId?: () => string | null;
};

export function createApiClient(options: ClientOptions) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    const token = await options.getToken?.();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const tenantId = options.getTenantId?.();
    if (tenantId) headers.set("x-tenant-id", tenantId);
    const response = await fetch(`${options.baseUrl}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || `HTTP ${response.status}`) as Error & {
        status: number;
        body: unknown;
      };
      error.status = response.status;
      error.body = data;
      throw error;
    }
    return data as T;
  }

  return {
    request,
    login: (email: string, password: string, client: "web" | "mobile" = "web") =>
      request("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password, client }) }),
    me: () => request("/api/v1/me"),
    today: () => request("/api/v1/today"),
    situation: (query: { scope?: "all" | "mine" | "unassigned"; includeSnoozed?: boolean } = {}) => {
      const params = new URLSearchParams();
      if (query.scope) params.set("scope", query.scope);
      if (query.includeSnoozed) params.set("includeSnoozed", "true");
      const suffix = params.toString() ? `?${params}` : "";
      return request(`/api/v1/situation${suffix}`);
    },
    situationOverview: (
      query: {
        period?: string;
        dateFrom?: string;
        dateTo?: string;
        scope?: "all" | "mine" | "unassigned";
        onlyImportant?: boolean;
      } = {},
    ) => {
      const params = new URLSearchParams();
      if (query.period) params.set("period", query.period);
      if (query.dateFrom) params.set("dateFrom", query.dateFrom);
      if (query.dateTo) params.set("dateTo", query.dateTo);
      if (query.scope) params.set("scope", query.scope);
      if (query.onlyImportant) params.set("onlyImportant", "true");
      const suffix = params.toString() ? `?${params}` : "";
      return request(`/api/v1/situation/overview${suffix}`);
    },
    snoozeSituation: (body: { itemId: string; until: string; reason?: string }) =>
      request("/api/v1/situation/snooze", { method: "POST", body: JSON.stringify(body) }),
    situationAsk: (body: {
      text: string;
      period?: string;
      dateFrom?: string;
      dateTo?: string;
      scope?: "all" | "mine" | "unassigned";
      onlyImportant?: boolean;
    }) => request("/api/v1/situation/ask", { method: "POST", body: JSON.stringify(body) }),
    navBadges: () => request("/api/v1/nav-badges"),
    inquiries: (query?: Record<string, string | number | undefined>) => {
      const params = new URLSearchParams();
      Object.entries(query || {}).forEach(([key, value]) => {
        if (value != null && value !== "") params.set(key, String(value));
      });
      const qs = params.toString();
      return request(`/api/v1/inquiries${qs ? `?${qs}` : ""}`);
    },
    inquiry: (id: string) => request(`/api/v1/inquiries/${id}`),
    incomplete: () => request("/api/v1/incomplete-intakes"),
    createInquiry: (body: unknown) =>
      request("/api/v1/inquiries", { method: "POST", body: JSON.stringify(body) }),
    lookupInquiryContact: (phone: string) =>
      request("/api/v1/inquiries/lookup-contact", { method: "POST", body: JSON.stringify({ phone }) }),
    updateInquiry: (id: string, body: unknown) =>
      request(`/api/v1/inquiries/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    takeInquiry: (id: string) => request(`/api/v1/inquiries/${id}/take`, { method: "POST" }),
    loseInquiry: (id: string, body: unknown) =>
      request(`/api/v1/inquiries/${id}/lose`, { method: "POST", body: JSON.stringify(body) }),
    acceptInquiry: (id: string) => request(`/api/v1/inquiries/${id}/take`, { method: "POST" }),
    convertInquiry: (id: string, body?: unknown) =>
      request(`/api/v1/inquiries/${id}/convert-to-deal`, {
        method: "POST",
        body: JSON.stringify(body || {}),
      }),
    inquiryAiPreview: (id: string) => request(`/api/v1/inquiries/${id}/ai-preview`),
    startInquiryAi: (id: string) => request(`/api/v1/inquiries/${id}/ai/start`, { method: "POST" }),
    takeoverInquiryAi: (id: string, body?: unknown) =>
      request(`/api/v1/inquiries/${id}/ai/takeover`, { method: "POST", body: JSON.stringify(body || {}) }),
    returnInquiryAi: (id: string) => request(`/api/v1/inquiries/${id}/ai/return`, { method: "POST" }),
    retryInquiryAiAnalysis: (id: string) =>
      request(`/api/v1/inquiries/${id}/ai/retry-analysis`, { method: "POST" }),
    aiAutomationSettings: () => request("/api/v1/settings/ai-automation"),
    updateAiAutomationSettings: (body: unknown) =>
      request("/api/v1/settings/ai-automation", { method: "PATCH", body: JSON.stringify(body) }),
    legalProfile: () => request("/api/v1/settings/legal-profile"),
    updateLegalProfile: (body: unknown) =>
      request("/api/v1/settings/legal-profile", { method: "PATCH", body: JSON.stringify(body) }),
    esfPreflight: () => request("/api/v1/settings/esf-preflight"),
    esfConnection: () => request("/api/v1/integrations/esf"),
    esfConnect: (body: unknown) =>
      request("/api/v1/integrations/esf/connect", { method: "POST", body: JSON.stringify(body) }),
    esfDisconnect: () => request("/api/v1/integrations/esf/disconnect", { method: "POST" }),
    esfNcaLayerPoc: () => request("/api/v1/integrations/esf/ncalayer-poc"),
    esfNcaLayerLegacySign: () =>
      request("/api/v1/integrations/esf/ncalayer-poc/legacy-sign", { method: "POST", body: JSON.stringify({}) }),
    esfPocAvrPayload: () =>
      request("/api/v1/integrations/esf/ncalayer-poc/avr-payload", { method: "POST", body: JSON.stringify({}) }),
    esfPocAvrSend: (body: unknown) =>
      request("/api/v1/integrations/esf/ncalayer-poc/avr-send", { method: "POST", body: JSON.stringify(body) }),
    completeIntake: (id: string, body: unknown) =>
      request(`/api/v1/incomplete-intakes/${id}/complete`, { method: "POST", body: JSON.stringify(body) }),
    contacts: (query: Record<string, string> = {}) => {
      const params = new URLSearchParams(query);
      const suffix = params.toString() ? `?${params}` : "";
      return request(`/api/v1/contacts${suffix}`);
    },
    searchContacts: (q: string) =>
      request(`/api/v1/contacts/search?q=${encodeURIComponent(q)}`),
    segmentPreview: (body: unknown) =>
      request("/api/v1/contacts/segment-preview", { method: "POST", body: JSON.stringify(body) }),
    workspaceMembers: () => request("/api/v1/workspace/members"),
    createContact: (body: unknown) => request("/api/v1/contacts", { method: "POST", body: JSON.stringify(body) }),
    contactOverview: (id: string) => request(`/api/v1/contacts/${id}/overview`),
    updateContact: (id: string, body: unknown) =>
      request(`/api/v1/contacts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    addContactNote: (id: string, body: unknown) =>
      request(`/api/v1/contacts/${id}/notes`, { method: "POST", body: JSON.stringify(body) }),
    addContactTag: (id: string, name: string) =>
      request(`/api/v1/contacts/${id}/tags`, { method: "POST", body: JSON.stringify({ name }) }),
    removeContactTag: (id: string, tagId: string) =>
      request(`/api/v1/contacts/${id}/tags/${tagId}`, { method: "DELETE" }),
    contactActivities: (id: string) => request(`/api/v1/contacts/${id}/activities`),
    deals: (
      query: {
        scope?: string;
        includeClosed?: boolean;
        view?: "board" | "list";
        timeMode?: "now" | "period";
        period?: string;
        dateFrom?: string;
        dateTo?: string;
        basis?: "created" | "activity" | "closed";
        focus?: "all" | "stalled" | "needs_reply" | "no_next_action" | "proposal_no_reply";
        stage?: string;
        outcome?: string;
      } = {},
    ) => {
      const params = new URLSearchParams();
      if (query.scope) params.set("scope", query.scope);
      if (query.includeClosed) params.set("includeClosed", "true");
      if (query.stage) params.set("stage", query.stage);
      if (query.outcome) params.set("outcome", query.outcome);
      if (query.view) params.set("view", query.view);
      if (query.timeMode) params.set("timeMode", query.timeMode);
      if (query.period) params.set("period", query.period);
      if (query.dateFrom) params.set("dateFrom", query.dateFrom);
      if (query.dateTo) params.set("dateTo", query.dateTo);
      if (query.basis) params.set("basis", query.basis);
      if (query.focus && query.focus !== "all") params.set("focus", query.focus);
      const suffix = params.toString() ? `?${params}` : "";
      return request(`/api/v1/deals${suffix}`);
    },
    deal: (id: string) => request(`/api/v1/deals/${id}`),
    createDeal: (body: unknown, idempotencyKey?: string) =>
      request("/api/v1/deals", {
        method: "POST",
        body: JSON.stringify(body),
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      }),
    updateDeal: (id: string, body: unknown) =>
      request(`/api/v1/deals/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    addDealItem: (dealId: string, body: unknown) =>
      request(`/api/v1/deals/${dealId}/items`, { method: "POST", body: JSON.stringify(body) }),
    updateDealItem: (dealId: string, itemId: string, body: unknown) =>
      request(`/api/v1/deals/${dealId}/items/${itemId}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteDealItem: (dealId: string, itemId: string) =>
      request(`/api/v1/deals/${dealId}/items/${itemId}`, { method: "DELETE" }),
    dealDocuments: (dealId: string) => request(`/api/v1/deals/${dealId}/documents`),
    createDocumentFromCommand: (body: unknown) =>
      request("/api/v1/documents/from-command", { method: "POST", body: JSON.stringify(body) }),
    documents: (query: Record<string, string | undefined> = {}) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value) params.set(key, value);
      }
      const qs = params.toString();
      return request(`/api/v1/documents${qs ? `?${qs}` : ""}`);
    },
    contractReadiness: (dealId: string) => request(`/api/v1/deals/${dealId}/contract-readiness`),
    createContractDraft: (dealId: string, body: unknown = {}) =>
      request(`/api/v1/deals/${dealId}/contracts`, { method: "POST", body: JSON.stringify(body) }),
    generateContract: (contractId: string, body: unknown = {}) =>
      request(`/api/v1/contracts/${contractId}/generate`, { method: "POST", body: JSON.stringify(body) }),
    contractPdfUrl: (contractId: string) => `/api/v1/contracts/${contractId}/pdf`,
    sendContractForSign: (contractId: string) =>
      request(`/api/v1/contracts/${contractId}/send-for-sign`, { method: "POST", body: JSON.stringify({}) }),
    contractSigning: (contractId: string) => request(`/api/v1/contracts/${contractId}/signing`),
    signSignatureRequest: (requestId: string, cmsBase64: string) =>
      request(`/api/v1/signature-requests/${requestId}/sign`, {
        method: "POST",
        body: JSON.stringify({ cmsBase64 }),
      }),
    declineSignatureRequest: (requestId: string, reason?: string) =>
      request(`/api/v1/signature-requests/${requestId}/decline`, {
        method: "POST",
        body: JSON.stringify({ reason: reason || null }),
      }),
    publicSign: (token: string) => request(`/public/sign/${encodeURIComponent(token)}`),
    publicSignPdfUrl: (token: string) => `/public/sign/${encodeURIComponent(token)}/pdf`,
    publicSubmitSign: (token: string, cmsBase64: string) =>
      request(`/public/sign/${encodeURIComponent(token)}/sign`, {
        method: "POST",
        body: JSON.stringify({ cmsBase64 }),
      }),
    publicDeclineSign: (token: string, reason?: string) =>
      request(`/public/sign/${encodeURIComponent(token)}/decline`, {
        method: "POST",
        body: JSON.stringify({ reason: reason || null }),
      }),
    publicVerify: (verificationId: string) => request(`/public/verify/${encodeURIComponent(verificationId)}`),
    invoiceReadiness: (dealId: string) => request(`/api/v1/deals/${dealId}/invoice-readiness`),
    createInvoiceDraft: (dealId: string, body: unknown = {}) =>
      request(`/api/v1/deals/${dealId}/invoices`, { method: "POST", body: JSON.stringify(body) }),
    generateInvoice: (invoiceId: string, body: unknown = {}) =>
      request(`/api/v1/invoices/${invoiceId}/generate`, { method: "POST", body: JSON.stringify(body) }),
    invoicePdfUrl: (invoiceId: string) => `/api/v1/invoices/${invoiceId}/pdf`,
    avrReadiness: (dealId: string) => request(`/api/v1/deals/${dealId}/avr-readiness`),
    esfInvoiceReadiness: (dealId: string) => request(`/api/v1/deals/${dealId}/esf-invoice-readiness`),
    dealCloseReadiness: (dealId: string) => request(`/api/v1/deals/${dealId}/close-readiness`),
    syncDealEsf: (dealId: string) =>
      request(`/api/v1/deals/${dealId}/esf-sync`, { method: "POST", body: JSON.stringify({}) }),
    createElectronicDocumentDraft: (dealId: string, body: unknown) =>
      request(`/api/v1/deals/${dealId}/electronic-documents`, { method: "POST", body: JSON.stringify(body) }),
    validateElectronicDocument: (documentId: string) =>
      request(`/api/v1/electronic-documents/${documentId}/validate`, { method: "POST", body: JSON.stringify({}) }),
    previewElectronicDocumentEsf: (documentId: string) =>
      request(`/api/v1/electronic-documents/${documentId}/esf-preview`, { method: "POST", body: JSON.stringify({}) }),
    sendElectronicDocumentEsf: (documentId: string) =>
      request(`/api/v1/electronic-documents/${documentId}/esf-send`, { method: "POST", body: JSON.stringify({}) }),
    esfPayloadToSign: (documentId: string) =>
      request(`/api/v1/electronic-documents/${documentId}/esf-payload`, { method: "POST", body: JSON.stringify({}) }),
    sendElectronicDocumentEsfSigned: (documentId: string, body: unknown, idempotencyKey?: string) =>
      request(`/api/v1/electronic-documents/${documentId}/esf-send-signed`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      }),
    refreshElectronicDocumentEsf: (documentId: string) =>
      request(`/api/v1/electronic-documents/${documentId}/esf-refresh`, { method: "POST", body: JSON.stringify({}) }),
    changeDealStage: (id: string, body: unknown) =>
      request(`/api/v1/deals/${id}/stage`, { method: "POST", body: JSON.stringify(body) }),
    markDealWon: (id: string, body: unknown = {}) =>
      request(`/api/v1/deals/${id}/won`, { method: "POST", body: JSON.stringify(body) }),
    markDealLost: (id: string, body: unknown) =>
      request(`/api/v1/deals/${id}/lost`, { method: "POST", body: JSON.stringify(body) }),
    holdDeal: (id: string, hold = true) =>
      request(`/api/v1/deals/${id}/hold`, { method: "POST", body: JSON.stringify({ hold }) }),
    addDealPayment: (id: string, body: unknown) =>
      request(`/api/v1/deals/${id}/payments`, { method: "POST", body: JSON.stringify(body) }),
    tasks: () => request("/api/v1/tasks"),
    task: (id: string) => request(`/api/v1/tasks/${id}`),
    createTask: (body: unknown) => request("/api/v1/tasks", { method: "POST", body: JSON.stringify(body) }),
    parseTaskCommand: (body: {
      text: string;
      contactId?: string;
      contactIds?: string[];
      phone?: string;
      phones?: string[];
      phoneListText?: string;
    } | string) =>
      request("/api/v1/tasks/parse-command", {
        method: "POST",
        body: JSON.stringify(typeof body === "string" ? { text: body } : body),
      }),
    createFromCommand: (body: unknown) =>
      request("/api/v1/tasks/from-command", { method: "POST", body: JSON.stringify(body) }),
    executeTaskBatch: (id: string) => request(`/api/v1/tasks/${id}/execute-batch`, { method: "POST" }),
    parsePhoneList: (text: string) =>
      request("/api/v1/campaigns/parse-phones", { method: "POST", body: JSON.stringify({ text }) }),
    parseContactImport: (body: { fileName: string; contentBase64: string; mapping?: Record<string, string> }) =>
      request("/api/v1/campaigns/parse-import", { method: "POST", body: JSON.stringify(body) }),
    createCampaign: (body: unknown) => request("/api/v1/campaigns", { method: "POST", body: JSON.stringify(body) }),
    campaign: (id: string) => request(`/api/v1/campaigns/${id}`),
    updateCampaign: (id: string, body: unknown) =>
      request(`/api/v1/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    addCampaignAttachment: (id: string, body: unknown) =>
      request(`/api/v1/campaigns/${id}/attachments`, { method: "POST", body: JSON.stringify(body) }),
    removeCampaignAttachment: (id: string, attachmentId: string) =>
      request(`/api/v1/campaigns/${id}/attachments/${attachmentId}`, { method: "DELETE" }),
    personalizeCampaignRecipients: (id: string, body: { useLlm?: boolean } = {}) =>
      request(`/api/v1/campaigns/${id}/personalize-recipients`, { method: "POST", body: JSON.stringify(body) }),
    prepareCampaign: (id: string) => request(`/api/v1/campaigns/${id}/prepare`, { method: "POST" }),
    confirmCampaign: (id: string, body: { scheduledAt?: string | null } = {}) =>
      request(`/api/v1/campaigns/${id}/confirm`, { method: "POST", body: JSON.stringify(body) }),
    startCampaign: (id: string) => request(`/api/v1/campaigns/${id}/start`, { method: "POST" }),
    pauseCampaign: (id: string) => request(`/api/v1/campaigns/${id}/pause`, { method: "POST" }),
    cancelCampaignRemainder: (id: string) =>
      request(`/api/v1/campaigns/${id}/cancel-remainder`, { method: "POST" }),
    retryFailedCampaign: (id: string) => request(`/api/v1/campaigns/${id}/retry-failed`, { method: "POST" }),
    draftCampaignMessage: (goal: string, hasFile = false) =>
      request("/api/v1/campaigns/draft-message", {
        method: "POST",
        body: JSON.stringify({ goal, hasFile }),
      }),
    updateTask: (id: string, body: unknown) =>
      request(`/api/v1/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    addTaskAttachment: (id: string, body: unknown) =>
      request(`/api/v1/tasks/${id}/attachments`, { method: "POST", body: JSON.stringify(body) }),
    removeTaskAttachment: (id: string, attachmentId: string) =>
      request(`/api/v1/tasks/${id}/attachments/${attachmentId}`, { method: "DELETE" }),
    prepareTaskExecution: (id: string) => request(`/api/v1/tasks/${id}/prepare-execution`, { method: "POST" }),
    confirmTaskExecution: (id: string) => request(`/api/v1/tasks/${id}/confirm-execution`, { method: "POST" }),
    executeTask: (id: string, body: { retryFailedFilesOnly?: boolean } = {}) =>
      request(`/api/v1/tasks/${id}/execute`, { method: "POST", body: JSON.stringify(body) }),
    completeTaskResult: (id: string, body: unknown) =>
      request(`/api/v1/tasks/${id}/complete-result`, { method: "POST", body: JSON.stringify(body) }),
    createNextAction: (id: string, body: unknown) =>
      request(`/api/v1/tasks/${id}/next-action`, { method: "POST", body: JSON.stringify(body) }),
    completeTask: (id: string) => request(`/api/v1/tasks/${id}/complete`, { method: "POST" }),
    waitTask: (id: string) => request(`/api/v1/tasks/${id}/wait`, { method: "POST" }),
    reopenTask: (id: string) => request(`/api/v1/tasks/${id}/reopen`, { method: "POST" }),
    cancelTask: (id: string) => request(`/api/v1/tasks/${id}/cancel`, { method: "POST" }),
    assignTask: (id: string, membershipId?: string) =>
      request(`/api/v1/tasks/${id}/assign`, { method: "POST", body: JSON.stringify({ membershipId }) }),
    conversations: (query: Record<string, string> = {}) => {
      const params = new URLSearchParams(query);
      const suffix = params.toString() ? `?${params}` : "";
      return request(`/api/v1/conversations${suffix}`);
    },
    conversationMessages: (id: string, before: string) => request(`/api/v1/conversations/${id}/messages?before=${encodeURIComponent(before)}`),
    markConversationRead: (id: string, messageId: string) => request(`/api/v1/conversations/${id}/read`, { method: "POST", body: JSON.stringify({ messageId }) }),
    conversation: (id: string) => request(`/api/v1/conversations/${id}`),
    analyzeConversationContext: (id: string, body: { dryRun?: boolean; useLlm?: boolean } = {}) =>
      request(`/api/v1/conversations/${id}/analyze-context`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    conversationAgreements: (id: string) => request(`/api/v1/conversations/${id}/agreements`),
    takeConversation: (id: string) => request(`/api/v1/conversations/${id}/take`, { method: "POST" }),
    returnToAi: (id: string) => request(`/api/v1/conversations/${id}/return-to-ai`, { method: "POST" }),
    pauseConversation: (id: string) => request(`/api/v1/conversations/${id}/pause`, { method: "POST", body: "{}" }),
    addInstruction: (id: string, text: string) =>
      request(`/api/v1/conversations/${id}/instruction`, { method: "POST", body: JSON.stringify({ text }) }),
    controlBoard: () => request("/api/v1/workspace/control"),
    managementOverview: () => request("/api/v1/management/overview"),
    setAiManagerPause: (paused: boolean) =>
      request("/api/v1/management/ai-pause", { method: "POST", body: JSON.stringify({ paused }) }),
    claimAllAiConversations: () => request("/api/v1/management/claim-all-ai", { method: "POST", body: "{}" }),
    integrationSetup: () => request("/api/v1/integrations/setup"),
    connectWhatsApp: (sellerUrl: string, secret: string) =>
      request("/api/v1/integrations/whatsapp-seller/connect", {
        method: "POST",
        body: JSON.stringify({ sellerUrl, secret }),
      }),
    syncWhatsApp: () => request("/api/v1/integrations/whatsapp-seller/sync", { method: "POST" }),
    rotateWebhook: (id: string) => request(`/api/v1/integrations/${id}/rotate-secret`, { method: "POST" }),
    beginTelegram: () => request("/api/v1/telegram/begin-link", { method: "POST" }),
    sendMessage: (id: string, text: string, idempotencyKey: string) =>
      request(`/api/v1/conversations/${id}/messages`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ text }),
      }),
    notifications: () => request("/api/v1/notifications"),
    markNotificationRead: (id: string) => request(`/api/v1/notifications/${id}/read`, { method: "POST" }),
    stats: () => request("/api/v1/stats/summary"),
    analyticsDashboard: (query: Record<string, string | undefined> = {}) => {
      const params = new URLSearchParams();
      Object.entries(query).forEach(([key, value]) => {
        if (value != null && value !== "") params.set(key, value);
      });
      const qs = params.toString();
      return request(`/api/v1/analytics/dashboard${qs ? `?${qs}` : ""}`);
    },
    analyticsTrend: (query: Record<string, string | undefined> = {}) => {
      const params = new URLSearchParams();
      Object.entries(query).forEach(([key, value]) => {
        if (value != null && value !== "") params.set(key, value);
      });
      const qs = params.toString();
      return request(`/api/v1/analytics/trend${qs ? `?${qs}` : ""}`);
    },
    analyticsDrilldown: (query: Record<string, string | undefined> = {}) => {
      const params = new URLSearchParams();
      Object.entries(query).forEach(([key, value]) => {
        if (value != null && value !== "") params.set(key, value);
      });
      const qs = params.toString();
      return request(`/api/v1/analytics/drilldown${qs ? `?${qs}` : ""}`);
    },
    companies: (query: Record<string, string | undefined> = {}) => {
      const params = new URLSearchParams();
      Object.entries(query).forEach(([key, value]) => {
        if (value != null && value !== "") params.set(key, value);
      });
      const qs = params.toString();
      return request(`/api/v1/companies${qs ? `?${qs}` : ""}`);
    },
    companyOverview: (id: string) => request(`/api/v1/companies/${id}/overview`),
    company: (id: string) => request(`/api/v1/companies/${id}`),
    createCompany: (body: unknown) =>
      request("/api/v1/companies", { method: "POST", body: JSON.stringify(body) }),
    updateCompany: (id: string, body: unknown) =>
      request(`/api/v1/companies/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteCompany: (id: string) => request(`/api/v1/companies/${id}`, { method: "DELETE" }),
    companyDuplicates: (query: Record<string, string | undefined> = {}) => {
      const params = new URLSearchParams();
      Object.entries(query).forEach(([key, value]) => {
        if (value != null && value !== "") params.set(key, value);
      });
      const qs = params.toString();
      return request(`/api/v1/companies/duplicates${qs ? `?${qs}` : ""}`);
    },
    companiesMigratePreview: () => request("/api/v1/companies/migrate-preview", { method: "POST" }),
    linkCompanyContact: (companyId: string, body: unknown) =>
      request(`/api/v1/companies/${companyId}/contacts`, { method: "POST", body: JSON.stringify(body) }),
    updateCompanyContact: (companyId: string, linkId: string, body: unknown) =>
      request(`/api/v1/companies/${companyId}/contacts/${linkId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    unlinkCompanyContact: (companyId: string, linkId: string) =>
      request(`/api/v1/companies/${companyId}/contacts/${linkId}`, { method: "DELETE" }),
    contactCompanies: (contactId: string) => request(`/api/v1/contacts/${contactId}/companies`),
    addDealContact: (dealId: string, body: unknown) =>
      request(`/api/v1/deals/${dealId}/contacts`, { method: "POST", body: JSON.stringify(body) }),
    integrations: () => request("/api/v1/integrations"),
    integrationCatalog: () => request("/api/v1/integrations/catalog"),
    integrationEvents: () => request("/api/v1/integrations/events"),
    integrationHealthCheck: (id: string) =>
      request(`/api/v1/integrations/${id}/health-check`, { method: "POST" }),
    setIntegrationTestMode: (id: string, testMode: boolean) =>
      request(`/api/v1/integrations/${id}/test-mode`, {
        method: "POST",
        body: JSON.stringify({ testMode }),
      }),
    sellerHealth: () => request("/api/v1/integrations/whatsapp-seller/health"),
    knowledge: () => request("/api/v1/knowledge/current"),
    sandbox: (message: string) =>
      request("/api/v1/ai/sandbox", { method: "POST", body: JSON.stringify({ message }) }),
    adminTenants: () => request("/api/v1/admin/tenants"),
  };
}
