import { child, childrenOf, findDeep, parseXml, type XmlEl } from "../xml.ts";
import { INVOICE_V2_NS } from "./EsfInvoiceXml.ts";

export type InvoiceXsdIssue = { path: string; message: string };

type Field = {
  name: string;
  required?: boolean;
  type?: "string" | "decimal" | "int" | "enum" | "boolean" | "digits" | "origin";
  enum?: string[];
  children?: Field[];
};

const INVOICE_TYPES = ["ORDINARY_INVOICE", "FIXED_INVOICE", "ADDITIONAL_INVOICE"];

const CUSTOMER: Field[] = [
  { name: "address" },
  { name: "branchTin" },
  { name: "countryCode", required: true },
  { name: "name", required: true },
  { name: "reorganizedTin" },
  { name: "shareParticipation", type: "decimal" },
  { name: "statuses", children: [{ name: "status" }] },
  { name: "tin" },
  { name: "trailer" },
];

const SELLER: Field[] = [
  { name: "address" },
  { name: "bank" },
  { name: "bik" },
  { name: "branchTin" },
  { name: "certificateNum" },
  { name: "certificateSeries" },
  { name: "countryCode" },
  { name: "iik" },
  { name: "isBranchNonResident", type: "boolean" },
  { name: "kbe" },
  { name: "name", required: true },
  { name: "ndscaBank" },
  { name: "ndscaBik" },
  { name: "ndscaIik" },
  { name: "ndscaKbe" },
  { name: "reorganizedTin" },
  { name: "shareParticipation", type: "decimal" },
  { name: "statuses", children: [{ name: "status" }] },
  { name: "tin" },
  { name: "trailer" },
];

const PRODUCT: Field[] = [
  { name: "additional" },
  { name: "additionalUnitNomenclature" },
  { name: "catalogTruId", required: true },
  { name: "description" },
  { name: "exciseAmount", type: "decimal" },
  { name: "exciseRate", type: "decimal" },
  { name: "gtinCode" },
  { name: "kpvedCode" },
  { name: "ndsAmount", required: true, type: "decimal" },
  { name: "ndsRate", type: "int" },
  { name: "priceWithTax", required: true, type: "decimal" },
  { name: "priceWithoutTax", required: true, type: "decimal" },
  { name: "productDeclaration" },
  { name: "productNumberInDeclaration" },
  { name: "productNumberInSnt" },
  { name: "quantitativeQuantity", type: "decimal" },
  { name: "quantitativeUnitNomenclature" },
  { name: "quantity", type: "decimal" },
  { name: "tnvedName" },
  { name: "truOriginCode", required: true, type: "origin" },
  { name: "turnoverAdjustment", type: "int" },
  { name: "turnoverCode" },
  { name: "turnoverSize", required: true, type: "decimal" },
  { name: "unitCode" },
  { name: "unitNomenclature" },
  { name: "unitPrice", type: "decimal" },
];

const INVOICE_V2: Field[] = [
  { name: "date", required: true },
  { name: "invoiceType", required: true, type: "enum", enum: INVOICE_TYPES },
  { name: "num", required: true, type: "digits" },
  { name: "operatorFullname", required: true },
  {
    name: "relatedInvoice",
    children: [{ name: "date", required: true }, { name: "num", required: true, type: "digits" }, { name: "registrationNumber" }],
  },
  { name: "turnoverDate", required: true },
  { name: "addInf" },
  { name: "consignee", children: [{ name: "address" }, { name: "countryCode", required: true }, { name: "name" }, { name: "tin" }] },
  { name: "consignor", children: [{ name: "address" }, { name: "name" }, { name: "tin" }] },
  { name: "customerAgentAddress" },
  { name: "customerAgentDocDate" },
  { name: "customerAgentDocNum" },
  { name: "customerAgentName" },
  { name: "customerAgentTin" },
  { name: "customerParticipants", children: [{ name: "participant" }] },
  { name: "customers", required: true, children: [{ name: "customer", children: CUSTOMER }] },
  { name: "datePaper" },
  { name: "deliveryDocDate" },
  { name: "deliveryDocDate2" },
  { name: "deliveryDocNum" },
  { name: "deliveryDocNum2" },
  {
    name: "deliveryTerm",
    children: [
      { name: "accountNumber" },
      { name: "contractDate" },
      { name: "contractNum" },
      { name: "deliveryConditionCode" },
      { name: "destination" },
      { name: "hasContract", required: true, type: "boolean" },
      { name: "term" },
      { name: "transportTypeCode" },
      { name: "warrant" },
      { name: "warrantDate" },
    ],
  },
  {
    name: "productSet",
    required: true,
    children: [
      { name: "currencyCode", required: true },
      { name: "currencyRate", type: "decimal" },
      { name: "ndsRateType" },
      { name: "products", required: true, children: [{ name: "product", children: PRODUCT }] },
      { name: "totalExciseAmount", required: true, type: "decimal" },
      { name: "totalNdsAmount", required: true, type: "decimal" },
      { name: "totalPriceWithTax", required: true, type: "decimal" },
      { name: "totalPriceWithoutTax", required: true, type: "decimal" },
      { name: "totalTurnoverSize", required: true, type: "decimal" },
    ],
  },
  { name: "publicOffice" },
  { name: "reasonPaper" },
  { name: "sellerAgentAddress" },
  { name: "sellerAgentDocDate" },
  { name: "sellerAgentDocNum" },
  { name: "sellerAgentName" },
  { name: "sellerAgentTin" },
  { name: "sellerParticipants", children: [{ name: "participant" }] },
  { name: "sellers", required: true, children: [{ name: "seller", children: SELLER }] },
];

