import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inject.ts";
import { OCS_HOME_ENV, readReceipts, readMessages } from "../src/store.ts";
import { fakeClaudeInbox, type FakeInbox } from "./fake-claude";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

// 真 CLI + 真脱离终端的守护进程 + 真 TCP/UDP，两台「机器」= 两个 OCS_HOME + 两个会话目录。
// 两边的「当前会话」都登记成本测试进程（CLI 的祖先，自身识别命中），各自一个收帧 socket。
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const T = 60_000;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

interface Box {
  env: Record<string, string>;
  frames: string[];
  server: Server;
  inbox: FakeInbox;
}

function box(name: string, sessionName: string, sessionId: string, discoveryPort: number): Box {
  const dir = tempDir(`ocs-lancli-${name}-`);
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { mode: 0o700 });
  const sockPath = join(dir, "inbox.sock");
  // 会回执的假收件箱（默认 accept：一条回执都不回）。
  const inbox = fakeClaudeInbox(sockPath);
  const { frames, server } = inbox;
  writeFileSync(
    join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId, name: sessionName, cwd: "/work", status: "idle", messagingSocketPath: sockPath }),
    { mode: 0o600 },
  );
  const inherited = { ...process.env } as Record<string, string>;
  for (const key of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CODEX_THREAD_ID", "OCS_NAME", "OCS_PI_SESSION_ID"]) {
    delete inherited[key];
  }
  return {
    env: {
      ...inherited,
      [OCS_HOME_ENV]: join(dir, "home"),
      [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir,
      OCS_LANG: "en",
      OCS_UPGRADE_CHECK: "0",
      OCS_RECEIPT_CLI_WAIT_MS: "20000",
      OCS_RECEIPT_TERMINAL_WAIT_MS: "20000",
      OCS_LAN_DISCOVERY_PORT: String(discoveryPort),
      OCS_LAN_DISCOVERY_TARGETS: "127.0.0.1",
    },
    frames,
    server,
    inbox,
  };
}

