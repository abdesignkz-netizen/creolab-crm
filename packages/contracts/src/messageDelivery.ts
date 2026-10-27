export type MessageDeliveryPart = {
  id: string;
  label: string;
  state: "pending" | "sending" | "accepted" | "failed" | "unknown";
  providerMessageId: string | null;
  checkedBy: string | null;
  checkedAt: string | null;
  note: string | null;
};
export type MessageRetryBlock = "permissions" | "busy" | "unknown" | "complete" | "conversation_changed"
  | "access_changed" | "connection_changed" | "campaign_stopped" | "campaign_changed" | "plan" | "window_closed" | "policy_changed" | null;
export type MessageDeliveryReview = {
  channel: "whatsapp" | "whatsapp_qr" | "whatsapp_cloud" | "telegram" | "instagram";
  aiReply?: boolean;
  messageId: string;
  conversationId: string;
  revision: string;
  text: string | null;
  createdAt: string;
  recipient: string;
  campaignId: string | null;
  parts: MessageDeliveryPart[];
  busy: boolean;
  needsCheck: boolean;
  canReconcile: boolean;
  canRetry: boolean;
  retryBlock: MessageRetryBlock;
};
export type MessageDeliveryReconciliation = {
  revision: string;
  partId: string;
  outcome: "sent" | "not_sent";
  note: string;
};
