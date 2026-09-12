export type XmlEl = {
  local: string;
  ns: string;
  attrs: Record<string, string>;
  children: XmlEl[];
  text: string;
};

export function xmlEscape(value: string) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function el(name: string, value: string | number | null | undefined) {
  if (value == null || value === "") return "";
  return `<${name}>${xmlEscape(String(value))}</${name}>`;
}

export function mustEl(name: string, value: string | number | null | undefined) {
  return `<${name}>${xmlEscape(String(value ?? ""))}</${name}>`;
}

export function boolEl(name: string, value: boolean) {
  return `<${name}>${value ? "true" : "false"}</${name}>`;
}

export function wrap(name: string, inner: string) {
  if (!inner) return "";
  return `<${name}>${inner}</${name}>`;
}

export function formatEsfDate(value: string | Date | null | undefined) {
  if (!value) return "";
  const iso = value instanceof Date ? value.toISOString() : String(value);
  const day = iso.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return "";
  return `${match[3]}.${match[2]}.${match[1]}`;
}

export function formatEsfDecimal(value: number, scale = 2) {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(scale);
}

export function formatEsfInt(value: number) {
  return String(Math.round(Number.isFinite(value) ? value : 0));
}

function splitName(qName: string) {
  const idx = qName.indexOf(":");
  if (idx < 0) return { prefix: "", local: qName };
  return { prefix: qName.slice(0, idx), local: qName.slice(idx + 1) };
}

export function parseXml(xml: string): XmlEl {
  const input = xml.replace(/^\uFEFF/, "").replace(/^<\?xml[^?]*\?>\s*/, "");
  let i = 0;

  function skipWs() {
    while (i < input.length && /\s/.test(input[i]!)) i += 1;
  }

  function parseName() {
    const start = i;
    while (i < input.length && /[:A-Za-z0-9_.-]/.test(input[i]!)) i += 1;
    return input.slice(start, i);
  }

  function parseAttrs(nsMap: Record<string, string>) {
    const attrs: Record<string, string> = {};
    const next = { ...nsMap };
    while (true) {
      skipWs();
      if (input[i] === "/" || input[i] === ">") break;
      const name = parseName();
      skipWs();
      if (input[i] !== "=") throw new Error(`xml_attr: ${name}`);
      i += 1;
      skipWs();
      const q = input[i];
      if (q !== '"' && q !== "'") throw new Error("xml_attr_quote");
      i += 1;
      let value = "";
      while (i < input.length && input[i] !== q) {
        value += input[i];
        i += 1;
      }
      if (input[i] !== q) throw new Error("xml_attr_unclosed");
      i += 1;
      attrs[name] = value
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&amp;", "&");
      if (name === "xmlns") next[""] = attrs[name];
      else if (name.startsWith("xmlns:")) next[name.slice(6)] = attrs[name];
    }
    return { attrs, nsMap: next };
  }

  function parseNode(nsMap: Record<string, string>): XmlEl {
    skipWs();
    if (input[i] !== "<") throw new Error("xml_expected_tag");
    i += 1;
    if (input.startsWith("!--", i)) {
      const end = input.indexOf("-->", i);
      if (end < 0) throw new Error("xml_comment");
      i = end + 3;
      return parseNode(nsMap);
    }
    const qName = parseName();
    const { attrs, nsMap: childNs } = parseAttrs(nsMap);
    const { prefix, local } = splitName(qName);
    const ns = childNs[prefix] || (prefix ? "" : childNs[""] || "");
    if (input.startsWith("/>", i)) {
      i += 2;
      return { local, ns, attrs, children: [], text: "" };
    }
    if (input[i] !== ">") throw new Error(`xml_tag: ${qName}`);
    i += 1;
    const children: XmlEl[] = [];
    let text = "";
    while (i < input.length) {
      if (input.startsWith("<![CDATA[", i)) {
        i += 9;
        const end = input.indexOf("]]>", i);
        if (end < 0) throw new Error("xml_cdata");
        text += input.slice(i, end);
        i = end + 3;
        continue;
      }
      if (input.startsWith("</", i)) break;
      if (input[i] === "<") {
        children.push(parseNode(childNs));
        continue;
      }
      const next = input.indexOf("<", i);
      const chunk = next < 0 ? input.slice(i) : input.slice(i, next);
      text += chunk
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&amp;", "&");
      i = next < 0 ? input.length : next;
    }
    if (!input.startsWith(`</${qName}>`, i)) throw new Error(`xml_close: ${qName}`);
    i += qName.length + 3;
    return { local, ns, attrs, children, text: text.trim() };
  }

  return parseNode({});
}

export function child(el: XmlEl, local: string) {
  return el.children.find((row) => row.local === local);
}

export function childrenOf(el: XmlEl, local: string) {
  return el.children.filter((row) => row.local === local);
}

export function textOf(el: XmlEl | undefined) {
  return el?.text ?? "";
}

export function findDeep(el: XmlEl, local: string): XmlEl | undefined {
  if (el.local === local) return el;
  for (const row of el.children) {
    const hit = findDeep(row, local);
    if (hit) return hit;
  }
  return undefined;
}
