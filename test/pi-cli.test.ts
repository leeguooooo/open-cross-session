import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piTargetName, type PiSessionRegistration } from "../src/pi-sessions.ts";
import { readRoutedMessages } from "../src/store.ts";

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
  delete env.PI_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  env.OCS_CLAUDE_NATIVE_SESSIONS_DIR = join(home, "no-claude");
  mkdirSync(env.OCS_CLAUDE_NATIVE_SESSIONS_DIR, { mode: 0o700 });
  env.OCS_UPGRADE_CHECK = "0";
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

  test("#64: a Pi without the running extension can send, and is told it cannot be woken", async () => {
    const f = await fixture();
    const unregistered = "cccccccc-dddd-4eee-8fff-000000000000";
    f.env.PI_SESSION_ID = unregistered;
    try {
      const whoami = await run(f, ["whoami"]);
      expect(whoami.code).toBe(0);
      expect(whoami.stdout.trim()).toBe(piTargetName(unregistered));
      expect(whoami.stderr).toContain("extension is not running in it");

      const json = await run(f, ["whoami", "--json"]);
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({ host: "pi", id: "pi-cccccccc" });
      expect(json.stderr).toContain("extension is not running in it");

      const dm = await run(f, ["dm", TARGET, "hello from an old Pi"]);
      expect(dm.code).toBe(0);
      expect(dm.stdout).toContain(`wake(pi): queued → ${TARGET}`);
      expect(dm.stderr.split("extension is not running in it").length - 1).toBe(1);

      const doctor = await run(f, ["doctor"]);
      expect(doctor.stdout + doctor.stderr).toContain(
        `this command runs in Pi session ${piTargetName(unregistered)}, but the ocs extension is not running in it`,
      );

      // The promise in the warning: a reply to this Pi parks where its own `ocs inbox` finds it.
      const reply = await run({ ...f, env: { ...f.env, PI_SESSION_ID: "" } }, [
        "dm", piTargetName(unregistered), "reply for the old Pi", "--as", "sender",
      ]);
      expect(reply.code).toBe(0);
      expect(reply.stdout + reply.stderr).toContain("NOT woken");
      const inbox = await run(f, ["inbox"]);
      expect(inbox.code).toBe(0);
      expect(inbox.stdout).toContain("1 unread · last from sender");
      const channel = /ocs read (\S+)/.exec(inbox.stdout)?.[1];
      expect(channel).toBeDefined();
      expect((await run(f, ["read", channel!])).stdout).toContain("reply for the old Pi");
    } finally {
      await f.close();
    }
  }, 60_000);

  test("#64: doctor does not diagnose an enclosing Pi for a Codex launched from it", async () => {
    const f = await fixture();
    f.env.PI_SESSION_ID = "cccccccc-dddd-4eee-8fff-000000000000";
    f.env.CODEX_THREAD_ID = "019a0000-0000-7000-8000-000000000001";
    try {
      const doctor = await run(f, ["doctor"]);
      expect(doctor.stdout + doctor.stderr).not.toContain("this command runs in Pi session");
    } finally {
      await f.close();
    }
  }, 60_000);

  test("#64: a registered Pi session gets no warning, and doctor says it is wakeable", async () => {
    const f = await fixture();
    f.env.PI_SESSION_ID = SESSION_ID;
    try {
      const whoami = await run(f, ["whoami"]);
      expect(whoami.stdout.trim()).toBe(TARGET);
      expect(whoami.stderr).toBe("");
      const doctor = await run(f, ["doctor"]);
      expect(doctor.stdout + doctor.stderr).toContain(`Pi session ${TARGET}, which is registered and wakeable`);
    } finally {
      await f.close();
    }
  }, 60_000);

  test("#67: ocs dm points at the peer's unread reply and leaves it unread in ocs inbox", async () => {
    const f = await fixture();
    try {
      const first = await run(f, ["dm", TARGET, "please wait for my go", "--as", "lead"]);
      expect(first.code).toBe(0);
      const channel = /channel (dm-[^,\s)]+)/.exec(first.stdout)?.[1];
      expect(channel).toBeDefined();
      const reply = await run(f, ["send", channel!, "correction: hold on", "--as", TARGET, "--reply-to", "1", "--no-wake"]);
      expect(reply.code).toBe(0);
      const second = await run(f, ["dm", TARGET, "go ahead", "--as", "lead"]);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("unread: 1 earlier message(s) for you in this channel you have not read (seq 2,");
      const inbox = await run(f, ["inbox", "--as", "lead"]);
      expect(inbox.stdout).toContain(channel!);
      expect((await run(f, ["read", channel!, "--as", "lead"])).stdout).toContain("correction: hold on");
      // once read, the next dm is clean
      expect((await run(f, ["dm", TARGET, "thanks", "--as", "lead"])).stdout).not.toContain("unread:");
    } finally {
      await f.close();
    }
  }, 60_000);

  test("#67 review: a DM send that @mentions someone else is not routed to the peer", async () => {
    const f = await fixture();
    try {
      const first = await run(f, ["dm", TARGET, "hi", "--as", "lead"]);
      const channel = /channel (dm-[^,\s)]+)/.exec(first.stdout)![1]!;
      expect((await run(f, ["send", channel, "reply", "--as", TARGET, "--reply-to", "1", "--no-wake"])).code).toBe(0);
      // plain send: routed to the Pi and wakes it
      const plain = await run(f, ["send", channel, "plain", "--as", "lead"]);
      expect(plain.stdout).toContain(`waking the peer ${TARGET}`);
      expect(readRoutedMessages(channel, { env: f.env }).at(-1)?.to_identity).toBe(`pi:${SESSION_ID}`);
      // @someone-else: not routed to the Pi
      await run(f, ["send", channel, "@someone-else fyi", "--as", "lead"]);
      const last = readRoutedMessages(channel, { env: f.env }).at(-1)!;
      expect(last.body).toBe("@someone-else fyi");
      expect(last.to_identity).toBeUndefined();
    } finally {
      await f.close();
    }
  }, 60_000);

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
