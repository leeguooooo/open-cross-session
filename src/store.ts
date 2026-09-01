// 本机 append-only 频道消息日志。
//
// 这是 open-cross-session 相对 AgentParty 唯一自研的核心：把云端「消息总线」三职责
// 里的第一件（消息 + 单调 seq）落成单机实现。设计承袭上游两条铁律：
// 1. 定序只按 seq（频道内全局单调），绝不按 ts——ts 是发送端本地时钟，同机多进程下
//    也不可信（上游 #881 结论，同样适用于本地）。
// 2. isOcsMessage 校验的字段表必须与写入方逐字镜像，否则静默丢消息（上游 #622 教训）；
//    test/store.test.ts 里有镜像一致性测试守着。
//
// 并发模型：多进程同时 send 同一频道，用 O_EXCL 锁文件串行化「读 seq → 追加 → 写 seq」。
// 锁持有者崩溃靠 stale-break：锁文件里写 pid，pid 死了即可抢占。

import {
  appendFileSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const OCS_HOME_ENV = "OCS_HOME";
export const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const BODY_LIMIT = 100_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

export function ocsHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[OCS_HOME_ENV];
  if (typeof override === "string" && override !== "" && isAbsolute(override)) return override;
  return join(homedir(), ".ocs");
}

function channelsDir(env?: NodeJS.ProcessEnv): string {
  return join(ocsHome(env), "channels");
}

export function channelLogPath(channel: string, env?: NodeJS.ProcessEnv): string {
  return join(channelsDir(env), `${channel}.jsonl`);
}

export interface OcsMessage {
  v: 1;
  seq: number;
  ts: string;
  from: string;
  body: string;
  mentions: string[];
  reply_to?: number;
}

// ⚠️ 镜像铁律：这张表必须逐字覆盖 OcsMessage 的全部字段（含可选）。
// 新增字段时两边同改，test/store.test.ts 的镜像测试会在漏改时红。
const REQUIRED_KEYS = ["v", "seq", "ts", "from", "body", "mentions"] as const;
const OPTIONAL_KEYS = ["reply_to"] as const;
const ALLOWED_KEYS: ReadonlySet<string> = new Set([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

export function isOcsMessage(value: unknown): value is OcsMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_KEYS.has(key)) return false;
  }
  return (
    rec.v === 1 &&
    typeof rec.seq === "number" && Number.isInteger(rec.seq) && rec.seq >= 1 &&
    typeof rec.ts === "string" &&
    typeof rec.from === "string" && NAME_RE.test(rec.from) &&
    typeof rec.body === "string" &&
    Array.isArray(rec.mentions) && rec.mentions.every((m) => typeof m === "string") &&
    (rec.reply_to === undefined ||
      (typeof rec.reply_to === "number" && Number.isInteger(rec.reply_to) && rec.reply_to >= 1))
  );
}

export function extractMentions(body: string): string[] {
  const out = new Set<string>();
  for (const match of body.matchAll(/@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g)) {
    out.add(match[1]!);
  }
  return [...out];
}

/** O_EXCL 锁 + pid stale-break。返回 unlock 函数。 */
function acquireLock(lockPath: string): () => void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // 已被 stale-break 抢掉也无妨
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // stale-break：持有者 pid 死了就抢占。
      try {
        const holder = Number(readFileSync(lockPath, "utf8"));
        if (Number.isInteger(holder) && holder > 0) {
          try {
            process.kill(holder, 0);
          } catch (killError) {
            if ((killError as NodeJS.ErrnoException).code === "ESRCH") {
              try {
                unlinkSync(lockPath);
              } catch {
                // 别人先清了，重试即可
              }
              continue;
            }
          }
        }
      } catch {
        // 锁文件读不了（刚被清），重试
      }
      if (Date.now() > deadline) {
        throw new Error(`channel lock timeout: ${lockPath}`);
      }
      const wait = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < wait) {
        // busy-wait：锁窗口极短（一次读+两次写），同步等待比引入异步依赖简单
      }
    }
  }
}

export interface AppendInput {
  channel: string;
  from: string;
  body: string;
  reply_to?: number;
  env?: NodeJS.ProcessEnv;
}

