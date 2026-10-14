import { readFileSync, statSync } from "node:fs";
import { BODY_LIMIT } from "./store.ts";

/** Explicit batching only: retain every item, make one ordinary OCS message. */
export function batchBody(path: string): { body: string; items: number } {
  if (statSync(path).size > BODY_LIMIT) throw new Error("batch file exceeds message limit");
  const items: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(items) || items.length < 1 || items.length > 100 ||
      !items.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error("batch must be a JSON array of 1..100 non-empty task strings");
  }
  const body = `OCS batch: ${items.length} related tasks. Read and handle every item; report one combined result. If this is a preview, use the Thread command to read the full message before acting.\n` +
    items.map((item, index) => `\n[Task ${index + 1}]\n${item}`).join("\n");
  if (Buffer.byteLength(body) > BODY_LIMIT) throw new Error("batch exceeds message limit");
  return { body, items: items.length };
}