function typeOk(value: string, type: Field["type"], enums?: string[]) {
  if (!value) return true;
  if (type === "decimal") return /^-?\d+(\.\d+)?$/.test(value);
  if (type === "int") return /^-?\d+$/.test(value);
  if (type === "boolean") return value === "true" || value === "false";
  if (type === "digits") return /^[0-9]{1,30}$/.test(value);
  if (type === "origin") return /^[1-6]$/.test(value);
  if (type === "enum") return Boolean(enums?.includes(value));
  return true;
}

function walk(el: XmlEl, fields: Field[], path: string, issues: InvoiceXsdIssue[]) {
  const order = fields.map((field) => field.name);
  const allowed = new Set(order);
  for (const row of el.children) {
    if (!allowed.has(row.local)) {
      issues.push({ path: `${path}/${row.local}`, message: "element_not_in_invoice_v2_xsd" });
    }
  }
  let last = -1;
  for (const row of el.children) {
    const index = order.indexOf(row.local);
    if (index < 0) continue;
    if (index < last) issues.push({ path: `${path}/${row.local}`, message: "out_of_sequence" });
    last = index;
  }
  for (const field of fields) {
    const hits = childrenOf(el, field.name);
    if (!hits.length && field.required) {
      issues.push({ path: `${path}/${field.name}`, message: "required" });
      continue;
    }
    for (const [index, hit] of hits.entries()) {
      const here = hits.length > 1 ? `${path}/${field.name}[${index}]` : `${path}/${field.name}`;
      if (field.required && !hit.text && !field.children) {
        issues.push({ path: here, message: "required" });
      }
      if (field.type && !typeOk(hit.text, field.type, field.enum)) {
        issues.push({ path: here, message: `invalid_${field.type}` });
      }
      if (field.children) walk(hit, field.children, here, issues);
    }
  }
}

export function findInvoiceV2(xml: string) {
  const root = parseXml(xml);
  if (root.local === "invoice" && root.ns === INVOICE_V2_NS) return root;
  const nested = findDeep(root, "invoice");
  if (nested && (nested.ns === INVOICE_V2_NS || !nested.ns)) return nested;
  return root;
}

export function validateInvoiceV2Xml(xml: string) {
  const issues: InvoiceXsdIssue[] = [];
  let invoice: XmlEl;
  try {
    invoice = findInvoiceV2(xml);
  } catch (error) {
    return {
      valid: false,
      issues: [{ path: "/", message: error instanceof Error ? error.message : "xml_parse" }],
    };
  }
  if (invoice.local !== "invoice" || (invoice.ns && invoice.ns !== INVOICE_V2_NS)) {
    issues.push({ path: "/invoice", message: "root_must_be_v2.esf:invoice" });
  }
  if (!child(invoice, "date")?.text) issues.push({ path: "/invoice/date", message: "required" });
  if (!child(invoice, "num")?.text) issues.push({ path: "/invoice/num", message: "required" });
  walk(invoice, INVOICE_V2, "/invoice", issues);
  const unique = issues.filter(
    (row, index) => issues.findIndex((item) => item.path === row.path && item.message === row.message) === index,
  );
  return { valid: unique.length === 0, issues: unique };
}
