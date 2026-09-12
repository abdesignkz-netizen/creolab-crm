import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import type { Response } from "express";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { asMoney } from "./documentMoney.ts";
import { getTenantDocumentFlags, requireDocumentsEnabled } from "./legalProfileService.ts";
import { serializeContract } from "./documentDraftService.ts";
import { verifyDocumentSignature } from "./signatureVerificationService.ts";

const SIGN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const OPEN_REQUESTS = ["PENDING", "OPENED"];

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function newToken() {
  return randomBytes(32).toString("base64url");
}

async function requireSigningEnabled(prisma: PrismaClient, tenantId: string) {
  const flags = await requireDocumentsEnabled(prisma, tenantId);
  if (!flags.contractSigningEnabled) {
    throw new ApiError(403, "signing_disabled", "Подписание договоров выключено в настройках");
  }
  return flags;
}

function serializeRequest(
  row: {
    id: string;
    signerType: string;
    signerName: string | null;
    signerIin: string | null;
    signerBin: string | null;
    order: number;
    status: string;
    expiresAt: Date | null;
    openedAt: Date | null;
    signedAt: Date | null;
    declinedAt: Date | null;
    createdAt: Date;
  },
  extra: { signUrl?: string | null } = {},
) {
  return {
    id: row.id,
    signerType: row.signerType,
    signerName: row.signerName,
    signerIin: row.signerIin,
    signerBin: row.signerBin,
    order: row.order,
    status: row.status,
    expiresAt: row.expiresAt?.toISOString() || null,
    openedAt: row.openedAt?.toISOString() || null,
    signedAt: row.signedAt?.toISOString() || null,
    declinedAt: row.declinedAt?.toISOString() || null,
    createdAt: row.createdAt.toISOString(),
    signUrl: extra.signUrl ?? null,
  };
}

async function loadContractBundle(prisma: PrismaClient, tenantId: string, contractId: string) {
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, tenantId },
    include: {
      versions: { orderBy: { version: "asc" } },
      deal: { include: { company: true, assignee: true } },
    },
  });
  if (!contract) throw new ApiError(404, "not_found", "Договор не найден");
  return contract;
}

function currentVersion(contract: { versions: Array<{ id: string; version: number; fileId: string | null; sha256: string | null }> }) {
  const latest = contract.versions[contract.versions.length - 1] || null;
  if (!latest?.fileId || !latest.sha256) {
    throw new ApiError(422, "pdf_not_ready", "Сначала сформируйте PDF договора");
  }
  return latest;
}

function expireIfNeeded<T extends { status: string; expiresAt: Date | null }>(row: T): T {
  if (OPEN_REQUESTS.includes(row.status) && row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return { ...row, status: "EXPIRED" };
  }
  return row;
}

