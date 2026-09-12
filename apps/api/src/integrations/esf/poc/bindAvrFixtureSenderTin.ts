/**
 * Official AwpWebService.wsdl errorCode:
 * AWP_SENDER_TIN_NOT_EQUALS_WITH_TIN_IN_SESSION
 *
 * XSD leaves sender tin optional, but uploadAwp rejects a sender TIN
 * that does not equal createSession tin. Substitute only that value,
 * then freeze the string. Do not parse/serialize the rest of the XML.
 */

export const OFFICIAL_AWP_SENDER_TIN_SESSION_ERROR = "AWP_SENDER_TIN_NOT_EQUALS_WITH_TIN_IN_SESSION";
export const SOAPUI_AWP_SENDER_TIN = "123456789021";

export function senderTinFromAvrXml(xml: string) {
  const start = xml.indexOf("<senders>");
  const end = xml.indexOf("</senders>");
  if (start < 0 || end < start) return "";
  const match = xml.slice(start, end).match(/<tin>([^<]*)<\/tin>/);
  return match?.[1] || "";
}

export function bindAvrFixtureSenderTin(fixtureUtf8: string, sessionTin: string) {
  const tin = String(sessionTin || "").trim();
  if (!/^\d{12}$/.test(tin)) {
    throw new Error("session_tin_required");
  }
  const start = fixtureUtf8.indexOf("<senders>");
  const end = fixtureUtf8.indexOf("</senders>");
  if (start < 0 || end < start) {
    throw new Error("avr_senders_block_missing");
  }
  const block = fixtureUtf8.slice(start, end);
  const current = block.match(/<tin>([^<]*)<\/tin>/);
  if (!current) {
    throw new Error("avr_sender_tin_missing");
  }
  if (current[1] === tin) return fixtureUtf8;
  const nextBlock = `${block.slice(0, current.index)}${`<tin>${tin}</tin>`}${block.slice((current.index || 0) + current[0].length)}`;
  return `${fixtureUtf8.slice(0, start)}${nextBlock}${fixtureUtf8.slice(end)}`;
}
