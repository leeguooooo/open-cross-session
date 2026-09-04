import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inject.ts";
import { IDLE_POLL_MS_ENV } from "../src/idle.ts";
import { appendMessage, loadCursor, readMessages, readRoutedMessages, OCS_HOME_ENV } from "../src/store.ts";

// 真 CLI 进程 + 真 UDS + 真脱离终端的 watcher。
// 订阅方/发送方会话 = 本测试进程（CLI 的祖先，findSelfClaudePid 命中，名 tester）；
// 对端会话 = 一个 sleep 子进程（活 pid，名 worker-a），两者共用一个收帧 socket。
//
// 对端**每个 fixture 各起一个**，不用 beforeAll 共享：bun test 在任一用例超时后会
// "kill dangling processes"——把共享的 sleep 一起杀掉，之后所有需要活对端的用例连锁红
// （Linux CI 现场：冷启动 CLI 约 3s，首个用例超默认 5s 即触发）。每用例 60s 预算同理。
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const T = 60_000;

interface Fixture {
  env: Record<string, string>;
  home: string;
  server: Server;
  frames: string[];
  nextFrame: () => Promise<string>;
  setPeer: (status: "busy" | "idle") => void;
  writeSelf: boolean;
  close: () => void;
}

function fixture(options: { withSelf?: boolean; selfCwd?: string; peerCwd?: string } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "ocs-e2e-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { mode: 0o700 });
  const sockPath = join(dir, "inbox.sock");
  const frames: string[] = [];
  const waiters: Array<(f: string) => void> = [];
  let consumed = 0; // nextFrame 先吐已到但未取的帧（异步跑 CLI 时帧常早于调用到达），再等新帧
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
  const peer = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
  const withSelf = options.withSelf ?? true;
  if (withSelf) {
    writeFileSync(
      join(sessionsDir, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: "self-sess",
        name: "tester",
        cwd: options.selfCwd ?? "/work/tester",
        status: "busy",
        messagingSocketPath: sockPath,
      }),
      { mode: 0o600 },
    );
  }
  const setPeer = (status: "busy" | "idle") =>
    writeFileSync(
      join(sessionsDir, `${peer.pid}.json`),
      JSON.stringify({
        pid: peer.pid,
        sessionId: "peer-sess",
        name: "worker-a",
        cwd: options.peerCwd ?? "/work/worker",
        status,
        messagingSocketPath: sockPath,
      }),
      { mode: 0o600 },
    );
  setPeer("busy");
  const home = join(dir, "home");
  // 剥掉本测试进程可能从真实 Claude 会话继承的自身识别变量，CLI 只认 fixture。
  const inherited = { ...process.env } as Record<string, string>;
  delete inherited.CLAUDE_CODE_SESSION_ID;
  delete inherited.CLAUDE_CODE_MESSAGING_SOCKET;
  delete inherited.CODEX_THREAD_ID;
  delete inherited.OCS_NAME;
  return {
    env: {
      ...inherited,
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
        if (consumed < frames.length) {
          resolve(frames[consumed++]!);
          return;
        }
        waiters.push((frame) => {
          consumed++;
          resolve(frame);
        });
        setTimeout(() => reject(new Error("no frame within 4s")), 4000);
      }),
    setPeer,
    writeSelf: withSelf,
    close: () => {
      server.close();
      peer.kill();
    },
  };
}

/**
 * 异步跑 CLI：本测试进程同时是收帧的 UDS 服务端，`spawnSync` 会把事件循环卡住——
 * CLI 连上来的帧要等 CLI 退出后才被 accept，与真实接收端（独立进程、随时 accept）不符。
 */