export async function sendContractForSign(
  prisma: PrismaClient,
  auth: AuthContext,
  contractId: string,
  options: { publicBaseUrl: string },
) {
  const membership = requireTenant(auth);
  if (!can(auth, "manage_documents")) throw new ApiError(403, "forbidden", "Недостаточно прав для документов");
  const tid = membership.tenantId;
  await requireSigningEnabled(prisma, tid);
  const contract = await loadContractBundle(prisma, tid, contractId);
  if (contract.status === "SIGNED" || contract.signedAt) {
    throw new ApiError(422, "contract_immutable", "Договор уже подписан");
  }
  if (!["READY_TO_SIGN", "PENDING_SIGNATURE", "PARTIALLY_SIGNED"].includes(contract.status)) {
    throw new ApiError(422, "not_ready_to_sign", "Договор ещё не готов к подписи");
  }
  const version = currentVersion(contract);
  const profile = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: tid } });
  const company = contract.deal.company;
  if (!company) throw new ApiError(422, "missing_fields", "У сделки нет компании покупателя");

  const existing = await prisma.signatureRequest.findMany({
    where: { tenantId: tid, contractId },
    orderBy: { order: "asc" },
  });
  const sellerSigned = existing.some((row) => row.signerType === "SELLER" && row.status === "SIGNED");
  const buyerSigned = existing.some((row) => row.signerType === "BUYER" && row.status === "SIGNED");
  if (sellerSigned && buyerSigned) {
    throw new ApiError(422, "already_signed", "Обе стороны уже подписали");
  }

  const expiresAt = new Date(Date.now() + SIGN_TTL_MS);
  let buyerToken: string | null = null;
  const saved = await prisma.$transaction(async (tx) => {
    if (!contract.verificationPublicId) {
      await tx.contract.update({
        where: { id: contract.id },
        data: { verificationPublicId: randomUUID() },
      });
    }

    let seller = existing.find((row) => row.signerType === "SELLER" && ["PENDING", "OPENED", "SIGNED"].includes(row.status));
    if (!seller) {
      seller = await tx.signatureRequest.create({
        data: {
          tenantId: tid,
          contractId,
          contractVersionId: version.id,
          signerType: "SELLER",
          signerUserId: auth.user.id,
          signerName: profile?.directorName || membership.tenant.name,
          signerBin: profile?.bin || null,
          order: 1,
          status: "PENDING",
          expiresAt,
        },
      });
    }

    let buyer = existing.find((row) => row.signerType === "BUYER" && ["PENDING", "OPENED", "SIGNED"].includes(row.status));
    if (!buyer || (buyer.status !== "SIGNED" && !buyerSigned)) {
      buyerToken = newToken();
      if (buyer && buyer.status !== "SIGNED") {
        buyer = await tx.signatureRequest.update({
          where: { id: buyer.id },
          data: {
            contractVersionId: version.id,
            signerCompanyId: company.id,
            signerName: company.legalName || company.name,
            signerBin: company.bin || company.iin,
            tokenHash: hashToken(buyerToken),
            status: "PENDING",
            expiresAt,
            openedAt: null,
            declinedAt: null,
            declineReason: null,
          },
        });
      } else {
        buyer = await tx.signatureRequest.create({
          data: {
            tenantId: tid,
            contractId,
            contractVersionId: version.id,
            signerType: "BUYER",
            signerCompanyId: company.id,
            signerName: company.legalName || company.name,
            signerBin: company.bin || company.iin,
            order: 2,
            status: "PENDING",
            tokenHash: hashToken(buyerToken),
            expiresAt,
          },
        });
      }
    }

    const nextStatus = sellerSigned ? "PARTIALLY_SIGNED" : "PENDING_SIGNATURE";
    const updated = await tx.contract.update({
      where: { id: contract.id },
      data: { status: nextStatus },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: tid,
        actorUserId: auth.user.id,
        action: "contract.send_for_sign",
        entityType: "contract",
        entityId: contract.id,
        changesJson: { versionId: version.id, sellerRequestId: seller.id, buyerRequestId: buyer.id },
      },
    });
    return { updated, seller, buyer };
  });

  return {
    contract: serializeContract(saved.updated),
    requests: [
      serializeRequest(saved.seller),
      serializeRequest(saved.buyer, {
        signUrl: buyerToken ? `${options.publicBaseUrl.replace(/\/$/, "")}/sign/${buyerToken}` : null,
      }),
    ],
  };
}

export async function getContractSigning(prisma: PrismaClient, auth: AuthContext, contractId: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const contract = await loadContractBundle(prisma, tid, contractId);
  const requests = await prisma.signatureRequest.findMany({
    where: { tenantId: tid, contractId },
    orderBy: { order: "asc" },
  });
  const signatures = await prisma.documentSignature.findMany({
    where: { tenantId: tid, contractId },
    orderBy: { signedAt: "asc" },
  });
  return {
    contract: serializeContract(contract),
    verificationUrl: contract.verificationPublicId ? `/verify/${contract.verificationPublicId}` : null,
    requests: requests.map((row) => serializeRequest(expireIfNeeded(row))),
    signatures: signatures.map((row) => ({
      id: row.id,
      signerName: row.signerName,
      signerIin: row.signerIin,
      signedAt: row.signedAt.toISOString(),
      verificationStatus: row.verificationStatus,
    })),
  };
}

