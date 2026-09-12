import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { mapInvoiceToEsfXml } from "./integrations/esf/invoice/EsfInvoiceAdapter.ts";
import { validateInvoiceV2Xml } from "./integrations/esf/invoice/EsfInvoiceXsd.ts";
import { INVOICE_VERSION } from "./integrations/esf/invoice/EsfInvoiceXml.ts";
import {
  buildCreateSessionEnvelope,
  buildSyncInvoiceEnvelope,
  parseSyncInvoiceResult,
  parseInvoiceById,
} from "./integrations/esf/EsfSoap.ts";
import { ESF_OFFICIAL, resolveEsfProvider } from "./integrations/esf/EsfConfig.ts";
import {
  mockSyncInvoice,
  mockQueryInvoiceById,
  parseMockSyncInvoice,
  resetEsfMock,
} from "./integrations/esf/EsfMock.ts";
import { ESF_INVOICE_SOURCE_KIND, type EsfInvoiceSourceSnapshot } from "./services/esfInvoiceMapper.ts";

const snapshot: EsfInvoiceSourceSnapshot = {
  kind: ESF_INVOICE_SOURCE_KIND,
  invoiceType: "ORDINARY_INVOICE",
  outgoingNum: "20260001",
  operatorFullname: "Иванов Иван",
  seller: {
    legalName: "ТОО CREOLAB",
    bin: "123456789013",
    iin: "",
    legalAddress: "г. Алматы, пр. Абая 1",
    directorName: "Иванов Иван",
    countryCode: "KZ",
    bank: "Kaspi",
    bik: "CASPKZKA",
    iik: "KZ123456789012345678",
    certificateNum: "",
  },
  buyer: {
    name: "ТОО Buyer",
    legalName: "ТОО Buyer",
    bin: "222222222220",
    iin: "",
    legalAddress: "г. Астана, ул. Кабанбай 10",
    countryCode: "KZ",
  },
  deal: { id: "deal-1", title: "Сайт" },
  contract: {
    id: "contract-1",
    number: "DOG-2026-0001",
    date: "2026-09-12T00:00:00.000Z",
    status: "SIGNED",
  },
  invoice: null,
  items: [
    {
      dealItemId: "item-1",
      name: "Разработка сайта",
      description: null,
      quantity: 1,
      unit: "услуга",
      unitPrice: 850000,
      amountWithoutVat: 850000,
      vatRate: 12,
      vatAmount: 102000,
      totalAmount: 952000,
      sortOrder: 0,
      catalogTruId: "1",
      truOriginCode: "6",
    },
  ],
  totals: {
    amountWithoutVat: 850000,
    vatAmount: 102000,
    totalAmount: 952000,
    currency: "KZT",
  },
  documentDate: "2026-09-12T00:00:00.000Z",
};

