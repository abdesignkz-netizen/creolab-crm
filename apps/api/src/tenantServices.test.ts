import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { seedDatabase } from "../../../packages/db/src/seed.ts";
import type { AuthContext } from "./lib/types.ts";
import { loadTenantServices, saveTenantService, matchTenantService, detectTenantService } from "./services/tenantServiceCatalog.ts";
import { createManualInquiry, getInquiry, listInquiries, updateInquiry } from "./services/inquiryService.ts";
import { analyzeRequestHeuristic, applyRefinedRequestAnalysis } from "./services/requestAnalysisService.ts";

describe("Tenant service catalogs", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let auth: AuthContext;
  let otherAuth: AuthContext;
  let serviceCode: string;
  let inquiryId: string;
  before(async () => {
    prisma = await createPrismaClient(); await seedDatabase();
    const owners = await prisma.membership.findMany({ where: { role: "owner" }, include: { tenant: true, user: true } });
    assert.ok(owners.length >= 2);
    const context = (member: typeof owners[number]) => ({ user: member.user, activeMembership: member, memberships: [member], sessionId: "test", client: "web" }) as AuthContext;
    auth = context(owners[0]); otherAuth = context(owners.find((member) => member.tenantId !== owners[0].tenantId)!);
  });
  it("starts with no universal services and imports only the tenant's historical categories", async () => {
    const tid = auth.activeMembership!.tenantId;
    assert.deepEqual(await loadTenantServices(prisma, tid), []);
    const contact = await prisma.contact.create({ data: { tenantId: tid, name: "Legacy" } });
    await prisma.inquiry.create({ data: { tenantId: tid, contactId: contact.id, source: "manual", serviceCategory: "presentation" } });
    const services = await loadTenantServices(prisma, tid);
    assert.equal(services.length, 1); assert.equal(services[0].name, "Презентации"); assert.equal(services[0].kind, "SERVICE");
    assert.deepEqual(await loadTenantServices(prisma, otherAuth.activeMembership!.tenantId), []);
  });
  it("allows admin configuration but rejects cross-tenant changes and manager configuration", async () => {
    const result = await saveTenantService(prisma, auth, { name: "Замена масла", aliases: ["поменять масло", "масло"], description: "Замена масла в двигателе" });
    serviceCode = result.item.code;
    await assert.rejects(saveTenantService(prisma, otherAuth, { name: "Чужая услуга" }, serviceCode), /Позиция не найдена/);
    const managerAuth = { ...auth, activeMembership: { ...auth.activeMembership!, role: "manager" } } as AuthContext;
    await assert.rejects(saveTenantService(prisma, managerAuth, { name: "Запрещено" }), /Недостаточно прав/);
    await assert.rejects(saveTenantService(prisma, auth, { name: " замена МАСЛА " }), /уже есть/);
  });
  it("assigns only own services, separates unclassified requests and resolves names after rename", async () => {
    const created = await createManualInquiry(prisma, auth, { name: "Свой клиент", serviceCategory: serviceCode });
    inquiryId = created.id;
    await assert.rejects(createManualInquiry(prisma, otherAuth, { name: "Другой клиент", serviceCategory: serviceCode }), /справочнике вашей компании/);
    await createManualInquiry(prisma, auth, { name: "Без услуги" });
    const selected = await listInquiries(prisma, auth, { serviceCategory: serviceCode, filter: "all" });
    assert.equal(selected.items.length, 1); assert.equal(selected.items[0].serviceLabel, "Замена масла");
    const unknown = await listInquiries(prisma, auth, { serviceCategory: "__undefined", filter: "all" });
    assert.ok(unknown.items.some((row) => row.serviceLabel === "Не определено"));
    await saveTenantService(prisma, auth, { name: "Замена моторного масла", aliases: ["поменять масло", "масло"] }, serviceCode);
    assert.equal((await getInquiry(prisma, auth, inquiryId)).serviceLabel, "Замена моторного масла");
  });
  it("archives without losing assignments or reimporting an active duplicate", async () => {
    await saveTenantService(prisma, auth, { name: "Замена моторного масла", active: false }, serviceCode);
    const services = await loadTenantServices(prisma, auth.activeMembership!.tenantId);
    assert.equal(services.filter((row) => row.code === serviceCode).length, 1);
    assert.equal(services.find((row) => row.code === serviceCode)?.active, false);
    await assert.rejects(createManualInquiry(prisma, auth, { name: "Новая заявка", serviceCategory: serviceCode }), /справочнике вашей компании/);
    await updateInquiry(prisma, auth, inquiryId, { subject: "Уточнение", serviceCategory: serviceCode });
    assert.equal((await getInquiry(prisma, auth, inquiryId)).serviceCategory, serviceCode);
    await updateInquiry(prisma, auth, inquiryId, { serviceCategory: null });
    assert.equal((await getInquiry(prisma, auth, inquiryId)).serviceLabel, "Не определено");
  });
  it("limits deterministic and LLM classification to active services and handles ambiguity", () => {
    const serviceCatalog = [{ code: "oil", name: "Замена масла", description: "", aliases: ["поменять масло"], active: true }];
    const input = { description: "Нужно поменять масло", serviceCatalog, senderCompany: "Автосервис" };
    const analysis = analyzeRequestHeuristic(input);
    assert.equal(analysis.serviceCategory, "oil");
    assert.match(analysis.clientMessageDraft, /Автосервис/); assert.doesNotMatch(analysis.clientMessageDraft, /CreoLab/);
    assert.equal(analyzeRequestHeuristic({ description: "Нужен сайт", serviceCatalog }).serviceCategory, null);
    assert.equal(analyzeRequestHeuristic({ description: "Нужна презентация", serviceCatalog: [] }).serviceCategory, null);
    assert.equal(applyRefinedRequestAnalysis(analysis, { serviceCategory: "foreign" }, input).serviceCategory, "oil");
    assert.equal(detectTenantService([...serviceCatalog, { ...serviceCatalog[0], code: "other" }], input.description), null);
    assert.equal(matchTenantService([{ ...serviceCatalog[0], active: false }], "oil"), null);
  });
  it("supports products alongside services and preserves their type when older clients edit or archive", async () => {
    const result = await saveTenantService(prisma, auth, { name: "Моторное масло 5W-30", kind: "PRODUCT", aliases: ["масло 5W-30"] });
    const code = result.item.code;
    assert.equal(result.item.kind, "PRODUCT");
    const catalog = await loadTenantServices(prisma, auth.activeMembership!.tenantId);
    assert.equal(catalog.find((row) => row.code === serviceCode)?.kind, "SERVICE");
    assert.equal(catalog.find((row) => row.code === code)?.kind, "PRODUCT");
    const inquiry = await createManualInquiry(prisma, auth, { name: "Покупатель", serviceCategory: code });
    const filtered = await listInquiries(prisma, auth, { serviceCategory: code, filter: "all" });
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0].id, inquiry.id);
    assert.equal(filtered.serviceOptions.find((row) => row.code === code)?.kind, "PRODUCT");
    await assert.rejects(createManualInquiry(prisma, otherAuth, { name: "Чужой покупатель", serviceCategory: code }), /справочнике вашей компании/);
    await assert.rejects(saveTenantService(prisma, auth, { name: "Недопустимый тип", kind: "UNKNOWN" }));
    const analysis = analyzeRequestHeuristic({ serviceCategory: code, serviceCatalog: catalog });
    assert.match(analysis.taskTitle, /товар «Моторное масло 5W-30»/);
    assert.ok(analysis.knownFields.some((field) => field.label === "Товар"));
    assert.equal(analyzeRequestHeuristic({ description: "Хочу купить масло 5W-30", serviceCatalog: catalog }).serviceCategory, code);
    const archived = await saveTenantService(prisma, auth, { name: result.item.name, active: false }, code);
    assert.equal(archived.item.kind, "PRODUCT");
    assert.equal((await getInquiry(prisma, auth, inquiry.id)).serviceCategory, code);
    const restored = await saveTenantService(prisma, auth, { name: result.item.name, active: true }, code);
    assert.equal(restored.item.kind, "PRODUCT");
    const converted = await saveTenantService(prisma, auth, { name: result.item.name, kind: "SERVICE" }, code);
    assert.equal(converted.item.kind, "SERVICE");
    assert.equal((await getInquiry(prisma, auth, inquiry.id)).serviceCategory, code);
  });
  it("does not ask website questions for a historical category reclassified as a product", () => {
    const analysis = analyzeRequestHeuristic({ serviceCategory: "web", serviceCatalog: [{ code: "web", name: "Готовый сайт", kind: "PRODUCT", description: "", aliases: [], active: true }] });
    assert.match(analysis.taskTitle, /товар/);
    assert.ok(!analysis.missingFields.some((field) => ["site_type", "site_goal", "functionality"].includes(field.key)));
  });
});
