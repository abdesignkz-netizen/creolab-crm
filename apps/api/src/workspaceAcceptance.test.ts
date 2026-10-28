import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import type { Server } from "node:http";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { assertTestDatabase } from "./testSupport/testDatabase.ts";

// Cross-module acceptance on a brand-new company, not the populated demo account.
// All business mutations use public HTTP routes. The seed only supplies a platform
// administrator and an unrelated company for access checks. No external requests.
let db: Awaited<ReturnType<typeof createPrismaClient>>;
let server: Server;
let base = "", owner = "", employee = "", platform = "", foreign = "";
let tenantId = "", employeeId = "", formKey = "", inquiryId = "", contactId = "", dealId = "", taskId = "", invoiceId = "";
const ownerEmail = "acceptance-owner@example.test", employeeEmail = "acceptance-manager@example.test";
const password = "AcceptanceTest1!";

async function request(session: string, path: string, method = "GET", body?: unknown, status = 200, extraHeaders = {}) {
  const response = await fetch(base + path, { method, headers: { cookie: session, "content-type": "application/json", ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  return { data, cookie: (response.headers.get("set-cookie") || "").split(";")[0] };
}
async function login(email: string, pass = process.env.SEED_PASSWORD) {
  const result = await request("", "/api/v1/auth/login", "POST", { email, password: pass, client: "web" });
  assert.ok(result.cookie);
  return result.cookie;
}

before(async () => {
  assertTestDatabase();
  process.env.CRM_INLINE_AUTOMATION = "0";
  db = await createPrismaClient();
  await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(new URL(input instanceof Request ? input.url : String(input)).origin, base, "Acceptance must never contact an external service");
    return originalFetch(input, init);
  });
  platform = await login("platform@creolab.example");
  foreign = await login("owner@demo-agency.example");
});
after(async () => {
  mock.restoreAll();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await db?.$disconnect();
});

test("new owner → employee → inquiry → task → invoice → payment → reports", async t => {
  let blocked = false;
  async function step(name: string, run: () => Promise<void>) {
    await t.test(name, { skip: blocked ? "Previous step failed" : false }, async () => {
      try { await run(); } catch (error) { blocked = true; throw error; }
    });
  }

  await step("регистрация, проверка почты и начало настройки новой компании", async () => {
    const started = await request("", "/api/v1/auth/register", "POST", {
      name: "Владелец приёмки", companyName: "Компания приёмки", email: ownerEmail, password, passwordConfirm: password,
    });
    assert.ok(started.data.verificationCode);
    assert.equal(await db.user.count({ where: { email: ownerEmail } }), 0);
    const verified = await request("", "/api/v1/auth/register/verify", "POST", { email: ownerEmail, code: started.data.verificationCode, locale: "ru" });
    owner = verified.cookie; assert.ok(owner);
    tenantId = verified.data.user.activeTenant.tenant.id;
    assert.equal(verified.data.user.activeTenant.role, "owner");
    assert.equal(verified.data.user.billing.planCode, "BASQAR_FREE");
    assert.equal((await request(owner, "/api/v1/workspace/onboarding")).data.started, false);
    const setup = await request(owner, "/api/v1/workspace/onboarding", "PATCH", { channel: "form", replyMode: "manual" });
    assert.equal(setup.data.completed, false);
    // This is test provisioning via the supported admin route; no payment provider.
    await request(platform, `/api/v1/admin/tenants/${tenantId}/subscription/activate`, "POST", { planCode: "SALES" });
  });

  await step("приглашение сотрудника, вход и разграничение прав", async () => {
    const invitation = await request(owner, "/api/v1/settings/members/invitations", "POST", {
      name: "Менеджер приёмки", email: employeeEmail, role: "manager",
    }, 201);
    const token = invitation.data.inviteUrl.split("/invite/")[1]; assert.ok(token);
    assert.equal((await request("", `/api/v1/invitations/${token}/accept`, "POST", { password })).data.tenantId, tenantId);
    employee = await login(employeeEmail, password);
    employeeId = (await db.membership.findFirstOrThrow({ where: { tenantId, user: { email: employeeEmail } } })).id;
    await request(employee, "/api/v1/settings/members/invitations", "POST", { name: "Запрещено", email: "forbidden@example.test", role: "manager" }, 403);
    await request(employee, "/api/v1/workspace/audit", "GET", undefined, 403);
  });

  await step("подключённая администратором форма передаёт одну заявку нужному сотруднику", async () => {
    const connection = await request(platform, `/api/v1/admin/tenants/${tenantId}/integrations`, "POST", {
      type: "form", name: "Форма приёмки", assigneeMembershipId: employeeId, automationMode: "MANUAL",
    }, 201);
    formKey = connection.data.forms[0].publicKey;
    const payload = { name: "Клиент приёмки", phone: "+77015550991", message: "Нужна консультация и настройка сервиса" };
    const headers = { "x-submission-id": "workspace-acceptance" };
    const first = await request("", `/public/forms/${formKey}/submissions`, "POST", payload, 202, headers);
    const second = await request("", `/public/forms/${formKey}/submissions`, "POST", payload, 200, headers);
    assert.equal(first.data.receipt, second.data.receipt);
    const list = (await request(employee, "/api/v1/inquiries?filter=all")).data.items;
    assert.equal(list.length, 1);
    inquiryId = list[0].id;
    const detail = (await request(employee, `/api/v1/inquiries/${inquiryId}`)).data;
    assert.equal(detail.assigneeMembershipId, employeeId); contactId = detail.contactId; assert.ok(contactId);
    await request(foreign, `/api/v1/inquiries/${inquiryId}`, "GET", undefined, 404);
    const setup = (await request(owner, "/api/v1/workspace/onboarding")).data;
    assert.ok(setup.steps.every((s: { done: boolean }) => s.done));
    assert.equal((await request(owner, "/api/v1/workspace/onboarding", "PATCH", { finish: true })).data.completed, true);
  });

  await step("сотрудник принимает заявку, создаёт сделку и выполняет задачу с историей", async () => {
    await request(employee, `/api/v1/inquiries/${inquiryId}/take`, "POST", {});
    const deal = (await request(employee, `/api/v1/inquiries/${inquiryId}/convert-to-deal`, "POST", { title: "Настройка сервиса" })).data;
    dealId = deal.id;
    assert.equal(deal.contactId, contactId); assert.equal(deal.assigneeMembershipId, employeeId);
    assert.equal((await request(employee, `/api/v1/inquiries/${inquiryId}/convert-to-deal`, "POST", {})).data.id, dealId);
    const task = (await request(owner, "/api/v1/tasks", "POST", { type: "meeting", title: "Обсудить настройку сервиса", targetType: "client",
      contactId, inquiryId, dealId, ownerMembershipId: employeeId, dueAt: new Date(Date.now() + 86400000).toISOString() }, 201)).data;
    taskId = task.id;
    const assigned = (await request(employee, `/api/v1/tasks/${taskId}`)).data;
    assert.equal(assigned.ownerMembershipId, employeeId);
    await request(foreign, `/api/v1/tasks/${taskId}`, "GET", undefined, 404);
    const done = (await request(employee, `/api/v1/tasks/${taskId}/complete-result`, "POST", {
      resultCode: "agreed", resultText: "Согласован объём настройки и стоимость 120 000 тенге", skipNext: true,
    })).data;
    assert.equal(done.task.status, "done"); assert.equal(done.nextTask, null);
    const history = (await request(owner, `/api/v1/contacts/${contactId}`)).data;
    assert.ok(history.timeline.some((event: { type: string; description: string }) => event.type === "task.completed" && event.description.includes("120 000")));
  });

  await step("выставленный счёт имеет PDF, но ещё не считается оплатой", async () => {
    await request(owner, "/api/v1/settings/legal-profile", "PATCH", {
      legalName: "ТОО Компания приёмки", bin: "123456789013", legalAddress: "Тестовый адрес исполнителя", directorName: "Тестовый Директор",
      bankName: "Тестовый банк", iban: "KZ86125KZT5004100100", bik: "KCJBKZKX", defaultVatMode: "none", defaultVatRate: 0,
    });
    const company = (await request(owner, "/api/v1/companies", "POST", {
      name: "ТОО Заказчик приёмки", legalName: "ТОО Заказчик приёмки", bin: "222222222220", legalAddress: "Тестовый адрес заказчика", forceCreate: true,
    }, 201)).data;
    await request(owner, `/api/v1/deals/${dealId}`, "PATCH", { companyId: company.id, offerAmountMinor: 120000 });
    await request(owner, `/api/v1/deals/${dealId}/items`, "POST", { name: "Настройка сервиса", quantity: 1, unitPrice: 120000, vatRate: 0 }, 201);
    const draft = (await request(owner, `/api/v1/deals/${dealId}/invoices`, "POST", {}, 201)).data;
    invoiceId = draft.invoice.id;
    const invoice = (await request(owner, `/api/v1/invoices/${invoiceId}/generate`, "POST", {})).data.invoice;
    assert.equal(invoice.status, "ISSUED"); assert.equal(invoice.totalAmount, 120000);
    const response = await fetch(`${base}/api/v1/invoices/${invoiceId}/pdf`, { headers: { cookie: owner } });
    assert.equal(response.status, 200); assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), "%PDF");
    const report = (await request(owner, "/api/v1/analytics/dashboard?period=this_month&compare=none")).data;
    assert.equal(report.sales.won, 0); assert.equal(report.sales.receipts, 0);
  });

  await step("оплата и продажа учитываются отдельно; сотрудник не подтверждает платежи", async () => {
    const path = `/api/v1/deals/${dealId}/payments`;
    await request(employee, path, "POST", { amountMinor: 120000, currency: "KZT" }, 403);
    await request(owner, path, "POST", { amountMinor: -1, currency: "KZT" }, 422);
    assert.equal(await db.paymentRecord.count({ where: { tenantId, dealId } }), 0);
    const first = (await request(owner, path, "POST", { amountMinor: 40000, currency: "KZT", comment: "Тестовый аванс" }, 201)).data;
    assert.equal(first.paymentStatus, "PARTIALLY_PAID");
    const partial = (await request(owner, "/api/v1/analytics/dashboard?period=this_month&compare=none")).data;
    assert.equal(partial.sales.receipts, 40000); assert.equal(partial.sales.won, 0);
    const second = (await request(owner, path, "POST", { amountMinor: 80000, currency: "KZT", comment: "Тестовая доплата" }, 201)).data;
    assert.equal(second.paymentStatus, "PAID");
    await request(employee, `/api/v1/deals/${dealId}/won`, "POST", { wonAmountMinor: 120000 });
    const report = (await request(owner, "/api/v1/analytics/dashboard?period=this_month&compare=none")).data;
    assert.equal(report.sales.won, 1); assert.equal(report.sales.revenue, 120000);
    assert.equal(report.sales.receipts, 120000); assert.equal(report.sales.receiptCount, 2);
    assert.equal(report.overview.conversion, 100);
    const audit = (await request(owner, "/api/v1/workspace/audit")).data;
    assert.equal(audit.items.filter((event: { action: string }) => event.action === "payment.confirm").length, 2);
    await request(foreign, `/api/v1/deals/${dealId}`, "GET", undefined, 404);
    await request(foreign, `/api/v1/invoices/${invoiceId}`, "GET", undefined, 404);
  });
});
