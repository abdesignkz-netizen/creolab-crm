import { existsSync, readFileSync } from "node:fs";
const file = process.argv[2];
if (file && existsSync(file)) {
  const lines = readFileSync(file, "utf8").split("\n");
  const index = lines.findIndex(line => /not ok|Error:|error TS|ERROR:/.test(line));
  const message = (index >= 0 ? lines.slice(index, index + 80).join("\n") : lines.slice(-50).join("\n")).slice(0, 6000);
  const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::error title=Release acceptance failed::${escaped}`);
}