describe("ESF InvoiceV2 / official syncInvoice", () => {
  it("кладёт official Invoice XSD рядом с адаптером", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "integrations/esf/schemas");
    const xsd = readFileSync(path.join(dir, "InvoiceV2.xsd"), "utf8");
    const abstractXsd = readFileSync(path.join(dir, "abstractInvoice.xsd"), "utf8");
    assert.match(xsd, /targetNamespace="v2.esf"/);
    assert.match(xsd, /name="catalogTruId"/);
    assert.match(xsd, /name="truOriginCode"/);
    assert.match(abstractXsd, /name="InvoiceType"/);
  });

  it("собирает InvoiceV2 из snapshot и проходит XSD", () => {
    const mapped = mapInvoiceToEsfXml(snapshot);
    assert.equal(mapped.version, INVOICE_VERSION);
    assert.equal(mapped.validation.valid, true, JSON.stringify(mapped.validation.issues));
    assert.match(mapped.xml, /<v2:invoice xmlns:a="abstractInvoice.esf" xmlns:v2="v2.esf">/);
    assert.match(mapped.xml, /<date>12\.09\.2026<\/date>/);
    assert.match(mapped.xml, /<invoiceType>ORDINARY_INVOICE<\/invoiceType>/);
    assert.match(mapped.xml, /<num>20260001<\/num>/);
    assert.match(mapped.xml, /<catalogTruId>1<\/catalogTruId>/);
    assert.match(mapped.xml, /<truOriginCode>6<\/truOriginCode>/);
    assert.match(mapped.xml, /<hasContract>true<\/hasContract>/);
    assert.match(mapped.xml, /<countryCode>KZ<\/countryCode>/);
    assert.match(mapped.xml, /<iik>KZ123456789012345678<\/iik>/);
    assert.match(mapped.containerXml, /<esf:invoiceContainer xmlns:esf="esf">/);
    assert.doesNotMatch(mapped.xml, /<unitCode>/);
  });

  it("принимает official SDK sample One InvoiceV2.xml", () => {
    const sample = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "integrations/esf/schemas/One InvoiceV2.xml"),
      "utf8",
    );
    const ok = validateInvoiceV2Xml(sample);
    assert.equal(ok.valid, true, JSON.stringify(ok.issues));
  });

  it("не принимает неизвестный элемент внутри invoice", () => {
    const mapped = mapInvoiceToEsfXml(snapshot);
    const bad = validateInvoiceV2Xml(mapped.xml.replace("<turnoverDate>", "<madeUp>1</madeUp><turnoverDate>"));
    assert.equal(bad.valid, false);
    assert.ok(bad.issues.some((row) => row.message === "element_not_in_invoice_v2_xsd"));
  });

  it("собирает official SOAP syncInvoice и queryInvoiceById", () => {
    const session = buildCreateSessionEnvelope({
      tin: "123456789013",
      x509Certificate: "CERT",
      sourceType: ESF_OFFICIAL.sourceTypeOther,
    });
    assert.match(session, /<esf:createSessionRequest>/);
    const mapped = mapInvoiceToEsfXml(snapshot);
    const sync = buildSyncInvoiceEnvelope({
      sessionId: "sid-1",
      invoiceBody: mapped.xml,
      signature: "SIG",
      x509Certificate: "CERT",
    });
    assert.match(sync, /<esf:syncInvoiceRequest>/);
    assert.match(sync, /<version>InvoiceV2<\/version>/);
    assert.match(sync, /<signatureType>COMPANY<\/signatureType>/);
    assert.match(sync, /<invoiceBody><!\[CDATA\[/);
    assert.doesNotMatch(sync, /uploadAwp/);
  });

  it("читает invoiceId и invoiceStatus из official response shape", () => {
    const uploaded = parseSyncInvoiceResult(
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><esf:syncInvoiceResponse xmlns:esf="esf"><acceptedSet><standardResponse><id>77</id><num>20260001</num><date>12.09.2026</date></standardResponse></acceptedSet><declinedSet/></esf:syncInvoiceResponse></soap:Body></soap:Envelope>`,
    );
    assert.equal(uploaded.invoiceId, "77");
    assert.equal(uploaded.declined, false);
    const status = parseInvoiceById(
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><esf:queryInvoiceByIdResponse xmlns:esf="esf"><invoiceInfoList><invoiceInfo><invoiceId>77</invoiceId><invoiceStatus>CREATED</invoiceStatus><registrationNumber>KZ-1</registrationNumber></invoiceInfo></invoiceInfoList></esf:queryInvoiceByIdResponse></soap:Body></soap:Envelope>`,
    );
    assert.equal(status.invoiceId, "77");
    assert.equal(status.status, "CREATED");
  });

  it("mock syncInvoice возвращает official acceptedSet/id и не включается в production", () => {
    resetEsfMock();
    const mapped = mapInvoiceToEsfXml(snapshot);
    const uploaded = mockSyncInvoice({ xml: mapped.xml, num: "20260001" });
    assert.equal(uploaded.ok, true);
    const parsed = parseMockSyncInvoice(uploaded.xml);
    assert.equal(parsed.invoiceId, uploaded.invoiceId);
    const status = mockQueryInvoiceById(uploaded.invoiceId);
    assert.equal(status.ok, true);
    assert.equal(status.status, "CREATED");
    assert.equal(resolveEsfProvider({ provider: "mock", nodeEnv: "test" }), "mock");
    assert.equal(resolveEsfProvider({ provider: "mock", nodeEnv: "production" }), "live");
  });
});