async function applySignature(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    request: {
      id: string;
      tenantId: string;
      contractId: string;
      contractVersionId: string | null;
      signerType: string;
      signerName: string | null;
      signerBin: string | null;
      status: string;
      expiresAt: Date | null;
      order: number;
    };
    cmsBase64: string;
    actorUserId: string | null;
  },
) {
  const request = expireIfNeeded(input.request);
  if (request.status === "EXPIRED") {
    await prisma.signatureRequest.update({ where: { id: request.id }, data: { status: "EXPIRED" } });
    throw new ApiError(422, "signature_expired", "Срок ссылки на подпись истёк");
  }
  if (!OPEN_REQUESTS.includes(request.status)) {
    throw new ApiError(422, "already_processed", "Эта сторона уже подписала или отклонила договор");
  }
  if (request.signerType === "BUYER") {
    const seller = await prisma.signatureRequest.findFirst({
      where: { tenantId: input.tenantId, contractId: request.contractId, signerType: "SELLER" },
      orderBy: { createdAt: "desc" },
    });
    if (!seller || seller.status !== "SIGNED") {
      throw new ApiError(422, "seller_must_sign_first", "Сначала подписывает исполнитель");
    }
  }

  const contract = await prisma.contract.findFirst({
    where: { id: request.contractId, tenantId: input.tenantId },
    include: { versions: { orderBy: { version: "asc" } } },
  });
  if (!contract) throw new ApiError(404, "not_found", "Договор не найден");
  const version = currentVersion(contract);
  if (request.contractVersionId && request.contractVersionId !== version.id) {
    throw new ApiError(422, "version_mismatch", "Подпись относится к другой версии договора");
  }

  const verification = verifyDocumentSignature({
    cmsBase64: input.cmsBase64,
    documentHash: version.sha256!,
    expectedBin: request.signerBin,
  });
  if (verification.status === "FAILED") {
    throw new ApiError(422, "signature_invalid", "Подпись не прошла проверку", undefined, verification.details);
  }

  const cms = Buffer.from(
    input.cmsBase64.replace(/-----BEGIN CMS-----/g, "").replace(/-----END CMS-----/g, "").replace(/\s+/g, ""),
    "base64",
  );
  const attachmentId = randomUUID();
  const storageKey = path.posix.join(input.tenantId, "signatures", request.contractId, `${attachmentId}.p7s`);
  const abs = resolveUploadPath(storageKey);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, cms);

  const cert = verification.inspection?.primary;
  const result = await prisma.$transaction(async (tx) => {
    await tx.attachment.create({
      data: {
        id: attachmentId,
        tenantId: input.tenantId,
        parentType: "document_signature",
        parentId: request.id,
        storageKey,
        fileName: `${request.signerType.toLowerCase()}.p7s`,
        originalFileName: `${request.signerType.toLowerCase()}.p7s`,
        mimeType: "application/pkcs7-signature",
        sizeBytes: cms.length,
        checksum: createHash("sha256").update(cms).digest("hex"),
        documentType: "signature",
        uploadedById: input.actorUserId,
        status: "stored",
      },
    });
    const signature = await tx.documentSignature.create({
      data: {
        tenantId: input.tenantId,
        contractId: request.contractId,
        contractVersionId: version.id,
        signatureRequestId: request.id,
        signerName: cert?.commonName || request.signerName,
        signerIin: cert?.iin || null,
        signerBin: cert?.bin || request.signerBin,
        certificateSerial: cert?.serial || null,
        certificateIssuer: cert?.issuer || null,
        certificateValidFrom: cert?.validFrom,
        certificateValidTo: cert?.validTo,
        signatureFormat: "CMS_DETACHED",
        signatureFileId: attachmentId,
        documentHash: version.sha256!,
        verificationStatus: verification.status,
        verificationDetails: verification.details as object,
      },
    });
    await tx.signatureRequest.update({
      where: { id: request.id },
      data: { status: "SIGNED", signedAt: new Date() },
    });

    const signedCount = await tx.signatureRequest.count({
      where: { tenantId: input.tenantId, contractId: request.contractId, status: "SIGNED" },
    });
    const allRequired = await tx.signatureRequest.count({
      where: {
        tenantId: input.tenantId,
        contractId: request.contractId,
        signerType: { in: ["SELLER", "BUYER"] },
        status: { notIn: ["CANCELLED", "EXPIRED", "DECLINED"] },
      },
    });
    const bothSigned = signedCount >= 2;
    const updated = await tx.contract.update({
      where: { id: request.contractId },
      data: bothSigned
        ? { status: "SIGNED", signedAt: new Date() }
        : { status: "PARTIALLY_SIGNED" },
    });

    if (bothSigned) {
      await tx.outboxEvent.create({
        data: {
          tenantId: input.tenantId,
          type: "contract.signed",
          entityType: "contract",
          entityId: updated.id,
          payloadJson: { contractId: updated.id, dealId: updated.dealId, signedCount, allRequired },
        },
      });
    }
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: bothSigned ? "contract.signed" : "contract.partially_signed",
        entityType: "contract",
        entityId: updated.id,
        changesJson: { requestId: request.id, signerType: request.signerType, verificationStatus: verification.status },
      },
    });
    return { signature, contract: updated, bothSigned };
  });

  if (result.bothSigned) {
    const deal = await prisma.deal.findFirst({
      where: { id: result.contract.dealId, tenantId: input.tenantId },
      select: { assigneeMembershipId: true },
    });
    const { createStaffNotification } = await import("./notificationService.ts");
    await createStaffNotification(prisma, {
      tenantId: input.tenantId,
      membershipId: deal?.assigneeMembershipId,
      type: "contract.signed",
      entityType: "contract",
      entityId: result.contract.id,
      title: "Договор подписан",
      body: `Договор ${result.contract.number} подписан обеими сторонами`,
    });
    const { ensureInvoiceDraftForSignedContract } = await import("./invoiceSignedWorkflow.ts");
    await ensureInvoiceDraftForSignedContract(prisma, {
      tenantId: input.tenantId,
      dealId: result.contract.dealId,
      contractId: result.contract.id,
      actorUserId: input.actorUserId,
    });
  }

  return result;
}

