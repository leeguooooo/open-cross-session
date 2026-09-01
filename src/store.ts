// 本机 append-only 频道消息日志。
//
// 这是 open-cross-session 相对 AgentParty 唯一自研的核心：把云端「消息总线」三职责
// 里的第一件（消息 + 单调 seq）落成单机实现。设计承袭上游两条铁律：
// 1. 定序只按 seq（频道内全局单调），绝不按 ts——ts 是发送端本地时钟，同机多进程下
//    也不可信（上游 #881 结论，同样适用于本地）。
// 2. isOcsMessage 校验的字段表必须与写入方逐字镜像，否则静默丢消息（上游 #622 教训）；
//    test/store.test.ts 里有镜像一致性测试守着。
//
// 并发模型：多进程同时 send 同一频道，用 O_EXCL 锁文件串行化「读日志尾 seq → 追加」。
// seq 的**单一真值源是日志本身**（锁内从日志尾部推导 last seq）——不设独立 seq 文件，
// 否则「日志已追加、seq 文件未更新」的崩溃窗口会让下一个发送者复用 seq，而读侧按
// seq 去重会把后到的那条永久遮蔽（发送成功但永远不可读）。
// 锁持有者崩溃靠 stale-break：pid 死（ESRCH）且锁龄超过门槛才可抢，抢占用原子 rename
// 认领——unlink 式抢占有双抢竞态（两个等待者都 unlink，第二个 unlink 掉的是首位
// 抢占成功者刚建的新锁，结果双持锁 → seq 重复 → 同样的永久遮蔽）。

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const OCS_HOME_ENV = "OCS_HOME";
export const LOCK_TIMEOUT_ENV = "OCS_LOCK_TIMEOUT_MS";
export const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const BODY_LIMIT = 100_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
/** 陈锁抢占门槛：pid 死还不够，锁还得老过这个时长——防「刚被抢占又被新持有者建好」的
 * 读-判-抢窗口里误伤活锁（新锁 mtime 恒新鲜，够不着门槛）。 */
const LOCK_STALE_MIN_MS = 1_000;
/** 推导 last seq 时先读日志尾部这么多字节；单行最大 ≈ BODY_LIMIT+元数据，取不到完整
 * 行（全是被截断的超长行）再整读兜底。 */
const TAIL_CHUNK_BYTES = 256 * 1024;

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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env[LOCK_TIMEOUT_ENV];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : LOCK_TIMEOUT_MS;
}

/**
 * O_EXCL 锁 + 安全 stale-break。返回 unlock 函数。
 * 抢占条件（review #7/#8 修订）：锁 mtime 老于 LOCK_STALE_MIN_MS，且
 *   - 持有者 pid 确认死亡（ESRCH），或
 *   - 锁内容为空/非法（持有者在 openSync 与写 pid 之间崩了——不许它变成永久死锁）。
 * 抢占动作：原子 rename 到唯一认领名，rename 后**验证 inode** 与检查时一致——
 * 不一致说明搬走的是别人在窗口期里刚建的新锁（#8 竞态），立即用 linkSync
 * （EEXIST 时不覆盖）原样归还。多个等待者只有一个 rename 成功，输家 ENOENT 重试。
 */
