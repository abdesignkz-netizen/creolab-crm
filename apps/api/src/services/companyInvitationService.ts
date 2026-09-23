import { z } from "zod";
import type { PrismaClient } from "@creolab/db";
import { requireCompanyAdmin, requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { createTenantInvitation, getInvitationCapacity, revokeInvitation, rotateInvitation } from "./invitationService.ts";

const invitationInput = z.object({
  email: z.string().trim().email("Укажите корректную электронную почту").max(254),
  name: z.string().trim().min(1, "Укажите имя сотрудника").max(160),
  role: z.enum(["owner", "director", "sales_lead", "manager"]).default("manager"),
}).strict();

export async function inviteCompanyMember(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  requireCompanyAdmin(auth);
  const { tenantId } = requireTenant(auth);
  const result = await createTenantInvitation(prisma, { ...invitationInput.parse(input), tenantId, inviterId: auth.user.id });
  return { id: result.invitation.id, email: result.invitation.email, inviteUrl: result.inviteUrl, expiresAt: result.invitation.expiresAt };
}

export async function manageCompanyInvitation(prisma: PrismaClient, auth: AuthContext, id: string, action: "renew" | "revoke") {
  requireCompanyAdmin(auth);
  const { tenantId } = requireTenant(auth);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    const invitation = await tx.invitation.findFirst({ where: { id, tenantId } });
    if (!invitation) throw new ApiError(404, "not_found", "Приглашение не найдено");
    if (action === "revoke") { await revokeInvitation(tx, id, auth.user.id); return { ok: true }; }
    if (invitation.acceptedAt) throw new ApiError(409, "accepted", "Приглашение уже принято");
    const capacity = await getInvitationCapacity(tx, tenantId, id);
    if (!capacity.canInvite) throw new ApiError(422, "member_limit", "Нет свободного места для приглашения. Измените тариф или освободите место.");
    const result = await rotateInvitation(tx, id, auth.user.id);
    return { id, email: invitation.email, inviteUrl: result.inviteUrl, expiresAt: result.invitation.expiresAt };
  });
}
