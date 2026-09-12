import { readEsfConfig } from "../EsfConfig.ts";
import { mockQueryAwpStatus, mockQueryInvoiceById } from "../EsfMock.ts";
import {
  buildQueryAwpStatusByIdEnvelope,
  buildQueryInvoiceByIdEnvelope,
  parseAwpStatus,
  parseInvoiceById,
  parseSoapFault,
  postSoap,
} from "../EsfSoap.ts";

export async function queryAwpStatusById(sessionId: string, awpId: string, config = readEsfConfig()) {
  if (config.provider === "mock") {
    const mocked = mockQueryAwpStatus(awpId);
    return {
      ok: mocked.ok,
      message: mocked.ok ? "" : "NOT_FOUND",
      status: mocked.status,
      registrationNumber: mocked.registrationNumber,
      awpId,
    };
  }
  const envelope = buildQueryAwpStatusByIdEnvelope(sessionId, awpId);
  const response = await postSoap(config.awpUrl, envelope);
  const fault = parseSoapFault(response.text);
  if (fault) {
    return { ok: false as const, message: fault.description || fault.faultstring, status: "", registrationNumber: "" };
  }
  const parsed = parseAwpStatus(response.text);
  return {
    ok: true as const,
    message: "",
    status: parsed.status,
    registrationNumber: parsed.registrationNumber,
    awpId: parsed.awpId || awpId,
  };
}

export async function queryInvoiceById(sessionId: string, invoiceId: string, config = readEsfConfig()) {
  if (config.provider === "mock") {
    const mocked = mockQueryInvoiceById(invoiceId);
    return {
      ok: mocked.ok,
      message: mocked.ok ? "" : "NOT_FOUND",
      status: mocked.status,
      registrationNumber: mocked.registrationNumber,
      invoiceId,
    };
  }
  const envelope = buildQueryInvoiceByIdEnvelope(sessionId, invoiceId);
  const response = await postSoap(config.invoiceUrl, envelope);
  const fault = parseSoapFault(response.text);
  if (fault) {
    return { ok: false as const, message: fault.description || fault.faultstring, status: "", registrationNumber: "" };
  }
  const parsed = parseInvoiceById(response.text);
  return {
    ok: true as const,
    message: "",
    status: parsed.status,
    registrationNumber: parsed.registrationNumber,
    invoiceId: parsed.invoiceId || invoiceId,
  };
}
