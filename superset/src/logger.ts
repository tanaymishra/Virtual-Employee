import fs from "fs";
import path from "path";
import { config } from "./config";

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function log(event: string, data: Record<string, unknown> = {}) {
  const entry = { ts: new Date().toISOString(), event, ...data };
  const line = JSON.stringify(entry);
  console.log(line);
  try {
    ensureDir(config.logFile);
    fs.appendFileSync(config.logFile, line + "\n");
  } catch (err) {
    console.error("Failed to write audit log", err);
  }
}