function acquireLock(lockPath: string, env: NodeJS.ProcessEnv): () => void {
  const deadline = Date.now() + lockTimeoutMs(env);
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd); // 写失败也不许漏 fd（review #7）
      }
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // 已被 stale-break 抢掉也无妨
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const observed = statSync(lockPath);
        const rawHolder = readFileSync(lockPath, "utf8");
        const holder = Number(rawHolder);
        const oldEnough = Date.now() - observed.mtimeMs > LOCK_STALE_MIN_MS;
        let breakable = false;
        if (rawHolder.trim() === "" || !Number.isInteger(holder) || holder <= 0) {
          breakable = true; // 空/非法内容：持有者写 pid 前就崩了（review #7）
        } else {
          try {
            process.kill(holder, 0);
          } catch (killError) {
            breakable = (killError as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
        if (breakable && oldEnough) {
          const claim = `${lockPath}.break.${process.pid}.${randomUUID()}`;
          try {
            renameSync(lockPath, claim);
            // inode 校验（review #8）：搬走的必须正是刚才检查过的那个文件。
            if (statSync(claim).ino === observed.ino) {
              unlinkSync(claim);
            } else {
              // 搬走了窗口期里新建的活锁——原样归还（linkSync 遇 EEXIST 不覆盖）。
              try {
                linkSync(claim, lockPath);
              } catch {
                // 已有更新的锁占位；被搬走的持有者由 append 后的自校验兜底
              }
              unlinkSync(claim);
            }
          } catch {
            // 别的等待者先认领了；正常重试
          }
          continue;
        }
      } catch {
        // 锁文件在读的瞬间被释放了；正常重试
      }
      if (Date.now() > deadline) {
        throw new Error(`channel lock timeout: ${lockPath}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

/**
 * 锁内从日志尾部推导 last seq——seq 的单一真值源。先读尾部 TAIL_CHUNK_BYTES 找最后
 * 一条合法行；尾部全是不完整/坏行时整读兜底（readMessages 已做校验+去重+排序）。
 */
function lastSeqFromLog(logPath: string, channel: string, env?: NodeJS.ProcessEnv): number {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return 0;
  }
  if (size === 0) return 0;
  const readFrom = Math.max(0, size - TAIL_CHUNK_BYTES);
  const buffer = Buffer.alloc(size - readFrom);
  const fd = openSync(logPath, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, readFrom);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString("utf8").split("\n");
  // 从块中读出的第一行可能是被截断的半行——除非块从文件头开始，否则丢弃第 0 行。
  const start = readFrom === 0 ? 0 : 1;
  let best = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isOcsMessage(value) && value.seq > best) best = value.seq;
    } catch {
      // 坏行
    }
  }
  if (best > 0) return best;
  // 尾块里一条合法行都没有（例如末尾堆着超长坏行）——整读兜底
  const all = readMessages(channel, { env });
  return all.length === 0 ? 0 : all[all.length - 1]!.seq;
}

/** 锁内调用：日志末字节不是 \n 时补一个，把崩溃残留的半行封口。 */
function repairTrailingPartialLine(logPath: string): void {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return; // 日志尚不存在
  }
  if (size === 0) return;
  const tail = Buffer.alloc(1);
  const fd = openSync(logPath, "r");
  try {
    readSync(fd, tail, 0, 1, size - 1);
  } finally {
    closeSync(fd);
  }
  if (tail[0] !== 0x0a) appendFileSync(logPath, "\n");
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
  // reply_to 必须在写入前验证：NaN 会被 JSON.stringify 成 null，写出一条读侧
  // isOcsMessage 拒绝的行——发送方看到 "sent seq N"，但那条消息永远读不出来。
  if (
    input.reply_to !== undefined &&
    (!Number.isInteger(input.reply_to) || input.reply_to < 1)
  ) {
    throw new Error(`invalid reply_to: ${input.reply_to}`);
  }

  const dir = channelsDir(input.env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logPath = channelLogPath(input.channel, input.env);
  const lockPath = join(dir, `${input.channel}.lock`);

  const unlock = acquireLock(lockPath, input.env ?? process.env);
  try {
    // 崩溃修复：上次写入中断可能留下无换行结尾的半行。不补换行就 append，新消息
    // 会粘在半行尾部一起变成垃圾——又一条「发送成功但永远不可读」。锁内查末字节。
    repairTrailingPartialLine(logPath);
    // 双持锁兜底（review #8）：锁协议已尽力，但极端竞态下仍可能两个进程同时进临界区、
    // 分配同一 seq——读侧去重保留首见，后落盘的被永久遮蔽。写后自校验：自己 seq 的
    // 首条落盘行必须逐字节是自己，否则换新 seq 重写（旧行成为被读侧跳过的重复行）。
    for (let attempt = 0; attempt < 3; attempt++) {
      const last = lastSeqFromLog(logPath, input.channel, input.env);
      const message: OcsMessage = {
        v: 1,
        seq: last + 1,
        ts: new Date().toISOString(),
        from: input.from,
        body: input.body,
        mentions: extractMentions(input.body),
        ...(input.reply_to !== undefined ? { reply_to: input.reply_to } : {}),
      };
      const line = JSON.stringify(message);
      appendFileSync(logPath, `${line}\n`, { mode: 0o600 });
      if (firstLineWithSeq(logPath, message.seq) === line) return message;
    }
    throw new Error(`append self-check failed 3 times: ${logPath}`);
  } finally {
    unlock();
  }
}

/** 尾块内找指定 seq 的首条合法行（读侧去重会保留的那条）。 */
function firstLineWithSeq(logPath: string, seq: number): string | null {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return null;
  }
  const readFrom = Math.max(0, size - TAIL_CHUNK_BYTES);
  const buffer = Buffer.alloc(size - readFrom);
  const fd = openSync(logPath, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, readFrom);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString("utf8").split("\n");
  const start = readFrom === 0 ? 0 : 1;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isOcsMessage(value) && value.seq === seq) return line;
    } catch {
      // 坏行
    }
  }
  return null;
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
  } catch (error) {
    // 只有「文件不存在」等于空频道；EACCES/EIO 必须炸出去——把权限错误
    // 说成「没有新消息」会让用户永远错过消息（review #9）。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
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
  const dir = join(ocsHome(env), "cursors");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 只进不退，且比较+写入要在锁内（review #10）：无锁的 load-compare-write 下，
  // 慢请求可以在快请求写入更大游标之后再写回小值。写入走 tmp+原子 rename，
  // 崩溃不会留下半截 JSON。
  const unlock = acquireLock(`${path}.lock`, env ?? process.env);
  try {
    const existing = loadCursor(channel, consumer, env);
    if (cursor <= existing) return;
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ cursor }), { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    unlock();
  }
}
