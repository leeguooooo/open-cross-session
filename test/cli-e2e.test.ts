import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inject.ts";
import { IDLE_POLL_MS_ENV } from "../src/idle.ts";
import { OCS_HOME_ENV } from "../src/store.ts";

// 真 CLI 进程 + 真 UDS + 真脱离终端的 watcher。
// 订阅方/发送方会话 = 本测试进程（CLI 的祖先，findSelfClaudePid 命中，名 tester）；
// 对端会话 = 一个 sleep 子进程（活 pid，名 worker-a），两者共用一个收帧 socket。
let peer: ReturnType<typeof Bun.spawn>;
beforeAll(() => {
  peer = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
});
afterAll(() => {
  peer.kill();
});

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

interface Fixture {
  env: Record<string, string>;
  home: string;
  server: Server;
  frames: string[];
  nextFrame: () => Promise<string>;
  setPeer: (status: "busy" | "idle") => void;
  writeSelf: boolean;
}

function fixture(options: { withSelf?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "ocs-e2e-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { mode: 0o700 });
  const sockPath = join(dir, "inbox.sock");
  const frames: string[] = [];
  const waiters: Array<(f: string) => void> = [];
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    socket.on("end", () => {
      if (buf === "") return;
      frames.push(buf);
      waiters.shift()?.(buf);
    });
  });
  server.listen(sockPath);
  const withSelf = options.withSelf ?? true;
  if (withSelf) {
    writeFileSync(
      join(sessionsDir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "self-sess", name: "tester", status: "busy", messagingSocketPath: sockPath }),
      { mode: 0o600 },
    );
  }
  const setPeer = (status: "busy" | "idle") =>
    writeFileSync(
      join(sessionsDir, `${peer.pid}.json`),
      JSON.stringify({ pid: peer.pid, sessionId: "peer-sess", name: "worker-a", status, messagingSocketPath: sockPath }),
      { mode: 0o600 },
    );
  setPeer("busy");
  const home = join(dir, "home");
  return {
    env: {
      ...process.env as Record<string, string>,
      [OCS_HOME_ENV]: home,
      [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir,
      [IDLE_POLL_MS_ENV]: "20",
      OCS_LANG: "en",
    },
    home,
    server,
    frames,
    nextFrame: () =>
      new Promise<string>((resolve, reject) => {
        waiters.push(resolve);
        setTimeout(() => reject(new Error("no frame within 4s")), 4000);
      }),
    setPeer,
    writeSelf: withSelf,
  };
}

