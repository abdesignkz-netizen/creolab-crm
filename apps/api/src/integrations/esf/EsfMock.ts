import { validateAwpV1Xml } from "./avr/EsfAvrXsd.ts";
import { validateInvoiceV2Xml } from "./invoice/EsfInvoiceXsd.ts";
import { parseAwpUploadResult, parseAwpStatus, parseSessionId, parseSyncInvoiceResult, parseInvoiceById } from "./EsfSoap.ts";

export const ESF_MOCK_SIGNATURE = "ESF_MOCK_SIGNATURE";
export const OFFICIAL_AWP_STATUSES = [
  "DRAFT",
  "NOT_VIEWED",
  "DELIVERED",
  "CREATED",
  "IMPORTED",
  "FAILED",
  "CONFIRMED",
  "DECLINED",
  "REVOKED",
  "IN_TERMINATING",
  "TERMINATED",
] as const;

export type OfficialAwpStatus = (typeof OFFICIAL_AWP_STATUSES)[number];

export const OFFICIAL_INVOICE_STATUSES = [
  "IN_QUEUE",
  "IN_PROCESSING",
  "CREATED",
  "DELIVERED",
  "CANCELED",
  "CANCELED_BY_OGD",
  "CANCELED_BY_SNT_DECLINE",
  "CANCELED_BY_SNT_REVOKE",
  "REVOKED",
  "IMPORTED",
  "DRAFT",
  "FAILED",
  "DELETED",
  "DECLINED",
  "SEND_TO_ISGO",
  "WAIT_BIOMETRICS_VERIFICATION",
  "FAILED_BIOMETRICS_VERIFICATION",
  "DELETED_BIOMETRICS_VERIFICATION",
  "WAITING_CUSTOMER_CONFIRMATION",
  "WAITING_CUSTOMER_REVOKE_CONFIRMATION",
] as const;

export type OfficialInvoiceStatus = (typeof OFFICIAL_INVOICE_STATUSES)[number];

type MockInvoice = {
  invoiceId: string;
  num: string;
  status: OfficialInvoiceStatus;
  registrationNumber: string;
  xml: string;
};

const invoices = new Map<string, MockInvoice>();
let nextInvoiceId = 2000;

type MockAwp = {
  awpId: string;
  number: string;
  status: OfficialAwpStatus;
  registrationNumber: string;
  xml: string;
};

const store = new Map<string, MockAwp>();
let nextId = 1000;

export function resetEsfMock() {
  store.clear();
  invoices.clear();
  nextId = 1000;
  nextInvoiceId = 2000;
}

