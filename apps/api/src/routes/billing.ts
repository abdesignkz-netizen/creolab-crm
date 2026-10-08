import {
  checkOrderPayment,
  releaseUncreatedPayment,
} from "../services/billing/paymentCheck.ts";
import { rateLimit, clientIp } from "../lib/rateLimit.ts";
import express from "express";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@creolab/db";
import type { AuthContext } from "../lib/types.ts";
import { requirePlatformAdmin } from "../lib/access.ts";
import {
  createCheckout,
  checkoutDetail,
  payOrder,
  processPaymentNotice,
  manualConfirm,
  cancelOrder,
  cancelAutoRenew,
  billingHistory,
  billingTenant,
  queueBillingEmail,
} from "../services/billing/ledger.ts";
import { freedomPay } from "../services/billing/freedomPayProvider.ts";
import { billingError, billingConfig } from "../services/billing/config.ts";
import {
  renderBillingInvoice,
  saveSeller,
  issueInvoice,
} from "../services/billing/documents.ts";
import {
  adminBilling,
  attachKaspiLink,
  updateBillingPlan,
  inspectProviderPayment,
} from "../services/billing/admin.ts";

export function registerBillingRoutes(
  app: express.Express,
  db: PrismaClient,
  auth: (r: express.Request) => Promise<AuthContext>,
) {
  const json = express.json({ limit: "32kb" }),
    base = "/api/v1/billing";
  app.use([base, "/api/v1/admin/billing"], (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.post(
    `${base}/providers/freedompay/webhook`,
    express.raw({
      type: ["application/x-www-form-urlencoded", "multipart/form-data"],
      limit: "32kb",
    }),
    async (req, res) => {
      rateLimit(`billing-webhook:${clientIp(req)}`, 300);
      if (!Buffer.isBuffer(req.body))
        billingError("webhook_format", "Ожидается форма", 400);
      const form = await new Response(new Uint8Array(req.body), {
        headers: { "content-type": req.headers["content-type"] || "" },
      }).formData();
      const fields: Record<string, string> = {};
      for (const [key, value] of form.entries()) {
        if (
          typeof value !== "string" ||
          Object.hasOwn(fields, key) ||
          !/^\w{1,64}$/.test(key) ||
          value.length > 4000
        )
          billingError("webhook_fields", "Некорректные поля", 400);
        fields[key] = value;
      }
      try {
        const notice = freedomPay.handleWebhook(fields);
        await processPaymentNotice(db, notice);
      } catch (error) {
        const eventId = createHash("sha256").update(req.body).digest("hex");
        const errorCode =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "processing_failed";
        // No raw payload, signature, PAN, tokens or customer data in the diagnostic ledger.
        await db.paymentWebhookEvent.upsert({
          where: { provider_eventId: { provider: "FREEDOM_PAY", eventId } },
          create: {
            provider: "FREEDOM_PAY",
            eventId,
            eventType: "rejected",
            status: "failed",
            errorCode,
          },
          update: { errorCode },
        });
        throw error;
      }
      res.type("application/xml").send(freedomPay.acknowledgement());
    },
  );
  app.post(`${base}/checkout`, json, async (req, res) =>
    res.status(201).json(await createCheckout(db, await auth(req), req.body)),
  );
  app.get(`${base}/orders/:id`, async (req, res) =>
    res.json(await checkoutDetail(db, await auth(req), String(req.params.id))),
  );
  app.post(`${base}/orders/:id/check`, async (req, res) => {
    const who = await auth(req);
    const tenantId = billingTenant(who);
    rateLimit(`billing-check-order:${tenantId}`, 10);
    res.json(await checkOrderPayment(db, who, String(req.params.id)));
  });
  app.post(
    "/api/v1/admin/billing/payments/:id/release",
    json,
    async (req, res) => {
      const who = await auth(req);
      requirePlatformAdmin(who);
      rateLimit(`billing-release:${who.user.id}`, 5);
      res.json(
        await releaseUncreatedPayment(db, who, String(req.params.id), req.body),
      );
    },
  );
  app.get(`${base}/orders/:id/kaspi-qr`, async (req, res) => {
    const d = await checkoutDetail(db, await auth(req), String(req.params.id));
    const p = d.payments.find(
      (p) => p.method === "KASPI" && p.status === "PENDING" && p.checkoutUrl,
    );
    if (!p?.checkoutUrl)
      billingError("not_found", "Ссылка Kaspi ещё не добавлена", 404);
    const qr = await import("qrcode");
    res.json({
      image: await qr.toDataURL(p.checkoutUrl, { width: 256, margin: 2 }),
      url: p.checkoutUrl,
    });
  });
  app.post(`${base}/orders/:id/cancel`, async (req, res) =>
    res.json(await cancelOrder(db, await auth(req), String(req.params.id))),
  );
  app.post(`${base}/payments`, json, async (req, res) =>
    res.json(await payOrder(db, await auth(req), req.body)),
  );
  app.get(`${base}/history`, async (req, res) =>
    res.json(await billingHistory(db, await auth(req))),
  );
  app.post(`${base}/subscription/cancel-auto-renew`, async (req, res) =>
    res.json(await cancelAutoRenew(db, await auth(req))),
  );
  app.post(`${base}/orders/:id/document`, json, async (req, res) => {
    const who = await auth(req),
      detail = await checkoutDetail(db, who, String(req.params.id));
    const payment = detail.payments.find((p) => p.status === "PAID");
    if (!payment)
      billingError("payment_pending", "Документ доступен после оплаты");
    const invoice = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${detail.order.tenantId} FOR UPDATE`;
      const inv = await issueInvoice(tx, detail.order, payment.id, req.body);
      return tx.billingInvoice.update({
        where: { id: inv.id },
        data: { status: "PAID", paidAt: payment.paidAt },
      });
    });
    res.json(invoice);
  });
  async function invoiceFor(req: express.Request) {
    const who = await auth(req);
    const tenantId = req.path.startsWith("/api/v1/admin/")
      ? (requirePlatformAdmin(who), undefined)
      : billingTenant(who);
    const invoice = await db.billingInvoice.findFirst({
      where: { id: String(req.params.id), ...(tenantId ? { tenantId } : {}) },
    });
    if (!invoice) billingError("not_found", "Счёт не найден", 404);
    return invoice;
  }
  for (const prefix of [base, "/api/v1/admin/billing"])
    app.get(`${prefix}/invoices/:id/pdf`, async (req, res) => {
      const invoice = await invoiceFor(req);
      res
        .set("Cache-Control", "no-store")
        .set(
          "Content-Disposition",
          `attachment; filename="${invoice.invoiceNumber}.pdf"`,
        )
        .type("application/pdf")
        .send(await renderBillingInvoice(invoice));
    });
  app.post(`${base}/invoices/:id/email`, async (req, res) => {
    const invoice = await invoiceFor(req);
    if (["CANCELLED", "EXPIRED"].includes(invoice.status))
      billingError("invoice_closed", "Счёт закрыт", 409);
    rateLimit(`billing-invoice-email:${invoice.tenantId}`, 5, 3600_000);
    await queueBillingEmail(
      db,
      invoice.tenantId,
      invoice.id,
      `Счёт BasQar ${invoice.invoiceNumber}`,
      `Счёт ${invoice.invoiceNumber} на ${invoice.amountMinor} ₸. Скачать PDF: ${billingConfig().appUrl}/billing/checkout/${invoice.orderId}`,
    );
    res.json({ queued: true });
  });
  app.post("/api/v1/admin/billing/payments/:id/check", async (req, res) => {
    const who = await auth(req);
    requirePlatformAdmin(who);
    rateLimit(`billing-check:${who.user.id}`, 20);
    res.json(await inspectProviderPayment(db, who, String(req.params.id)));
  });
  app.get("/api/v1/admin/billing/ledger", async (req, res) =>
    res.json(await adminBilling(db, await auth(req), req.query)),
  );
  app.post(
    "/api/v1/admin/billing/payments/:id/confirm",
    json,
    async (req, res) =>
      res.json(
        await manualConfirm(
          db,
          await auth(req),
          String(req.params.id),
          req.body,
        ),
      ),
  );
  app.post(
    "/api/v1/admin/billing/payments/:id/kaspi-link",
    json,
    async (req, res) =>
      res.json(
        await attachKaspiLink(
          db,
          await auth(req),
          String(req.params.id),
          req.body,
        ),
      ),
  );
  app.put("/api/v1/admin/billing/seller", async (req, _res, next) => {
    try { requirePlatformAdmin(await auth(req)); next(); }
    catch (error) { next(error); }
  }, express.json({ limit: "1mb" }), async (req, res) =>
    res.json(await saveSeller(db, await auth(req), req.body)),
  );
  app.put("/api/v1/admin/billing/plans/:id", json, async (req, res) =>
    res.json(
      await updateBillingPlan(
        db,
        await auth(req),
        String(req.params.id),
        req.body,
      ),
    ),
  );
}
