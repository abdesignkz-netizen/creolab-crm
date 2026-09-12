import { AVR_SOURCE_KIND, type AvrSourceSnapshot } from "../../../services/avrMapper.ts";
import { buildAwpV1Xml, type AwpBuildExtras } from "./EsfAvrXml.ts";
import { validateAwpV1Xml } from "./EsfAvrXsd.ts";

export type { AwpBuildExtras };

export function isAvrSource(value: unknown): value is AvrSourceSnapshot {
  return Boolean(value && typeof value === "object" && (value as { kind?: string }).kind === AVR_SOURCE_KIND);
}

export function mapAvrSnapshotToAwpXml(source: AvrSourceSnapshot, extras: AwpBuildExtras = {}) {
  const xml = buildAwpV1Xml(source, extras);
  const validation = validateAwpV1Xml(xml);
  return { xml, version: "AwpV1" as const, validation };
}
