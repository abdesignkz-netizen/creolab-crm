export type WebsiteFormInput = {
  name: string;
  allowedDomains: string[];
  assigneeMembershipId: string | null;
};

export type WebsiteFormItem = WebsiteFormInput & {
  id: string;
  integrationId: string;
  publicKey: string;
  submitUrl: string;
  enabled: boolean;
  testMode: boolean;
  automationMode: string;
  lastSubmission: { id: string; receivedAt: string; test: boolean } | null;
};

export type WebsiteFormsState = {
  items: WebsiteFormItem[];
  members: Array<{ id: string; name: string }>;
  available: boolean;
  unavailableReason: "plan" | "disabled" | null;
};