export function appendMessage(input: AppendInput): OcsMessage {
  if (!CHANNEL_RE.test(input.channel)) throw new Error(`invalid channel: ${input.channel}`);
  if (!NAME_RE.test(input.from)) throw new Error(`invalid sender name: ${input.from}`);
  if (input.body.length === 0) throw new Error("empty body");
  if (Buffer.byteLength(input.body, "utf8") > BODY_LIMIT) throw new Error("body too large");

  const dir = channelsDir(input.env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logPath = channelLogPath(input.channel, input.env);
  const seqPath = join(dir, `${input.channel}.seq`);
  const lockPath = join(dir, `${input.channel}.lock`);

  const unlock = acquireLock(lockPath);
  try {
    let last = 0;
    if (existsSync(seqPath)) {
      const parsed = Number(readFileSync(seqPath, "utf8"));
      if (Number.isInteger(parsed) && parsed >= 0) last = parsed;
    }
    const message: OcsMessage = {
      v: 1,
      seq: last + 1,
      ts: new Date().toISOString(),
      from: input.from,
      body: input.body,
      mentions: extractMentions(input.body),
      ...(input.reply_to !== undefined ? { reply_to: input.reply_to } : {}),
    };
    appendFileSync(logPath, `${JSON.stringify(message)}\n`, { mode: 0o600 });
    // seq 文件在日志之后写：崩溃在两写之间 → seq 文件落后 → 下次 send 会重读出重复 seq。
    // 兜底：读侧按 seq 去重（readMessages 保留首见），写侧锁内追加使这种窗口极窄。
    writeFileSync(seqPath, String(message.seq), { mode: 0o600 });
    return message;
  } finally {
    unlock();
  }
}

export interface ReadOptions {
  since?: number;
  env?: NodeJS.ProcessEnv;
}

export function readMessages(channel: string, options: ReadOptions = {}): OcsMessage[] {
  if (!CHANNEL_RE.test(channel)) throw new Error(`invalid channel: ${channel}`);
  const logPath = channelLogPath(channel, options.env);
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const since = options.since ?? 0;
  const seen = new Set<number>();
  const out: OcsMessage[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue; // 坏行跳过，绝不让一行脏数据毒化整个频道
    }
    if (!isOcsMessage(value)) continue;
    if (value.seq <= since || seen.has(value.seq)) continue;
    seen.add(value.seq);
    out.push(value);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

export function lastSeq(channel: string, env?: NodeJS.ProcessEnv): number {
  const messages = readMessages(channel, { env });
  return messages.length === 0 ? 0 : messages[messages.length - 1]!.seq;
}

/** 每消费者游标：`cursors/<channel>.<consumer>.json`。读位置与传输解耦（上游同款概念）。 */
export function cursorPath(channel: string, consumer: string, env?: NodeJS.ProcessEnv): string {
  return join(ocsHome(env), "cursors", `${channel}.${consumer}.json`);
}

export function loadCursor(channel: string, consumer: string, env?: NodeJS.ProcessEnv): number {
  try {
    const value = JSON.parse(readFileSync(cursorPath(channel, consumer, env), "utf8")) as unknown;
    if (typeof value === "object" && value !== null) {
      const cursor = (value as Record<string, unknown>).cursor;
      if (typeof cursor === "number" && Number.isInteger(cursor) && cursor >= 0) return cursor;
    }
  } catch {
    // 首次消费
  }
  return 0;
}

export function saveCursor(
  channel: string,
  consumer: string,
  cursor: number,
  env?: NodeJS.ProcessEnv,
): void {
  if (!NAME_RE.test(consumer)) throw new Error(`invalid consumer name: ${consumer}`);
  const path = cursorPath(channel, consumer, env);
  mkdirSync(join(ocsHome(env), "cursors"), { recursive: true, mode: 0o700 });
  // 只进不退：并发消费者各自推进，慢的一方不能把快的一方拉回去。
  const existing = loadCursor(channel, consumer, env);
  if (cursor <= existing) return;
  writeFileSync(path, JSON.stringify({ cursor }), { mode: 0o600 });
}
