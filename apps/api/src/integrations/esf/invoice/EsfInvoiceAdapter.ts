import { ESF_INVOICE_SOURCE_KIND, type EsfInvoiceSourceSnapshot } from "../../../services/esfInvoiceMapper.ts";
import { buildInvoiceV2Xml, INVOICE_VERSION, wrapInvoiceContainer } from "./EsfInvoiceXml.ts";
import { validateInvoiceV2Xml } from "./EsfInvoiceXsd.ts";

export function isEsfInvoiceSource(value: unknown): value is EsfInvoiceSourceSnapshot {
  return Boolean(
    value && typeof value === "object" && (value as { kind?: string }).kind === ESF_INVOICE_SOURCE_KIND,
  );
}

export function mapInvoiceToEsfXml(source: EsfInvoiceSourceSnapshot) {
  const xml = buildInvoiceV2Xml(source);
  const validation = validateInvoiceV2Xml(xml);
  return {
    ok: validation.valid,
    xml,
    containerXml: wrapInvoiceContainer(xml),
    version: INVOICE_VERSION,
    validation,
  };
}