async function run(b: Box, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { env: b.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

async function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const note = (frame: string) =>
  (JSON.parse(frame.trim().split("\n").at(-1)!) as { message: { content: string } }).message.content;

describe("ocs lan 端到端（两台机器）", () => {
  test("up → 发现配对 → dm 唤醒 → 复制 Reply 行回信 → 两边落同一 lan 频道 → down", async () => {
    const discovery = await freePort();
    const a = box("a", "worker-a", "aaaaaaaa-1111-2222-3333-444455556666", discovery);
    const b = box("b", "tester", "bbbbbbbb-1111-2222-3333-444455556666", discovery);
    const portA = await freePort();
    const portB = await freePort();
    try {
      // 在 Codex 会话里启动：守护进程不许继承会话身份，否则它把这个 task 当「自己」永不唤醒
      const upA = await run(
        { ...a, env: { ...a.env, CODEX_THREAD_ID: "019a0000-0000-7000-8000-000000000001", OCS_NAME: "leaky" } },
        ["lan", "up", "--port", String(portA), "--bind", "127.0.0.1", "--name", "alpha"],
      );
      expect(upA.stdout).toContain(`lan: daemon up as alpha on port ${portA}`);
      const daemonPid = (JSON.parse(readFileSync(join(a.env[OCS_HOME_ENV]!, "lan", "daemon.json"), "utf8")) as { pid: number }).pid;
      const daemonEnv = process.platform === "linux"
        ? readFileSync(`/proc/${daemonPid}/environ`, "utf8")
        : Bun.spawnSync(["ps", "-E", "-ww", "-o", "command=", "-p", String(daemonPid)]).stdout.toString();
      expect(daemonEnv).toContain("OCS_LAN_DISCOVERY_PORT="); // 确认真读到了环境
      expect(daemonEnv).not.toContain("CODEX_THREAD_ID=");
      expect(daemonEnv).not.toContain("OCS_NAME=");
      const upB = await run(b, ["lan", "up", "--port", String(portB), "--bind", "127.0.0.1", "--name", "bravo", "--no-discover"]);
      expect(upB.stdout).toContain("discovery off");

      // 发现：B 能看到 A（只有 A 应答发现）
      const scan = await run(b, ["lan", "scan", "--json"]);
      const found = JSON.parse(scan.stdout) as Array<{ name: string; port: number; paired_as: string | null }>;
      expect(found).toContainEqual(expect.objectContaining({ name: "alpha", port: portA, paired_as: null }));

      // A prints a copyable pairing text and waits; B runs the join line from it
      // (its --addr points at real NICs where nothing listens, so B falls back to
      // discovery). A has no TTY here, so it is approved with `ocs lan approve <code>`.
      const issuer = Bun.spawn([process.execPath, CLI, "lan", "pair", "--label", "bee"], { env: a.env, stdout: "pipe", stderr: "pipe" });
      const reader = issuer.stdout.getReader();
      let issued = "";
      const readUntil = async (re: RegExp): Promise<RegExpExecArray> => {
        for (;;) {
          const match = re.exec(issued);
          if (match !== null) return match;
          const { value, done } = await reader.read();
          if (done) throw new Error(`issuer exited: ${issued}`);
          issued += new TextDecoder().decode(value);
        }
      };
      const joinLine = (await readUntil(/ocs lan join ([a-z2-7]{20})( --addr \S+)?/))[1]!;
      expect(issued).toContain("copy from here");
      expect(issued).toContain("Trust: 8h left");
      const joiner = Bun.spawn([process.execPath, CLI, "lan", "join", joinLine], { env: b.env, stdout: "pipe", stderr: "pipe" });
      const sas = (await readUntil(/check code: (\d{3}) (\d{3})/)).slice(1, 3).join("");
      // stdout may split the check code and the following approval hint across chunks.
      await readUntil(new RegExp(`ocs lan approve ${sas}`));
      expect(issued).toContain(`ocs lan approve ${sas}`);
      // A wrong code approves nothing
      const wrong = await run(a, ["lan", "approve", sas === "000000" ? "111111" : "000000"]);
      expect(wrong.code).toBe(1);
      const approved = await run(a, ["lan", "approve", sas.slice(0, 3), sas.slice(3)]);
      expect(approved.code).toBe(0);
      const [joinOut] = await Promise.all([new Response(joiner.stdout).text(), joiner.exited]);
      expect(joiner.exitCode).toBe(0);
      expect(joinOut).toContain(`${sas.slice(0, 3)} ${sas.slice(3)}`); // B showed the same code
      expect(joinOut).toContain("paired with alpha");
      expect(joinOut).toMatch(/trust: 8h left/);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        issued += new TextDecoder().decode(value);
      }
      await issuer.exited;
      expect(issuer.exitCode).toBe(0);
      expect(issued).toContain("paired with bee (bravo)");
      const peersA = JSON.parse((await run(a, ["lan", "peers", "--json"])).stdout) as Array<{ label: string; expires_at?: string }>;
      const expiresA = Date.parse(peersA.find((p) => p.label === "bee")!.expires_at!);
      expect(Math.abs(expiresA - (Date.now() + 8 * 3600_000))).toBeLessThan(60_000);

      // B（tester 会话）→ A 的 worker-a
      const dm = await run(b, ["dm", "worker-a@alpha", "ping over the lan"]);
      expect(dm.code).toBe(0);
      expect(dm.stdout).toContain("dm stored on remote → claude-aaaaaaaa@alpha");
      // 守护进程走同一条带回执的唤醒：没有扣留/拒绝回执 → accepted，随应答回给发送方
      expect(dm.stdout).toContain("[alpha] wake: accepted by inbox → worker-a");
      expect(dm.stdout).not.toContain("(pid");
      const localCopy = /local copy #(lan-[0-9a-f]{32}) seq 1/.exec(dm.stdout);
      expect(localCopy).not.toBeNull();
      const wake = note(await waitFor(() => a.frames[0]));
      expect(wake).toContain('from-name="claude-bbbbbbbb@bee"');
      expect(wake).toContain("ping over the lan");
      const replyLine = /Reply: (ocs dm \S+) "<your reply>"/.exec(wake);
      expect(replyLine?.[1]).toBe("ocs dm claude-bbbbbbbb@bee");

      // A 照 Reply 行回信 → B 的 tester 会话被唤醒，落在 B 发信时的同一个频道
      const reply = await run(a, ["dm", "claude-bbbbbbbb@bee", "pong"]);
      expect(reply.code).toBe(0);
      const wakeB = note(await waitFor(() => b.frames[0]));
      expect(wakeB).toContain('from-name="claude-aaaaaaaa@alpha"');
      expect(wakeB).toContain(`#${localCopy![1]}`);
      const read = await run(b, ["read", localCopy![1]!, "--include-self"]);
      expect(read.stdout).toContain("ping over the lan");
      expect(read.stdout).toContain("<claude-aaaaaaaa.alpha> pong");

      // 远端花名册
      const who = await run(b, ["who", "--lan"]);
      expect(who.stdout).toContain("LAN alpha (alpha):");
      expect(who.stdout).toContain("claude-aaaaaaaa@alpha  claude  idle  worker-a");

      // Silent remote commit: JSON remote seq must describe A, never the optional local copy.
      const before = a.frames.length;
      const quiet = await run(b, ["dm", "worker-a@alpha", "quiet remote record", "--no-wake", "--json"]);
      expect(quiet.code).toBe(0);
      expect(quiet.stdout.trim().split("\n").length).toBe(1);
      const qr = JSON.parse(quiet.stdout);
      expect(qr).toMatchObject({ v: 1, command: "dm", remote: true, stored: true, wake: "skipped", exit: 0 });
      expect(readMessages(qr.channel, { env: a.env }).find((m) => m.seq === qr.seq)?.body).toBe("quiet remote record");
      expect(a.frames.length).toBe(before);
      const normal = await run(b, ["dm", "worker-a@alpha", "normal JSON task", "--json"]);
      expect(JSON.parse(normal.stdout)).toMatchObject({ remote: true, stored: true, wake: "accepted", exit: 0 });
      await waitFor(() => a.frames.length === before + 1 ? true : undefined);
      const remoteRoster = JSON.parse((await run(b, ["who", "--lan", "--json"])).stdout);
      const remoteEntry = remoteRoster.peers[0].entries.find((entry: { kind: string }) => entry.kind === "claude");
      expect(remoteEntry.capabilities).toMatchObject({ noWake: true, batch: true, deliveryReceipt: "none" });
      const receivedStats = JSON.parse((await run(a, ["stats", qr.channel, "--json"])).stdout);
      expect(receivedStats.outcomes.skipped).toBe(1);

      // A 的收件箱扣留（crossSessionInbound=hold）：第一阶段结果随应答回到 B，退出码 2；
      // 终态只记在 A 的频道日志里，不跨机回传，也不通知任何人。
      a.inbox.policy = "hold";
      const framesA = a.frames.length;
      const framesB = b.frames.length;
      const heldDm = await run(b, ["dm", "worker-a@alpha", "held over the lan", "--json"]);
      const heldJson = JSON.parse(heldDm.stdout);
      expect(heldJson).toMatchObject({ remote: true, stored: true, wake: "failed", exit: 2 });
      heldDm.stdout = heldJson.lines.join("\n");
      expect(heldDm.code).toBe(2);
      expect(heldDm.stdout).toContain("[alpha] wake: HELD, not delivered yet → worker-a");
      expect(heldDm.stdout).toContain("You will not be notified of the outcome");
      expect(heldDm.stdout).not.toContain("ocs will notify this session");
      // 远端（A）那份频道与 seq 在应答里；回执旁车帧记在那里
      const remote = /dm stored on remote → \S+ \(channel (lan-[0-9a-f]{32}), seq (\d+)\)/.exec(heldDm.stdout)!;
      const onA = () => (readReceipts(remote[1]!, { env: a.env }).get(Number(remote[2])) ?? []).map((r) => r.status);
      await waitFor(() => (onA().includes("held") ? true : undefined));
      await a.inbox.resolveHeld("expired");
      await waitFor(() => (onA().includes("expired") ? true : undefined));
      await new Promise((r) => setTimeout(r, 400));
      expect(a.frames.length).toBe(framesA + 1); // 只有那条唤醒；A 上没有可通知的发送方会话
      expect(b.frames.length).toBe(framesB); // 没有跨机终态通知
      a.inbox.policy = "accept";

      // 解除配对后 A 再也进不了 B
      expect((await run(b, ["lan", "unpair", "alpha"])).code).toBe(0);
      const refused = await run(a, ["dm", "claude-bbbbbbbb@bee", "still there?"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("no longer trusts this machine");
    } finally {
      await run(a, ["lan", "down"]);
      await run(b, ["lan", "down"]);
      a.server.close();
      b.server.close();
    }
  }, T);
});