function run(f: Fixture, args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", CLI, ...args], { env: f.env });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const content = (frame: string) =>
  (JSON.parse(frame.trim()) as { message: { content: string } }).message.content;

describe("read 不回显自己（#3）", () => {
  test("默认折叠成一行；--include-self 完整显示；--json 带 self", () => {
    const f = fixture();
    try {
      const mine = "hello there this is a fairly long message from me that goes past sixty characters";
      expect(run(f, ["send", "chat", mine, "--as", "me", "--no-wake"]).code).toBe(0);
      expect(run(f, ["send", "chat", "short reply", "--as", "peer", "--no-wake"]).code).toBe(0);

      const folded = run(f, ["read", "chat", "--as", "me"]);
      expect(folded.code).toBe(0);
      const lines = folded.stdout.trimEnd().split("\n");
      expect(lines.length).toBe(2);
      expect(lines[0]).toBe(`#1 <you> ${[...mine].slice(0, 60).join("")}…`);
      expect(lines[1]).toMatch(/^#2 \S+ <peer> short reply$/);

      const full = run(f, ["read", "chat", "--as", "me", "--include-self", "--since", "0"]);
      expect(full.stdout).toMatch(new RegExp(`^#1 \\S+ <me> ${mine}\\n`));
      expect(full.stdout).not.toContain("<you>");

      const json = run(f, ["read", "chat", "--as", "me", "--json", "--since", "0"]);
      const records = JSON.parse(json.stdout) as Array<{ seq: number; from: string; body: string; self: boolean }>;
      expect(records.map((r) => [r.seq, r.self])).toEqual([[1, true], [2, false]]);
      expect(records[0]!.body).toBe(mine); // --json 不折叠
      // peer 视角：同一条消息 self=false，且不折叠
      const peerView = run(f, ["read", "chat", "--as", "peer", "--since", "0"]);
      expect(peerView.stdout).toContain(`<me> ${mine}`);
      expect(peerView.stdout).toContain("#2 <you> short reply");
    } finally {
      f.server.close();
    }
  });
});

describe("唤醒目标排除发送者本人（#3）", () => {
  test("按名字：--as worker-a 的正文里 @worker-a 不唤醒 worker-a（活会话、真 socket）", async () => {
    const f = fixture();
    try {
      const r = run(f, ["send", "chat", "reply and @worker-a me back", "--as", "worker-a"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("you mentioned yourself; skipped");
      expect(r.stdout).not.toContain("delivered");
      await sleep(200);
      expect(f.frames.length).toBe(0);
    } finally {
      f.server.close();
    }
  });

  test("按 pid：祖先链上的本会话（tester）被 @ 也不回环", async () => {
    const f = fixture();
    try {
      const r = run(f, ["send", "chat", "ping @tester", "--as", "someone-else"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("you mentioned yourself; skipped");
      await sleep(200);
      expect(f.frames.length).toBe(0);
    } finally {
      f.server.close();
    }
  });

  test("对照：@ 别人正常唤醒，帧里带正文与 Reply: 行", async () => {
    const f = fixture();
    try {
      const r = run(f, ["send", "chat", "please look @worker-a", "--as", "tester"]);
      expect(r.stdout).toContain("wake: delivered to inbox → worker-a");
      const c = content(await f.nextFrame());
      expect(c).toContain("[ocs wake] tester mentioned you in #chat (seq 1)\n\nplease look @worker-a\n\n");
      expect(c).toContain('Reply: ocs send chat "<your reply>" --as worker-a --reply-to 1\n');
    } finally {
      f.server.close();
    }
  });
});

describe("--reply-to 唤醒被回复者（Reply: 行复制即达）", () => {
  test("不带 @ 也唤醒 seq 作者；note 首行带 reply to seq", async () => {
    const f = fixture();
    try {
      expect(run(f, ["send", "chat", "question", "--as", "worker-a", "--no-wake"]).code).toBe(0);
      const r = run(f, ["send", "chat", "<your reply>", "--as", "tester", "--reply-to", "1"]);
      expect(r.stdout).toContain("wake: delivered to inbox → worker-a");
      const c = content(await f.nextFrame());
      expect(c).toContain("[ocs wake] tester mentioned you in #chat (seq 2, reply to seq 1)\n\n<your reply>\n\n");
      expect(c).toContain('Reply: ocs send chat "<your reply>" --as worker-a --reply-to 2\n');
    } finally {
      f.server.close();
    }
  });
});

describe("notify-when-idle（#5）端到端：真脱离终端的 watcher", () => {
  test("订阅→去重→对端翻 idle→恰好一条通知投到订阅方；watcher 退出", async () => {
    const f = fixture();
    try {
      const r1 = run(f, ["notify-when-idle", "worker-a"]);
      expect(r1.code).toBe(0);
      expect(r1.stdout).toContain("notify-when-idle: subscribed → worker-a");
      const subsDir = join(f.home, "idle-subs");
      const files = () => readdirSync(subsDir).filter((n) => n.endsWith(".json"));
      expect(files().length).toBe(1);

      const r2 = run(f, ["notify-when-idle", "worker-a"]);
      expect(r2.stdout).toContain("notify-when-idle: already subscribed → worker-a");
      expect(files().length).toBe(1);

      const who = run(f, ["who"]);
      expect(who.stdout).toContain("Pending idle notifications");
      expect(who.stdout).toContain("worker-a → notify tester when idle");

      await sleep(150);
      expect(f.frames.length).toBe(0);
      f.setPeer("idle");
      const c = content(await f.nextFrame());
      expect(c).toBe(
        '<cross-session-message from-name="ocs" from-mode="prompting">\n' +
          "[Cross-session idle notice] worker-a is now idle. (busy for 0s)\n" +
          "</cross-session-message>",
      );
      await sleep(300);
      expect(f.frames.length).toBe(1);
      const record = JSON.parse(readFileSync(join(subsDir, files()[0]!), "utf8")) as { state: string; watcherPid: number };
      expect(record.state).toBe("fired");
      expect(() => process.kill(record.watcherPid, 0)).toThrow(); // watcher 已退出
      expect(run(f, ["who"]).stdout).not.toContain("Pending idle notifications");
    } finally {
      f.server.close();
    }
  });

  test("send --notify-when-idle：先发消息+唤醒，再订阅；对端已 idle 时立即通知", async () => {
    const f = fixture();
    try {
      f.setPeer("idle");
      const r = run(f, ["send", "chat", "do it @worker-a", "--as", "tester", "--notify-when-idle"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("sent #chat seq 1");
      expect(r.stdout).toContain("wake: delivered to inbox → worker-a");
      expect(r.stdout).toContain("notify-when-idle: subscribed → worker-a");
      expect(r.stdout).toContain("already idle");
      const first = content(await f.nextFrame());
      expect(first).toContain("[ocs wake] tester mentioned you in #chat (seq 1)");
      const second = content(await f.nextFrame());
      expect(second).toContain("[Cross-session idle notice] worker-a is now idle.");
      await sleep(200);
      expect(f.frames.length).toBe(2);
    } finally {
      f.server.close();
    }
  });

  test("不在 Claude 会话里：明确拒绝，且 send 不发出消息", () => {
    const f = fixture({ withSelf: false });
    try {
      const r = run(f, ["notify-when-idle", "worker-a"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("run this from inside a Claude Code session");
      const s = run(f, ["send", "chat", "hi @worker-a", "--as", "x", "--notify-when-idle"]);
      expect(s.code).toBe(1);
      expect(s.stdout).not.toContain("sent");
      expect(existsSync(f.home)).toBe(false); // 一个字节都没落盘
    } finally {
      f.server.close();
    }
  });

  test("目标不是活会话：报错", () => {
    const f = fixture();
    try {
      const r = run(f, ["notify-when-idle", "ghost"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("ghost is not a live Claude session");
    } finally {
      f.server.close();
    }
  });
});
