// This database records execution state, never OCS sequence numbers: channel logs own seq.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { agyDir, type AgyJobInput } from "./agy.ts";
import { readMessages } from "./store.ts";

export type AgyJobState = "queued" | "running" | "interrupted" | "completed" | "failed";
export interface AgyJob extends AgyJobInput { id: string; state: AgyJobState; response: string | null; }
interface JobRow { id: string; input: string; state: AgyJobState; response: string | null; }
export function agyPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function ensureAgyDirectory(env: NodeJS.ProcessEnv): string {
  const dir = agyDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("agy directory must be private and owned by this user");
  return dir;
}

export class AgyQueue {
  readonly database: Database;
  constructor(readonly env: NodeJS.ProcessEnv) {
    const path = join(ensureAgyDirectory(env), "jobs.sqlite3");
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("unsafe agy database");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.database = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, input TEXT NOT NULL, state TEXT NOT NULL,
        created REAL NOT NULL, response TEXT, reply_state TEXT NOT NULL DEFAULT 'pending', reply_code INTEGER);
      CREATE TABLE IF NOT EXISTS conversations (channel TEXT PRIMARY KEY, conversation TEXT NOT NULL);`);
  }
  claim(pid: number, token: string): void {
    this.database.transaction(() => {
      const owner = this.database.query<{ pid: number; token: string }, []>("SELECT pid,token FROM lease WHERE id=1").get();
      if (owner !== null && agyPidAlive(owner.pid)) throw new Error("agy worker already running");
      this.database.query("INSERT OR REPLACE INTO lease VALUES (1,?,?)").run(pid, token);
    }).immediate();
  }
  release(token: string): void { this.database.query("DELETE FROM lease WHERE token=?").run(token); }
  recover(interruptedMessage: string): void {
    this.database.transaction(() => {
      this.database.query("UPDATE jobs SET state='interrupted',response=?,reply_state='pending' WHERE state='running'").run(interruptedMessage);
      this.database.query("UPDATE jobs SET reply_state='unknown' WHERE reply_state='sending'").run();
    })();
  }
  submit(input: AgyJobInput): string {
    // Reject fabricated references, rather than executing a prompt with no committed OCS message.
    const parent = readMessages(input.channel, { since: input.seq - 1, env: this.env }).find((message) => message.seq === input.seq);
    if (parent === undefined || parent.from === "agy") throw new Error("message missing or self wake");
    const id = createHash("sha256").update(`${input.channel}\0${input.seq}`).digest("hex").slice(0, 24);
    this.database.query("INSERT OR IGNORE INTO jobs (id,input,state,created) VALUES (?,?,'queued',?)").run(id, JSON.stringify(input), Date.now());
    return id; // SQLite commit has completed; a repeated wake uses this same job.
  }
  next(): AgyJob | null {
    return this.database.transaction(() => {
      const row = this.database.query<JobRow, []>(`SELECT id,input,state,response FROM jobs WHERE state IN ('queued','interrupted')
        OR (state IN ('completed','failed') AND reply_state='pending') ORDER BY created,id LIMIT 1`).get();
      if (row === null) return null;
      if (row.state === "queued") this.database.query("UPDATE jobs SET state='running' WHERE id=?").run(row.id);
      return { ...(JSON.parse(row.input) as AgyJobInput), id: row.id, state: row.state, response: row.response };
    }).immediate();
  }
  complete(id: string, success: boolean, response: string): void {
    this.database.query("UPDATE jobs SET state=?,response=? WHERE id=?").run(success ? "completed" : "failed", response, id);
  }
  beginReply(id: string): boolean {
    return this.database.query("UPDATE jobs SET reply_state='sending' WHERE id=? AND reply_state='pending'").run(id).changes === 1;
  }
  finishReply(id: string, code: number): void {
    this.database.query("UPDATE jobs SET reply_state=?,reply_code=? WHERE id=?").run(code === 0 ? "accepted" : "unknown", code, id);
  }
  conversation(channel: string): string | null {
    return this.database.query<{ conversation: string }, [string]>("SELECT conversation FROM conversations WHERE channel=?").get(channel)?.conversation ?? null;
  }
  saveConversation(channel: string, id: string): void {
    this.database.query("INSERT OR REPLACE INTO conversations VALUES (?,?)").run(channel, id);
  }
  close(): void { this.database.close(); }
}
