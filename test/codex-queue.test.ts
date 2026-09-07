import { describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyQueueOutcome,
  codexHosts,
  codexQueueAvailable,
  codexQueueSupported,
  codexRolloutPath,
  codexThreadLivePid,
  codexThreadLivePids,
  queueCodexThread,
  resetCodexCliProbeCache,
} from "../src/codex-queue.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

const THREAD_LIVE = "11111111-1111-2222-3333-444444444444";
const THREAD_DEAD = "22222222-1111-2222-3333-444444444444";
const UNKNOWN = "33333333-1111-2222-3333-444444444444";

/** 两个 rollout：调用方自己决定给哪个开 fd（开着的那个就是「活会话」）。 */
function rolloutFixture(): { env: NodeJS.ProcessEnv; live: string; dead: string } {
  const codexHome = tempDir("ocs-codexq-");
  const day = join(codexHome, "sessions", "2026", "09", "07");
  mkdirSync(day, { recursive: true });
  const live = join(day, `rollout-2026-09-07T10-00-00-${THREAD_LIVE}.jsonl`);
  const dead = join(day, `rollout-2026-09-07T09-00-00-${THREAD_DEAD}.jsonl`);
  writeFileSync(live, "");
  writeFileSync(dead, "");
  return { env: { CODEX_HOME: codexHome }, live, dead };
}

