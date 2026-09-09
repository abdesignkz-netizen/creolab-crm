export const CLOSED_INQUIRY_STATUSES = ["lost", "invalid", "spam", "converted"] as const;
export const OPEN_INTAKE_STATUSES = ["pending", "open", "needs_phone"] as const;

/** Inquiries that the Заявки nav badge counts: new or waiting for a reply, still open. */
export function inquiryNeedsActionWhere(tenantId: string) {
  return {
    tenantId,
    archived: false,
    status: { notIn: [...CLOSED_INQUIRY_STATUSES] },
    OR: [{ status: "new" }, { needsReply: true }],
  };
}

export function openIntakeWhere(tenantId: string) {
  return {
    tenantId,
    status: { in: [...OPEN_INTAKE_STATUSES] },
  };
}
