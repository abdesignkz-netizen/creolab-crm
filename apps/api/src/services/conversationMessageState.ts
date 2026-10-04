/** Outbound drafts and uncertain sends are not evidence of what the customer received. */
export const UNDELIVERED_MESSAGE_STATES = ["queued", "sending", "failed", "canceled", "unknown"];
export const deliveredConversationMessage = {
  internal: false,
  operationState: { notIn: UNDELIVERED_MESSAGE_STATES },
};
