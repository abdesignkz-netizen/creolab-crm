/** Pull the words the manager wants said to the client, e.g. «скажи что файл готов». */
export function extractSpokenMessage(rawText: string): string | null {
  const text = String(rawText || "").trim();
  if (!text) return null;
  const patterns = [
    /(?:скажи|скажите|сказать|напиши|напишите|написать|сообщи|сообщите|сообщить|переда|передай|передайте)\s+(?:клиенту\s+|им\s+|ему\s+|ей\s+)?что\s+(.+)/i,
    /(?:скажи|скажите|напиши|напишите|сообщи|переда)\s+(?:клиенту\s+|им\s+)?(.+)/i,
    /(?:отправь|отправьте|отправить)\s+(?:ему\s+|ей\s+|им\s+|клиенту\s+)?(?:сообщение|текст|смс)\s*[:\-–]?\s*(.+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      let body = m[1].trim().replace(/[.!?…]+$/u, "");
      body = body.replace(/\s+(пожалуйста|pls)$/i, "").trim();
      if (body.length < 2) continue;
      return body.charAt(0).toUpperCase() + body.slice(1) + (/[.!?]$/.test(body) ? "" : ".");
    }
  }
  return null;
}
