import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { AVR_SOURCE_KIND, type AvrSourceSnapshot } from "./services/avrMapper.ts";
import { mapAvrSnapshotToAwpXml } from "./integrations/esf/avr/EsfAvrAdapter.ts";
import { validateAwpV1Xml } from "./integrations/esf/avr/EsfAvrXsd.ts";
import { buildCreateSessionEnvelope, buildUploadAwpEnvelope, parseSessionId, parseAwpUploadResult } from "./integrations/esf/EsfSoap.ts";
import { mapInvoiceToEsfXml } from "./integrations/esf/invoice/EsfInvoiceAdapter.ts";
import { ESF_INVOICE_SOURCE_KIND } from "./services/esfInvoiceMapper.ts";
import { ESF_OFFICIAL, resolveEsfProvider } from "./integrations/esf/EsfConfig.ts";
import { mockUploadAwp, mockQueryAwpStatus, parseMockUpload, resetEsfMock } from "./integrations/esf/EsfMock.ts";

const snapshot: AvrSourceSnapshot = {
  kind: AVR_SOURCE_KIND,
  seller: {
    legalName: "ТОО CREOLAB",
    bin: "123456789013",
    iin: "",
    legalAddress: "г. Алматы, пр. Абая 1",
    directorName: "Иванов Иван",
    directorPosition: "Директор",
  },
  buyer: {
    name: "ТОО Buyer",
    legalName: "ТОО Buyer",
    bin: "222222222220",
    iin: "",
    legalAddress: "г. Астана, ул. Кабанбай 10",
    directorName: "",
    directorPosition: "",
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

const officialSoapUiSample = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "integrations/esf/schemas/One AwpV1.xml"),
  "utf8",
);

describe("ESF AVR XML / official AwpV1", () => {
  it("кладёт official XSD рядом с адаптером", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "integrations/esf/schemas");
    const xsd = readFileSync(path.join(dir, "AwpV1.xsd"), "utf8");
    assert.match(xsd, /targetNamespace="v1.awp"/);
    assert.match(xsd, /name="ndsRate"/);
    assert.match(xsd, /name="isContract"/);
    assert.doesNotMatch(xsd, /&gt;/);
  });

  it("собирает AwpV1 из внутреннего snapshot и проходит XSD", () => {
    const mapped = mapAvrSnapshotToAwpXml(snapshot, { number: "AVR-2026-0001" });
    assert.equal(mapped.validation.valid, true, JSON.stringify(mapped.validation.issues));
    assert.match(mapped.xml, /<v1:awp xmlns:v1="v1.awp"/);
    assert.match(mapped.xml, /<date>12\.09\.2026<\/date>/);
    assert.match(mapped.xml, /<isContract>true<\/isContract>/);
    assert.match(mapped.xml, /<number>DOG-2026-0001<\/number>/);
    assert.match(mapped.xml, /<tin>123456789013<\/tin>/);
    assert.match(mapped.xml, /<tin>222222222220<\/tin>/);
    assert.match(mapped.xml, /<ndsRate>12<\/ndsRate>/);
    assert.match(mapped.xml, /<totalSumWithTax>952000.00<\/totalSumWithTax>/);
    assert.doesNotMatch(mapped.xml, /<work>[\s\S]*<number>/);
  });

  it("принимает official SoapUI sample без недокументированного work/number", () => {
    const ok = validateAwpV1Xml(officialSoapUiSample);
    assert.equal(ok.valid, true, JSON.stringify(ok.issues));
    const withExtra = officialSoapUiSample.replace("<ndsRate>1</ndsRate>", "<ndsRate>1</ndsRate><number>1</number>");
    const bad = validateAwpV1Xml(withExtra);
    assert.equal(bad.valid, false);
    assert.ok(bad.issues.some((row) => row.message === "element_not_in_awp_v1_xsd"));
  });

  it("собирает official SOAP createSession и uploadAwp, не выдумывая операции", () => {
    const session = buildCreateSessionEnvelope({
      tin: "123456789013",
      x509Certificate: "CERT",
      sourceType: ESF_OFFICIAL.sourceTypeOther,
    });
    assert.match(session, /<esf:createSessionRequest>/);
    assert.match(session, /<sourceType>OTHER<\/sourceType>/);
    assert.doesNotMatch(session, /login/i);
    const upload = buildUploadAwpEnvelope({
      sessionId: "sid-1",
      awpBody: officialSoapUiSample,
      signature: "SIG",
      x509Certificate: "CERT",
    });
    assert.match(upload, /<v1:awpUploadRequest>/);
    assert.match(upload, /<version>AwpV1<\/version>/);
    assert.match(upload, /<signatureType>COMPANY<\/signatureType>/);
    assert.match(upload, /<awpBody><!\[CDATA\[/);
    const invoice = mapInvoiceToEsfXml({
      kind: ESF_INVOICE_SOURCE_KIND,
      invoiceType: "ORDINARY_INVOICE",
      outgoingNum: "20260001",
      operatorFullname: "Иванов Иван",
      seller: {
        legalName: "ТОО CREOLAB",
        bin: "123456789013",
        iin: "",
        legalAddress: "г. Алматы",
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
        legalAddress: "г. Астана",
        countryCode: "KZ",
      },
      deal: { id: "deal-1", title: "Сайт" },
      contract: { id: "c1", number: "DOG-1", date: "2026-09-12T00:00:00.000Z", status: "SIGNED" },
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
      totals: { amountWithoutVat: 850000, vatAmount: 102000, totalAmount: 952000, currency: "KZT" },
      documentDate: "2026-09-12T00:00:00.000Z",
    });
    assert.equal(invoice.version, "InvoiceV2");
    assert.equal(invoice.validation.valid, true, JSON.stringify(invoice.validation.issues));
  });

  it("читает sessionId и awpId из official response shape", () => {
    const sessionId = parseSessionId(
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><esf:createSessionResponse xmlns:esf="esf"><sessionId>abc-1</sessionId></esf:createSessionResponse></soap:Body></soap:Envelope>`,
    );
    assert.equal(sessionId, "abc-1");
    const uploaded = parseAwpUploadResult(
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><v1:awpUploadResponse xmlns:v1="v1.awp"><acceptedList><awpUploadResult><awpId>99</awpId><number>AVR-1</number></awpUploadResult></acceptedList><declinedList/></v1:awpUploadResponse></soap:Body></soap:Envelope>`,
    );
    assert.equal(uploaded.awpId, "99");
    assert.equal(uploaded.declined, false);
  });

  it("mock uploadAwp возвращает official acceptedList/awpId и не включается в production", () => {
    resetEsfMock();
    const mapped = mapAvrSnapshotToAwpXml(snapshot, { number: "AVR-2026-0001" });
    const uploaded = mockUploadAwp({ xml: mapped.xml, number: "AVR-2026-0001" });
    assert.equal(uploaded.ok, true);
    const parsed = parseMockUpload(uploaded.xml);
    assert.equal(parsed.awpId, uploaded.awpId);
    assert.equal(parsed.declined, false);
    const status = mockQueryAwpStatus(uploaded.awpId);
    assert.equal(status.ok, true);
    assert.equal(status.status, "NOT_VIEWED");
    assert.equal(resolveEsfProvider({ provider: "mock", nodeEnv: "test" }), "mock");
    assert.equal(resolveEsfProvider({ provider: "mock", nodeEnv: "production" }), "live");
  });
});