async function run(f: Fixture, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { env: f.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const content = (frame: string) =>
  (JSON.parse(frame.trim()) as { message: { content: string } }).message.content;

describe("read 不回显自己（#3）", () => {
  test("默认折叠成一行；--include-self 完整显示；--json 带 self", async () => {
    const f = fixture();
    try {
      const mine = "hello there this is a fairly long message from me that goes past sixty characters";
      expect((await run(f, ["send", "chat", mine, "--as", "me", "--no-wake"])).code).toBe(0);
      expect((await run(f, ["send", "chat", "short reply", "--as", "peer", "--no-wake"])).code).toBe(0);

      const folded = await run(f, ["read", "chat", "--as", "me"]);
      expect(folded.code).toBe(0);
      const lines = folded.stdout.trimEnd().split("\n");
      expect(lines.length).toBe(2);
      expect(lines[0]).toBe(`#1 <you> ${[...mine].slice(0, 60).join("")}…`);
      expect(lines[1]).toMatch(/^#2 \S+ <peer> short reply$/);

      const full = await run(f, ["read", "chat", "--as", "me", "--include-self", "--since", "0"]);
      expect(full.stdout).toMatch(new RegExp(`^#1 \\S+ <me> ${mine}\\n`));
      expect(full.stdout).not.toContain("<you>");

      const json = await run(f, ["read", "chat", "--as", "me", "--json", "--since", "0"]);
      const records = JSON.parse(json.stdout) as Array<{ seq: number; from: string; body: string; self: boolean }>;
      expect(records.map((r) => [r.seq, r.self])).toEqual([[1, true], [2, false]]);
      expect(records[0]!.body).toBe(mine); // --json 不折叠
      // peer 视角：同一条消息 self=false，且不折叠
      const peerView = await run(f, ["read", "chat", "--as", "peer", "--since", "0"]);
      expect(peerView.stdout).toContain(`<me> ${mine}`);
      expect(peerView.stdout).toContain("#2 <you> short reply");
    } finally {
      f.close();
    }
  }, T);
});

describe("inbox 离线续接", () => {
  test("只列投给自己的未读 DM，read 后沿同一 cursor 消失", async () => {
    const f = fixture();
    try {
      appendMessage({
        channel: "dm-inbox-test",
        from: "worker-a",
        from_identity: "name:worker-a",
        to_identity: "name:tester",
        body: "queued while you were away",
        env: f.env,
      });
      appendMessage({
        channel: "dm-someone-else",
        from: "worker-a",
        from_identity: "name:worker-a",
        to_identity: "name:someone-else",
        body: "private",
        env: f.env,
      });

      const inbox = await run(f, ["inbox", "--as", "tester"]);
      expect({ code: inbox.code, stderr: inbox.stderr }).toEqual({ code: 0, stderr: "" });
      expect(inbox.stdout).toContain("Inbox: 1 unread thread(s)");
      expect(inbox.stdout).toContain("ocs read dm-inbox-test");
      expect(inbox.stdout).not.toContain("dm-someone-else");

      const read = await run(f, ["read", "dm-inbox-test", "--as", "tester"]);
      expect(read.stdout).toContain("queued while you were away");
      expect((await run(f, ["inbox", "--as", "tester"])).stdout).toContain("no unread threads");
    } finally {
      f.close();
    }
  }, T);

  test("dm 写入的 route sidecar 可被离线收件人直接发现", async () => {
    const f = fixture();
    try {
      const sent = await run(f, ["dm", "offline-bob", "please resume", "--as", "alice"]);
      expect({ code: sent.code, stderr: sent.stderr }).toEqual({ code: 0, stderr: "" });
      expect(sent.stdout).toContain("NOT woken");

      const inbox = await run(f, ["inbox", "--as", "offline-bob"]);
      expect(inbox.stdout).toContain("Inbox: 1 unread thread(s)");
      const channel = /ocs read (dm-[^\s]+) --as offline-bob/.exec(inbox.stdout)?.[1];
      expect(channel).toBeDefined();
      const read = await run(f, ["read", channel!, "--as", "offline-bob"]);
      expect(read.stdout).toContain("please resume");
      expect((await run(f, ["inbox", "--as", "offline-bob"])).stdout).toContain("no unread threads");

      const reply = await run(f, [
        "send",
        channel!,
        "done",
        "--as",
        "offline-bob",
        "--reply-to",
        "1",
        "--no-wake",
      ]);
      expect({ code: reply.code, stderr: reply.stderr }).toEqual({ code: 0, stderr: "" });
      const aliceInbox = await run(f, ["inbox", "--as", "alice"]);
      expect(aliceInbox.stdout).toContain("Inbox: 1 unread thread(s)");
      expect(aliceInbox.stdout).toContain(`ocs read ${channel} --as alice`);
    } finally {
      f.close();
    }
  }, T);

  test("发送方 cursor 写失败不把已落盘 DM 伪装成发送失败", async () => {
    const f = fixture();
    try {
      mkdirSync(f.home, { recursive: true });
      writeFileSync(join(f.home, "cursors"), "not a directory");
      const sent = await run(f, ["dm", "offline-bob", "stored once", "--as", "alice"]);
      expect({ code: sent.code, stderr: sent.stderr }).toEqual({ code: 0, stderr: "" });
      expect(sent.stdout).toContain("message is stored, but the sender cursor could not be advanced");
      expect(sent.stdout).toContain("NOT woken");
      const channel = /channel (dm-[^,\s)]+)/.exec(sent.stdout)?.[1];
      expect(channel).toBeDefined();
      expect(readMessages(channel!, { env: f.env }).map((message) => message.body)).toEqual(["stored once"]);
    } finally {
      f.close();
    }
  }, T);
});

describe("唤醒目标排除发送者本人（#3）", () => {
  test("按名字：--as worker-a 的正文里 @worker-a 不唤醒 worker-a（活会话、真 socket）", async () => {
    const f = fixture();
    try {
      const r = await run(f, ["send", "chat", "reply and @worker-a me back", "--as", "worker-a"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("you mentioned yourself; skipped");
      expect(r.stdout).not.toContain("delivered");
      await sleep(200);
      expect(f.frames.length).toBe(0);
    } finally {
      f.close();
    }
  }, T);

  test("按 pid：祖先链上的本会话（tester）被 @ 也不回环", async () => {
    const f = fixture();
    try {
      const r = await run(f, ["send", "chat", "ping @tester", "--as", "someone-else"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("you mentioned yourself; skipped");
      await sleep(200);
      expect(f.frames.length).toBe(0);
    } finally {
      f.close();
    }
  }, T);

  test("对照：@ 别人正常唤醒，帧里带正文与 Reply: 行", async () => {
    const f = fixture();
    try {
      const r = await run(f, ["send", "chat", "please look @worker-a", "--as", "tester"]);
      expect(r.stdout).toContain("wake: delivered to inbox → worker-a");
      const c = content(await f.nextFrame());
      expect(c).toContain("[ocs wake] tester mentioned you in #chat (seq 1)\n\nplease look @worker-a\n\n");
      expect(c).toContain('Reply: ocs send chat "<your reply>" --reply-to 1\n');
      expect(c).toContain("Thread: ocs read chat\n");
    } finally {
      f.close();
    }
  }, T);
});

describe("--reply-to 唤醒被回复者（Reply: 行复制即达）", () => {
  test("不带 @ 也唤醒 seq 作者；note 首行带 reply to seq", async () => {
    const f = fixture();
    try {
      expect((await run(f, ["send", "chat", "question", "--as", "worker-a", "--no-wake"])).code).toBe(0);
      const r = await run(f, ["send", "chat", "<your reply>", "--as", "tester", "--reply-to", "1"]);
      expect(r.stdout).toContain("wake: delivered to inbox → worker-a");
      const c = content(await f.nextFrame());
      expect(c).toContain("[ocs wake] tester mentioned you in #chat (seq 2, reply to seq 1)\n\n<your reply>\n\n");
      expect(c).toContain('Reply: ocs send chat "<your reply>" --reply-to 2\n');
    } finally {
      f.close();
    }
  }, T);
});

describe("dm 唤醒提示（#8 #9）", () => {
  test("会话内自动识别发送者时，Reply 只推荐 ocs dm <name>", async () => {
    const f = fixture();
    try {
      const r = await run(f, ["dm", "worker-a", "hello"]);
      expect(r.code).toBe(0);
      const channel = /channel (dm-[^,\s)]+)/.exec(r.stdout)?.[1];
      expect(channel).toBeDefined();
      expect(readRoutedMessages(channel!, { env: f.env })[0]).toMatchObject({
        from: "tester",
        from_identity: expect.stringMatching(/^workspace:[0-9a-f]{64}$/),
        to_identity: expect.stringMatching(/^workspace:[0-9a-f]{64}$/),
      });
      const c = content(await f.nextFrame());
      expect(c).toContain('Reply: ocs dm tester "<your reply>"\n');
      expect(c).toMatch(/Thread: ocs read dm-[^\s]+\n/);
      expect(c).not.toContain("--as worker-a");
    } finally {
      f.close();
    }
  }, T);

  test("显式 --as 可能不是可寻址的发送者，仍用频道回复但接收方身份自动识别", async () => {
    const f = fixture();
    try {
      const r = await run(f, ["dm", "worker-a", "hello", "--as", "stable-alias"]);
      expect(r.code).toBe(0);
      const c = content(await f.nextFrame());
      expect(c).toMatch(/Reply: ocs send dm-[^\s]+ "<your reply>" --reply-to 1/);
      expect(c).not.toContain("--as worker-a");
    } finally {
      f.close();
    }
  }, T);

  test("发送方工作区有多个活会话时，不生成歧义 dm 地址，退回完整 send 命令", async () => {
    const f = fixture({ peerCwd: "/work/tester" });
    try {
      const r = await run(f, ["dm", "worker-a", "hello"]);
      expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
      const c = content(await f.nextFrame());
      expect(c).toMatch(/Reply: ocs send dm-[^\s]+ "<your reply>" --reply-to 1/);
      expect(c).not.toContain("Reply: ocs dm tester");
    } finally {
      f.close();
    }
  }, T);

  test("--inherit 显式继承旧频道，当次和后续 DM 都续写原历史（#10）", async () => {
    const f = fixture();
    try {
      appendMessage({ channel: "dm-old-history", from: "tester-aa", body: "old one", env: f.env });
      appendMessage({ channel: "dm-old-history", from: "worker-bb", body: "old two", env: f.env });
      const inherited = await run(f, ["dm", "worker-a", "new three", "--inherit", "dm-old-history"]);
      expect({ code: inherited.code, stderr: inherited.stderr }).toEqual({ code: 0, stderr: "" });
      expect(inherited.stdout).toContain("DM history inherited: dm-old-history → dm-old-history");
      expect(inherited.stdout).toContain("channel dm-old-history, seq 3");
      expect(loadCursor("dm-old-history", "tester", f.env)).toBe(3);
      const firstWake = content(await f.nextFrame());
      expect(firstWake).toContain("Thread: ocs read dm-old-history");

      const continued = await run(f, ["dm", "worker-a", "new four"]);
      expect(continued.code).toBe(0);
      expect(continued.stdout).toContain("channel dm-old-history, seq 4");
      await f.nextFrame();
      expect(readMessages("dm-old-history", { env: f.env }).map((message) => message.body))
        .toEqual(["old one", "old two", "new three", "new four"]);
    } finally {
      f.close();
    }
  }, T);

  test("首次稳定 DM 与 --inherit 并发时不会分裂成两条历史", async () => {
    const f = fixture();
    try {
      appendMessage({ channel: "dm-old-race", from: "tester-aa", body: "old one", env: f.env });
      appendMessage({ channel: "dm-old-race", from: "worker-bb", body: "old two", env: f.env });
      const [inherit, ordinary] = await Promise.all([
        run(f, ["dm", "worker-a", "inherit write", "--inherit", "dm-old-race"]),
        run(f, ["dm", "worker-a", "ordinary write"]),
      ]);
      expect({ code: inherit.code, stderr: inherit.stderr }).toEqual({ code: 0, stderr: "" });
      expect(ordinary.code).toBe(0);
      const continued = await run(f, ["dm", "worker-a", "continued write"]);
      expect({ code: continued.code, stderr: continued.stderr }).toEqual({ code: 0, stderr: "" });
      const channel = /channel (dm-[^,\s)]+)/.exec(continued.stdout)?.[1];
      expect(channel).toBeDefined();
      expect(readMessages(channel!, { env: f.env }).map((message) => message.body).sort())
        .toEqual(["continued write", "inherit write", "old one", "old two", "ordinary write"].sort());
    } finally {
      f.close();
    }
  }, T);

  test("workspace-key 丢失时 DM 降级到会话级频道，不让基本通信罢工", async () => {
    const f = fixture();
    try {
      expect((await run(f, ["dm", "worker-a", "warm key"])).code).toBe(0);
      await f.nextFrame();
      unlinkSync(join(f.home, "workspace-key"));
      const degraded = await run(f, ["dm", "worker-a", "still deliver"]);
      expect({ code: degraded.code, stderr: degraded.stderr }).toEqual({ code: 0, stderr: "" });
      expect(degraded.stdout).toContain("workspace continuity disabled:");
      expect(degraded.stdout).toContain("session-scoped DM remains available");
      expect(degraded.stdout).toContain("wake: delivered to inbox");
      await f.nextFrame();
    } finally {
      f.close();
    }
  }, T);
});

describe("notify-when-idle（#5）端到端：真脱离终端的 watcher", () => {
  test("订阅→去重→对端翻 idle→恰好一条通知投到订阅方；watcher 退出", async () => {
    const f = fixture();
    try {
      const r1 = await run(f, ["notify-when-idle", "worker-a"]);
      expect(r1.code).toBe(0);
      expect(r1.stdout).toContain("notify-when-idle: subscribed → worker-a");
      const subsDir = join(f.home, "idle-subs");
      const files = () => readdirSync(subsDir).filter((n) => n.endsWith(".json"));
      expect(files().length).toBe(1);

      const r2 = await run(f, ["notify-when-idle", "worker-a"]);
      expect(r2.stdout).toContain("notify-when-idle: already subscribed → worker-a");
      expect(files().length).toBe(1);

      const who = await run(f, ["who"]);
      expect(who.stdout).toContain("Pending idle notifications");
      expect(who.stdout).toContain("worker-a → notify tester when idle");

      await sleep(150);
      expect(f.frames.length).toBe(0);
      f.setPeer("idle");
      const c = content(await f.nextFrame());
      // busy 时长从 watcher 首次观测到 busy 起算（fixture 不写 statusUpdatedAt），慢机器上会过 1s
      expect(c).toMatch(
        /^<cross-session-message from-name="ocs" from-mode="prompting">\n\[Cross-session idle notice\] worker-a is now idle\. \(busy for \d+s\)\n<\/cross-session-message>$/,
      );
      await sleep(300);
      expect(f.frames.length).toBe(1);
      const record = JSON.parse(readFileSync(join(subsDir, files()[0]!), "utf8")) as { state: string; watcherPid: number };
      expect(record.state).toBe("fired");
      expect(() => process.kill(record.watcherPid, 0)).toThrow(); // watcher 已退出
      expect((await run(f, ["who"])).stdout).not.toContain("Pending idle notifications");
    } finally {
      f.close();
    }
  }, T);

  test("send --notify-when-idle：先发消息+唤醒，再订阅；对端已 idle 时立即通知", async () => {
    const f = fixture();
    try {
      f.setPeer("idle");
      const r = await run(f, ["send", "chat", "do it @worker-a", "--as", "tester", "--notify-when-idle"]);
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
      f.close();
    }
  }, T);

  test("不在 Claude 会话里：明确拒绝，且 send 不发出消息", async () => {
    const f = fixture({ withSelf: false });
    try {
      const r = await run(f, ["notify-when-idle", "worker-a"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("run this from inside a Claude Code session");
      const s = await run(f, ["send", "chat", "hi @worker-a", "--as", "x", "--notify-when-idle"]);
      expect(s.code).toBe(1);
      expect(s.stdout).not.toContain("sent");
      expect(existsSync(f.home)).toBe(false); // 一个字节都没落盘
    } finally {
      f.close();
    }
  }, T);

  test("目标不是活会话：报错", async () => {
    const f = fixture();
    try {
      const r = await run(f, ["notify-when-idle", "ghost"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("ghost is not a live Claude session");
    } finally {
      f.close();
    }
  }, T);
});
