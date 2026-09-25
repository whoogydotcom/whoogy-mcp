import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function parseAndApplyEnv(filePath: string, overwrite: boolean) {
  if (!existsSync(filePath)) return;
  const contents = readFileSync(filePath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (!key) continue;
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (overwrite || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadEnvFile() {
  // Load .env first, then .env.local on top (local values win).
  // .env.local is for machine-specific overrides and should not be committed.
  parseAndApplyEnv(path.resolve(process.cwd(), ".env"), true);
  parseAndApplyEnv(path.resolve(process.cwd(), ".env.local"), true);
}
