import { AWP_NS } from "./EsfAvrXml.ts";
import { child, childrenOf, parseXml, type XmlEl } from "../xml.ts";

export type AwpXsdIssue = { path: string; message: string };

type Field = {
  name: string;
  required?: boolean;
  type?: "string" | "decimal" | "int" | "enum";
  enum?: string[];
  children?: Field[];
};

const REGISTRATION_TYPES = ["ENTERPRISE", "ENTREPRENEUR", "INDIVIDUAL"];

const PARTICIPANT: Field[] = [
  { name: "additionalInfo" },
  { name: "address" },
  { name: "branchTin" },
  { name: "invitationEmail" },
  { name: "tin" },
];

const BANK: Field[] = [
  { name: "bank" },
  { name: "bik" },
  { name: "iik" },
  { name: "kbe", type: "int" },
];

const AWP_V1: Field[] = [
  { name: "date", required: true },
  { name: "number", required: true },
  { name: "performedDate", required: true },
  { name: "registrationNumber" },
  { name: "additionalInfo" },
  {
    name: "contract",
    required: true,
    children: [
      { name: "date" },
      { name: "isContract", required: true },
      { name: "number" },
      { name: "registrationNumber" },
    ],
  },
  {
    name: "recipients",
    children: [
      {
        name: "recipient",
        children: [
          ...PARTICIPANT,
          { name: "bankDetails", children: BANK },
          { name: "name", required: true },
          { name: "nonResident", required: true },
          { name: "registrationType", type: "enum", enum: REGISTRATION_TYPES },
        ],
      },
    ],
  },
  {
    name: "senders",
    children: [
      {
        name: "sender",
        children: [
          ...PARTICIPANT,
          { name: "bankDetails", children: BANK },
          { name: "certificateNum" },
          { name: "certificateSeries" },
          { name: "name", required: true },
        ],
      },
    ],
  },
  {
    name: "worksPerformed",
    children: [
      { name: "currencyCode", required: true },
      { name: "rate", type: "decimal" },
      { name: "total" },
      { name: "totalNdsAmount", required: true, type: "decimal" },
      { name: "totalSumWithTax", required: true, type: "decimal" },
      { name: "totalSumWithoutTax", required: true, type: "decimal" },
      { name: "totalTurnoverSize", required: true, type: "decimal" },
      {
        name: "works",
        children: [
          {
            name: "work",
            children: [
              { name: "additionalInfo" },
              { name: "measureUnitCode" },
              { name: "name", required: true },
              { name: "ndsAmount", type: "decimal" },
              { name: "ndsRate", required: true, type: "int" },
              { name: "quantity", type: "decimal" },
              { name: "sumWithTax", required: true, type: "decimal" },
              { name: "sumWithoutTax", required: true, type: "decimal" },
              { name: "turnoverSize", required: true, type: "decimal" },
              { name: "unitPriceWithoutTax", required: true, type: "decimal" },
            ],
          },
        ],
      },
    ],
  },
];

function typeOk(value: string, type: Field["type"], enums?: string[]) {
  if (!value) return true;
  if (type === "decimal") return /^-?\d+(\.\d+)?$/.test(value);
  if (type === "int") return /^-?\d+$/.test(value);
  if (type === "enum") return Boolean(enums?.includes(value));
  return true;
}

function walk(el: XmlEl, fields: Field[], path: string, issues: AwpXsdIssue[]) {
  const order = fields.map((field) => field.name);
  const allowed = new Set(order);
  for (const row of el.children) {
    if (!allowed.has(row.local)) {
      issues.push({ path: `${path}/${row.local}`, message: "element_not_in_awp_v1_xsd" });
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
      if (field.type && !typeOk(hit.text, field.type, field.enum)) {
        issues.push({ path: here, message: `invalid_${field.type}` });
      }
      if (field.children) walk(hit, field.children, here, issues);
    }
  }
}

export function validateAwpV1Xml(xml: string) {
  const issues: AwpXsdIssue[] = [];
  let root: XmlEl;
  try {
    root = parseXml(xml);
  } catch (error) {
    return {
      valid: false,
      issues: [{ path: "/", message: error instanceof Error ? error.message : "xml_parse" }],
    };
  }
  if (root.local !== "awp" || root.ns !== AWP_NS) {
    issues.push({ path: "/awp", message: "root_must_be_v1.awp:awp" });
  }
  if (!child(root, "date")?.text) issues.push({ path: "/awp/date", message: "required" });
  if (!child(root, "number")?.text) issues.push({ path: "/awp/number", message: "required" });
  if (!child(root, "performedDate")?.text) issues.push({ path: "/awp/performedDate", message: "required" });
  walk(root, AWP_V1, "/awp", issues);
  const unique = issues.filter(
    (row, index) => issues.findIndex((item) => item.path === row.path && item.message === row.message) === index,
  );
  return { valid: unique.length === 0, issues: unique };
}