export function mockCreateSessionXml() {
  const sessionId = `mock-session-${Date.now()}`;
  return {
    sessionId,
    xml: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><esf:createSessionResponse xmlns:esf="esf"><sessionId>${sessionId}</sessionId></esf:createSessionResponse></soap:Body></soap:Envelope>`,
  };
}

export function mockUploadAwp(input: { xml: string; number: string }) {
  const validation = validateAwpV1Xml(input.xml);
  if (!validation.valid) {
    const errors = validation.issues
      .map(
        (issue) =>
          `<error><property>${issue.path}</property><errorCode>CONTENT_HAS_INVALID_CHARACTERS</errorCode><text>${issue.message}</text></error>`,
      )
      .join("");
    return {
      ok: false as const,
      awpId: "",
      number: input.number,
      status: "" as const,
      xml: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><v1:awpUploadResponse xmlns:v1="v1.awp"><acceptedList/><declinedList><awpUploadResult><errorList>${errors}</errorList><number>${input.number}</number></awpUploadResult></declinedList></v1:awpUploadResponse></soap:Body></soap:Envelope>`,
    };
  }
  const awpId = String(nextId += 1);
  const row: MockAwp = {
    awpId,
    number: input.number,
    status: "NOT_VIEWED",
    registrationNumber: `KZ-MOCK-${awpId}`,
    xml: input.xml,
  };
  store.set(awpId, row);
  return {
    ok: true as const,
    awpId,
    number: row.number,
    status: row.status,
    registrationNumber: row.registrationNumber,
    xml: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><v1:awpUploadResponse xmlns:v1="v1.awp"><acceptedList><awpUploadResult><awpId>${awpId}</awpId><number>${row.number}</number></awpUploadResult></acceptedList><declinedList/></v1:awpUploadResponse></soap:Body></soap:Envelope>`,
  };
}

export function mockQueryAwpStatus(awpId: string) {
  const row = store.get(awpId);
  if (!row) {
    return {
      ok: false as const,
      status: "",
      registrationNumber: "",
      xml: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultstring>NOT_FOUND</faultstring></soap:Fault></soap:Body></soap:Envelope>`,
    };
  }
  return {
    ok: true as const,
    status: row.status,
    registrationNumber: row.registrationNumber,
    xml: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><v1:awpQueryStatusByIdResponse xmlns:v1="v1.awp"><awpSummaryList><awpSummary><awpId>${row.awpId}</awpId><inputDate>2026-09-12T00:00:00</inputDate><registrationNumber>${row.registrationNumber}</registrationNumber><version>AwpV1</version><status>${row.status}</status><lastUpdateDate>2026-09-12T00:00:00</lastUpdateDate></awpSummary></awpSummaryList></v1:awpQueryStatusByIdResponse></soap:Body></soap:Envelope>`,
  };
}

export function mockSetAwpStatus(awpId: string, status: OfficialAwpStatus) {
  const row = store.get(awpId);
  if (!row) return null;
  row.status = status;
  store.set(awpId, row);
  return row;
}

export function parseMockSessionId(xml: string) {
  return parseSessionId(xml);
}

export function parseMockUpload(xml: string) {
  return parseAwpUploadResult(xml);
}

export function parseMockStatus(xml: string) {
  return parseAwpStatus(xml);
}

export function mockSyncInvoice(input: { xml: string; num: string }) {
  const validation = validateInvoiceV2Xml(input.xml);
  if (!validation.valid) {
    const errors = validation.issues
      .map(
        (issue) =>
          `<error><property>${issue.path}</property><errorCode>CONTENT_HAS_INVALID_CHARACTERS</errorCode><text>${issue.message}</text></error>`,
      )
      .join("");
    return {
      ok: false as const,
      invoiceId: "",
      num: input.num,
      status: "" as const,
      xml: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><esf:syncInvoiceResponse xmlns:esf="esf"><acceptedSet/><declinedSet><standardResponse><errors>${errors}</errors><num>${input.num}</num><date>12.09.2026</date></standardResponse></declinedSet></esf:syncInvoiceResponse></soap:Body></soap:Envelope>`,
    };
  }
  const invoiceId = String((nextInvoiceId += 1));
  const row: MockInvoice = {
    invoiceId,
    num: input.num,
    status: "CREATED",
    registrationNumber: `KZ-ESF-MOCK-${invoiceId}`,
    xml: input.xml,
  };
  invoices.set(invoiceId, row);
  return {
    ok: true as const,
    invoiceId,
    num: row.num,
    status: row.status,
    registrationNumber: row.registrationNumber,
    xml: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><esf:syncInvoiceResponse xmlns:esf="esf"><acceptedSet><standardResponse><id>${invoiceId}</id><num>${row.num}</num><date>12.09.2026</date></standardResponse></acceptedSet><declinedSet/></esf:syncInvoiceResponse></soap:Body></soap:Envelope>`,
  };
}

export function mockQueryInvoiceById(invoiceId: string) {
  const row = invoices.get(invoiceId);
  if (!row) {
    return {
      ok: false as const,
      status: "",
      registrationNumber: "",
      xml: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultstring>NOT_FOUND</faultstring></soap:Fault></soap:Body></soap:Envelope>`,
    };
  }
  return {
    ok: true as const,
    status: row.status,
    registrationNumber: row.registrationNumber,
    xml: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><esf:queryInvoiceByIdResponse xmlns:esf="esf"><invoiceInfoList><invoiceInfo><invoiceId>${row.invoiceId}</invoiceId><registrationNumber>${row.registrationNumber}</registrationNumber><invoiceStatus>${row.status}</invoiceStatus><version>InvoiceV2</version></invoiceInfo></invoiceInfoList></esf:queryInvoiceByIdResponse></soap:Body></soap:Envelope>`,
  };
}

export function mockSetInvoiceStatus(invoiceId: string, status: OfficialInvoiceStatus) {
  const row = invoices.get(invoiceId);
  if (!row) return null;
  row.status = status;
  invoices.set(invoiceId, row);
  return row;
}

export function parseMockSyncInvoice(xml: string) {
  return parseSyncInvoiceResult(xml);
}

export function parseMockInvoiceById(xml: string) {
  return parseInvoiceById(xml);
}