/** 假的 `codex`：记录收到的参数，永远成功。 */
function fakeCodexBin(options: { queueSupported?: boolean } = {}): {
  env: NodeJS.ProcessEnv;
  argsLog: string;
} {
  const bin = tempDir("ocs-codexbin-");
  const argsLog = join(bin, "args.log");
  const help = options.queueSupported === false
    ? "Usage: codex queue"
    : "Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>";
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh
if [ "$1" = "queue" ] && [ "$2" = "--help" ]; then printf '%s\\n' ${JSON.stringify(help)}; exit 0; fi
printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}
echo "Queued message 01a079c9-7318-7192-ae2c-8078515ad91a for thread $3."
`,
    { mode: 0o755 },
  );
  resetCodexCliProbeCache();
  return { env: { PATH: `${bin}:/usr/bin:/bin` }, argsLog };
}

describe("codex-queue：thread → rollout 路径", () => {
  test("按 thread id 找到 rollout；未知 thread 与非法 id 都是 null", () => {
    const { env, live } = rolloutFixture();
    expect(codexRolloutPath(THREAD_LIVE, env)).toBe(live);
    expect(codexRolloutPath(UNKNOWN, env)).toBeNull();
    expect(codexRolloutPath("not-a-uuid", env)).toBeNull();
  });
});

describe("codex-queue：活性判定（rollout fd 持有者）", () => {
  test("有人持有 rollout fd 即为活；无人持有为死", () => {
    const { env, live } = rolloutFixture();
    const fd = openSync(live, "r");
    try {
      // 本测试进程自己持有 fd，所以 lsof 报出来的就是我们自己的 pid。
      expect(codexThreadLivePid(THREAD_LIVE, env)).toBe(process.pid);
      expect(codexThreadLivePid(THREAD_DEAD, env)).toBeNull();
    } finally {
      closeSync(fd);
    }
    expect(codexThreadLivePid(THREAD_LIVE, env)).toBeNull();
  });

  test("批量探测只认真正被持有的那个（部分未命中时 lsof 退 1，不算失败）", () => {
    const { env, live } = rolloutFixture();
    const fd = openSync(live, "r");
    try {
      const live_ = codexThreadLivePids([THREAD_LIVE, THREAD_DEAD, UNKNOWN], env);
      expect(live_.get(THREAD_LIVE)).toBe(process.pid);
      expect(live_.has(THREAD_DEAD)).toBe(false);
      expect(live_.has(UNKNOWN)).toBe(false);
    } finally {
      closeSync(fd);
    }
  });
});

describe("codex-queue：投递", () => {
  test("目标活着时才真的 queue，参数按 --thread/--message 传", () => {
    const rollout = rolloutFixture();
    const bin = fakeCodexBin();
    const env = { ...rollout.env, ...bin.env };
    const fd = openSync(rollout.live, "r");
    try {
      const result = queueCodexThread({ threadId: THREAD_LIVE, prompt: "hello", env });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.threadId).toBe(THREAD_LIVE);
      expect(result.pid).toBe(process.pid);
      expect(result.messageId).toBe("01a079c9-7318-7192-ae2c-8078515ad91a");
    } finally {
      closeSync(fd);
    }
    expect(Bun.file(bin.argsLog).text()).resolves.toContain(
      `queue --thread ${THREAD_LIVE} --message hello`,
    );
  });

  test("目标不在跑就绝不 queue：queue 是写 thread store，对死会话照样成功", async () => {
    const rollout = rolloutFixture();
    const bin = fakeCodexBin();
    const result = queueCodexThread({
      threadId: THREAD_DEAD,
      prompt: "hello",
      env: { ...rollout.env, ...bin.env },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("not-live");
    // 关键：一个字都没发出去，欠账留给 inbox。
    expect(await Bun.file(bin.argsLog).exists()).toBe(false);
  });

  test("非法 thread id 直接拒绝，不 spawn", async () => {
    const bin = fakeCodexBin();
    const result = queueCodexThread({ threadId: "nope", prompt: "x", env: bin.env });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("bad-thread-id");
    expect(await Bun.file(bin.argsLog).exists()).toBe(false);
  });

  test("PATH 上没有 codex 时报 unavailable，不静默当成功", () => {
    resetCodexCliProbeCache();
    const rollout = rolloutFixture();
    const empty = tempDir("ocs-nobin-");
    const result = queueCodexThread({
      threadId: THREAD_LIVE,
      prompt: "x",
      env: { ...rollout.env, PATH: empty },
      livePid: process.pid,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("unavailable");
    resetCodexCliProbeCache();
  });

  test("热路径只看 PATH 上有没有可执行的 codex（不 spawn）", () => {
    const bin = fakeCodexBin();
    expect(codexQueueAvailable(bin.env)).toBe(true);
    resetCodexCliProbeCache();
    expect(codexQueueAvailable({ PATH: tempDir("ocs-nobin-") })).toBe(false);
    resetCodexCliProbeCache();
  });

  // doctor 才付得起那半秒：真起一次 `codex queue --help` 看有没有 --thread。
  test("codexQueueSupported 能识别出没有 queue 子命令的老 codex", () => {
    expect(codexQueueSupported(fakeCodexBin().env)).toBe(true);
    expect(codexQueueSupported(fakeCodexBin({ queueSupported: false }).env)).toBe(false);
    resetCodexCliProbeCache();
  });
});

describe("codex-queue：宿主解析（tty + GUI 应用）", () => {
  test("解析自己这个进程：tty 与进程表一致，未知 pid 给出 null 而不是抛错", () => {
    const hosts = codexHosts([process.pid, 999_999]);
    const self = hosts.get(process.pid);
    expect(self).toBeDefined();
    // 测试进程可能有 tty 也可能没有（CI 里无控制终端），两种都合法，
    // 但绝不能是 ps 的 "??" 占位符原样透出。
    expect(self!.tty === null || /^\S+$/.test(self!.tty)).toBe(true);
    expect(self!.tty).not.toBe("??");
    expect(hosts.get(999_999)).toEqual({ tty: null, app: null });
  });

  test("空输入不 spawn ps", () => {
    expect(codexHosts([]).size).toBe(0);
  });
});

describe("codex-queue：投递期间目标消失（活性快照的竞态窗口）", () => {
  test("持有者不变=正常；消失或换人=unknown-outcome，绝不当成功", () => {
    expect(classifyQueueOutcome(4242, 4242)).toBeNull();

    const gone = classifyQueueOutcome(4242, null);
    expect(gone?.ok).toBe(false);
    expect(gone && !gone.ok ? gone.reason : null).toBe("unknown-outcome");
    expect(gone && !gone.ok ? gone.detail : "").toContain("exited during delivery");

    const swapped = classifyQueueOutcome(4242, 9001);
    expect(swapped && !swapped.ok ? swapped.reason : null).toBe("unknown-outcome");
    expect(swapped && !swapped.ok ? swapped.detail : "").toContain("4242 → 9001");
  });
});