export async function signContractAsSeller(
  prisma: PrismaClient,
  auth: AuthContext,
  requestId: string,
  cmsBase64: string,
) {
  const membership = requireTenant(auth);
  if (!can(auth, "sign_documents")) throw new ApiError(403, "forbidden", "Недостаточно прав для подписи");
  await requireSigningEnabled(prisma, membership.tenantId);
  const request = await prisma.signatureRequest.findFirst({
    where: { id: requestId, tenantId: membership.tenantId, signerType: "SELLER" },
  });
  if (!request) throw new ApiError(404, "not_found", "Запрос на подпись не найден");
  const result = await applySignature(prisma, {
    tenantId: membership.tenantId,
    request,
    cmsBase64,
    actorUserId: auth.user.id,
  });
  return { contract: serializeContract(result.contract), bothSigned: result.bothSigned };
}

export async function declineContractAsSeller(
  prisma: PrismaClient,
  auth: AuthContext,
  requestId: string,
  reason?: string | null,
) {
  const membership = requireTenant(auth);
  if (!can(auth, "sign_documents")) throw new ApiError(403, "forbidden", "Недостаточно прав для подписи");
  const request = await prisma.signatureRequest.findFirst({
    where: { id: requestId, tenantId: membership.tenantId, signerType: "SELLER" },
  });
  if (!request) throw new ApiError(404, "not_found", "Запрос на подпись не найден");
  if (!OPEN_REQUESTS.includes(request.status)) {
    throw new ApiError(422, "already_processed", "Запрос уже обработан");
  }
  await prisma.$transaction(async (tx) => {
    await tx.signatureRequest.update({
      where: { id: request.id },
      data: { status: "DECLINED", declinedAt: new Date(), declineReason: reason?.trim() || null },
    });
    await tx.signatureRequest.updateMany({
      where: { tenantId: membership.tenantId, contractId: request.contractId, status: { in: OPEN_REQUESTS } },
      data: { status: "CANCELLED" },
    });
    await tx.contract.update({
      where: { id: request.contractId },
      data: { status: "READY_TO_SIGN" },
    });
  });
  return { ok: true };
}

async function loadPublicRequest(prisma: PrismaClient, token: string) {
  const request = await prisma.signatureRequest.findFirst({
    where: { tokenHash: hashToken(token), signerType: "BUYER" },
    include: {
      contract: {
        include: {
          deal: { include: { company: true } },
          versions: { orderBy: { version: "asc" } },
        },
      },
    },
  });
  if (!request) throw new ApiError(404, "not_found", "Ссылка недействительна");
  const current = expireIfNeeded(request);
  if (current.status === "EXPIRED" && request.status !== "EXPIRED") {
    await prisma.signatureRequest.update({ where: { id: request.id }, data: { status: "EXPIRED" } });
  }
  return { ...request, status: current.status };
}

function publicContractView(
  request: Awaited<ReturnType<typeof loadPublicRequest>>,
  sellerSigned: boolean,
) {
  const contract = request.contract;
  const company = contract.deal.company;
  const open = request.status === "PENDING" || request.status === "OPENED";
  return {
    number: contract.number,
    date: contract.date.toISOString(),
    subject: contract.subject,
    amount: asMoney(contract.totalAmount),
    currency: contract.currency,
    sellerName: null as string | null,
    buyerName: company?.legalName || company?.name || request.signerName,
    status: request.status,
    contractStatus: contract.status,
    canSign: open && sellerSigned,
    canDecline: open,
    waitingForSeller: open && !sellerSigned,
  };
}

