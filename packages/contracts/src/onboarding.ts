export type SetupChannel = "whatsapp" | "telegram" | "instagram" | "website-chat" | "form";
export type SetupStep = "path" | "channel" | "knowledge" | "rules" | "test";
export type SetupState = {
  channel: SetupChannel | null;
  replyMode: "ai" | "manual";
  started: boolean;
  deferred: boolean;
  suggested: boolean;
  completed: boolean;
  steps: Array<{ id: SetupStep; done: boolean }>;
  available: Record<SetupChannel | "ai", boolean>;
  evidence: { inbound: boolean; reply: boolean; conversationId: string | null; inquiryId: string | null };
};
export type SetupUpdate = { channel?: SetupChannel; replyMode?: "ai" | "manual"; deferred?: boolean; finish?: true };
