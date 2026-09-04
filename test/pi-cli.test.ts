import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piTargetName, type PiSessionRegistration } from "../src/pi-sessions.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TARGET = piTargetName(SESSION_ID);

interface Fixture {
  env: Record<string, string>;
  frames: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), "ocs-pi-cli-"));
  const inbox = join(home, "pi-inbox");
  const sessions = join(home, "pi-sessions");
  mkdirSync(inbox, { recursive: true, mode: 0o700 });
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const socketPath = join(inbox, "pi-cli.sock");
  const token = "b".repeat(64);
  const frames: Array<Record<string, unknown>> = [];
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      frames.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      socket.end(`${JSON.stringify({ v: 1, ok: true, session_id: SESSION_ID, delivery: "queued" })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  const registration: PiSessionRegistration = {
    v: 1,
    extension_version: 1,
    harness: "pi",
    session_id: SESSION_ID,
    target: TARGET,
    name: "pi cli test",
    pid: process.pid,
    cwd: "/work/pi-cli",
    socket_path: socketPath,
    token,
    registered_at: new Date().toISOString(),
  };
  writeFileSync(join(sessions, `${SESSION_ID}.${process.pid}.json`), JSON.stringify(registration), { mode: 0o600 });
  const env = { ...process.env, OCS_HOME: home, OCS_LANG: "en" } as Record<string, string>;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete env.OCS_NAME;
  delete env.OCS_PI_SESSION_ID;
  return {
    env,
    frames,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function run(f: Fixture, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { env: f.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

describe("Pi CLI routing", () => {
  test("dm and @pi-<uuid> route to the registered Pi inbox", async () => {
    const f = await fixture();
    try {
      const dm = await run(f, ["dm", TARGET, "review this", "--as", "sender"]);
      expect(dm.code).toBe(0);
      expect(dm.stdout).toContain(`wake(pi): queued → ${TARGET}`);
      expect((f.frames[0]!.note as string)).toContain("review this");

      const mention = await run(f, ["send", "dev", `status @${TARGET}`, "--as", "sender"]);
      expect(mention.code).toBe(0);
      expect(mention.stdout).toContain(`wake(pi): queued → ${TARGET}`);
      expect((f.frames[1]!.note as string)).toContain(`status @${TARGET}`);
    } finally {
      await f.close();
    }
  }, 30_000);

  test("--reply-to wakes a Pi author without requiring another mention", async () => {
    const f = await fixture();
    try {
      expect((await run(f, ["send", "dev", "question", "--as", TARGET, "--no-wake"])).code).toBe(0);
      const reply = await run(f, ["send", "dev", "answer", "--as", "sender", "--reply-to", "1"]);
      expect(reply.code).toBe(0);
      expect(reply.stdout).toContain(`wake(pi): queued → ${TARGET}`);
      expect((f.frames[0]!.note as string)).toContain("reply to seq 1");
    } finally {
      await f.close();
    }
  }, 30_000);

  test("a Pi session cannot wake itself through an @ mention", async () => {
    const f = await fixture();
    f.env.OCS_PI_SESSION_ID = SESSION_ID;
    try {
      const result = await run(f, ["send", "dev", `loop @${TARGET}`]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`wake(pi): ${TARGET} is this Pi session; skipped`);
      expect(f.frames).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30_000);
});