export async function getPublicSign(prisma: PrismaClient, token: string) {
  const request = await loadPublicRequest(prisma, token);
  const [profile, seller] = await Promise.all([
    prisma.tenantLegalProfile.findUnique({
      where: { tenantId: request.tenantId },
      select: { legalName: true, shortName: true },
    }),
    prisma.signatureRequest.findFirst({
      where: { tenantId: request.tenantId, contractId: request.contractId, signerType: "SELLER" },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const view = publicContractView(request, seller?.status === "SIGNED");
  view.sellerName = profile?.legalName || profile?.shortName || null;
  if ((request.status === "PENDING" || request.status === "OPENED") && !request.openedAt) {
    await prisma.signatureRequest.update({
      where: { id: request.id },
      data: { status: request.status === "PENDING" ? "OPENED" : request.status, openedAt: new Date() },
    });
    view.status = request.status === "PENDING" ? "OPENED" : request.status;
  }
  return view;
}

export async function sendPublicSignPdf(prisma: PrismaClient, token: string, res: Response) {
  const request = await loadPublicRequest(prisma, token);
  if (!request.contract.generatedFileId) throw new ApiError(404, "pdf_not_ready", "PDF ещё не готов");
  const attachment = await prisma.attachment.findFirst({
    where: {
      id: request.contract.generatedFileId,
      tenantId: request.tenantId,
      parentType: "contract",
      parentId: request.contractId,
    },
  });
  if (!attachment) throw new ApiError(404, "not_found", "Файл договора не найден");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(request.contract.number)}.pdf"`);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(resolveUploadPath(attachment.storageKey));
    stream.on("error", () => reject(new ApiError(404, "not_found", "Файл договора не найден на диске")));
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
}

export async function signPublicContract(prisma: PrismaClient, token: string, cmsBase64: string) {
  const request = await loadPublicRequest(prisma, token);
  const flags = await getTenantDocumentFlags(prisma, request.tenantId);
  if (!flags.contractSigningEnabled) {
    throw new ApiError(403, "signing_disabled", "Подписание договоров выключено");
  }
  const result = await applySignature(prisma, {
    tenantId: request.tenantId,
    request,
    cmsBase64,
    actorUserId: null,
  });
  return { ok: true, contractStatus: result.contract.status, bothSigned: result.bothSigned };
}

export async function declinePublicContract(prisma: PrismaClient, token: string, reason?: string | null) {
  const request = await loadPublicRequest(prisma, token);
  if (!OPEN_REQUESTS.includes(request.status)) {
    throw new ApiError(422, "already_processed", "Запрос уже обработан");
  }
  await prisma.signatureRequest.update({
    where: { id: request.id },
    data: { status: "DECLINED", declinedAt: new Date(), declineReason: reason?.trim() || null },
  });
  return { ok: true };
}

export async function getPublicVerification(prisma: PrismaClient, verificationId: string) {
  const contract = await prisma.contract.findFirst({
    where: { verificationPublicId: verificationId },
    include: {
      deal: { include: { company: true } },
      versions: { orderBy: { version: "asc" } },
    },
  });
  if (!contract) throw new ApiError(404, "not_found", "Проверка не найдена");
  const profile = await prisma.tenantLegalProfile.findUnique({
    where: { tenantId: contract.tenantId },
    select: { legalName: true, shortName: true },
  });
  const signatures = await prisma.documentSignature.findMany({
    where: { tenantId: contract.tenantId, contractId: contract.id },
    orderBy: { signedAt: "asc" },
  });
  const latest = contract.versions[contract.versions.length - 1] || null;
  return {
    number: contract.number,
    date: contract.date.toISOString(),
    version: latest?.version || null,
    documentHash: latest?.sha256 || null,
    status: contract.status,
    signedAt: contract.signedAt?.toISOString() || null,
    sellerName: profile?.legalName || profile?.shortName || null,
    buyerName: contract.deal.company?.legalName || contract.deal.company?.name || null,
    signers: signatures.map((row) => ({
      name: row.signerName,
      iin: row.signerIin,
      signedAt: row.signedAt.toISOString(),
      verificationStatus: row.verificationStatus,
    })),
  };
}
