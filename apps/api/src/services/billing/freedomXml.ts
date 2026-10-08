import { createHash, timingSafeEqual } from "node:crypto";
import { billingError } from "./config.ts";
type Node = { name: string; text: string; children: Node[] };
function invalid(): never {
  return billingError(
    "provider_response",
    "Некорректный ответ платёжного сервиса",
    502,
  );
}
function decode(s: string) {
  return s.replace(/&([^;]*);/g, (_all, entity: string) => {
    const basic: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };
    if (basic[entity]) return basic[entity];
    const n = /^#x[0-9a-f]+$/i.test(entity)
      ? parseInt(entity.slice(2), 16)
      : /^#\d+$/.test(entity)
        ? Number(entity.slice(1))
        : 0;
    if (n < 32 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) invalid();
    return String.fromCodePoint(n);
  });
}
/** Bounded XML subset used by Merchant API: no DTD, entities, attributes or mixed content. */
export function parseFreedomResponse(xml: string) {
  if (xml.length > 100_000 || /<!/.test(xml)) invalid();
  xml = xml.replace(/^\s*<\?xml[^?]*\?>/, "").trim();
  const root: Node = { name: "document", text: "", children: [] },
    stack = [root];
  let cursor = 0,
    count = 0;
  const tokens = /<\/?[a-zA-Z_]\w*\s*\/?>|[^<]+/g;
  for (const match of xml.matchAll(tokens)) {
    if (match.index !== cursor || ++count > 2000) invalid();
    const token = match[0];
    cursor += token.length;
    if (!token.startsWith("<")) {
      stack.at(-1)!.text += token;
      continue;
    }
    if (token.startsWith("</")) {
      if (stack.length < 2 || stack.at(-1)!.name !== token.slice(2, -1).trim())
        invalid();
      stack.pop();
      continue;
    }
    if (stack.length > 8) invalid();
    const name = token.match(/^<(\w+)/)![1],
      parent = stack.at(-1)!;
    if (
      parent.children.some((n) => n.name === name) &&
      !["pg_refund_payment", "pg_revoked_payment"].includes(name)
    )
      invalid();
    const child: Node = { name, text: "", children: [] };
    parent.children.push(child);
    if (!token.endsWith("/>")) stack.push(child);
  }
  if (
    cursor !== xml.length ||
    stack.length !== 1 ||
    root.text.trim() ||
    root.children.length !== 1 ||
    !["response", "root"].includes(root.children[0].name)
  )
    invalid();
  const response = root.children[0];
  function normalize(node: Node) {
    if (node.children.length && node.text.trim()) invalid();
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(node.text))
      invalid();
    node.text = decode(node.text);
    node.children.forEach(normalize);
  }
  normalize(response);
  const fields: Record<string, string> = Object.fromEntries(
    response.children
      .filter((n) => !n.children.length)
      .map((n) => [n.name, n.text]),
  );
  // Freedom's signature preserves sibling position before lexicographic flattening.
  const flat: Record<string, string> = {};
  function flatten(nodes: Node[], prefix = "") {
    nodes.forEach((n, i) => {
      const key = `${prefix}${n.name}${String(i + 1).padStart(3, "0")}`;
      if (n.children.length) flatten(n.children, key);
      else flat[key] = n.text;
    });
  }
  flatten(response.children.filter((n) => n.name !== "pg_sig"));
  return {
    fields,
    verify(script: string, secret: string) {
      const actual = fields.pg_sig || "";
      const expected = createHash("md5")
        .update(
          [
            script,
            ...Object.keys(flat)
              .sort()
              .map((k) => flat[k]),
            secret,
          ].join(";"),
        )
        .digest("hex");
      return Boolean(
        secret &&
        /^[a-f\d]{32}$/i.test(actual) &&
        timingSafeEqual(
          Buffer.from(actual.toLowerCase()),
          Buffer.from(expected),
        ),
      );
    },
  };
}
export async function readProviderXml(res: Response) {
  if (!res.body) invalid();
  const reader = res.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 100_000) invalid();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}
