import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const escape = value => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
export function ciFailureAnnotations(log, label = "Release acceptance failed") {
  const lines = log.split(/\r?\n/).filter(line => !line.startsWith("::error "));
  // Expected errors from passing negative tests can precede a real TAP failure.
  // Prefer the actual failing assertions and retain more than the first failure.
  const failures = lines.flatMap((line, index) => /^\s*not ok\b/.test(line) ? [index] : []);
  const starts = failures.length ? failures.slice(0, 8) : [Math.max(0, lines.findIndex(line => /Error:|error TS|ERROR:|\berror:|FAILURE:|\[!\]/.test(line)))];
  const annotations = starts.map(start => {
    const next = lines.findIndex((line, index) => index > start && /^\s*(?:(?:not ok|ok)\b|# Subtest:)/.test(line));
    const diagnosticEnd = lines.findIndex((line, index) => index > start && /^\s*\.\.\.\s*$/.test(line));
    const end = Math.min(next >= 0 ? next : lines.length, diagnosticEnd >= 0 ? diagnosticEnd + 1 : lines.length, start + 80);
    const message = lines.slice(start, end).join("\n").slice(0, 6000);
    return `::error title=${escape(label).replace(/,/g, "%2C").replace(/:/g, "%3A")}::${escape(message)}`;
  });
  const summary = lines.findIndex(line => line === "Failed files:");
  if (summary >= 0) annotations.push(`::error title=Failing test files::${escape(lines.slice(summary).join("\n").slice(0, 3000))}`);
  return annotations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (file && existsSync(file)) for (const annotation of ciFailureAnnotations(readFileSync(file, "utf8"))) console.log(annotation);
}
