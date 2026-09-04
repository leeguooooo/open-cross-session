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

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  linkSync,
  lstatSync,
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
    const at = match.index ?? 0;
    if (at > 0 && !/[\s([{（]/u.test(body[at - 1]!)) continue;
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
export function acquireLock(lockPath: string, env: NodeJS.ProcessEnv): () => void {
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

interface DmChannelBinding {
  v: 1;
  stable_channel: string;
  channel: string;
  inherited_from?: string;
  created_at: string;
}

function dmBindingsDir(env?: NodeJS.ProcessEnv): string {
  return join(ocsHome(env), "dm-bindings");
}

function dmBindingPath(stableChannel: string, env?: NodeJS.ProcessEnv): string {
  if (!CHANNEL_RE.test(stableChannel) || !stableChannel.startsWith("dm-")) {
    throw new Error(`invalid stable DM channel: ${stableChannel}`);
  }
  return join(dmBindingsDir(env), `${stableChannel}.json`);
}

function readDmBinding(stableChannel: string, env?: NodeJS.ProcessEnv): DmChannelBinding | null {
  const path = dmBindingPath(stableChannel, env);
  let raw: string;
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 8 * 1024 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) throw new Error(`untrusted DM binding: ${path}`);
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`invalid DM binding JSON: ${path}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid DM binding: ${path}`);
  }
  const binding = value as Record<string, unknown>;
  const keys = Object.keys(binding).sort().join(",");
  if (
    keys !== "channel,created_at,stable_channel,v" &&
    keys !== "channel,created_at,inherited_from,stable_channel,v"
  ) throw new Error(`invalid DM binding: ${path}`);
  if (
    binding.v !== 1 ||
    binding.stable_channel !== stableChannel ||
    typeof binding.channel !== "string" ||
    !CHANNEL_RE.test(binding.channel) ||
    !binding.channel.startsWith("dm-") ||
    (binding.inherited_from !== undefined &&
      (typeof binding.inherited_from !== "string" ||
        !CHANNEL_RE.test(binding.inherited_from) ||
        !binding.inherited_from.startsWith("dm-"))) ||
    typeof binding.created_at !== "string"
  ) throw new Error(`invalid DM binding: ${path}`);
  return binding as unknown as DmChannelBinding;
}

function legacyNameMatches(name: string, alias: string): boolean {
  if (name === alias) return true;
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}-[0-9a-f]{2}$`, "i").test(name);
}

function validateDmParticipants(
  channel: string,
  messages: readonly OcsMessage[],
  aliases: readonly [string, string],
  requireBoth = true,
): void {
  if (messages.length === 0) throw new Error(`inherited DM channel ${channel} is missing or empty`);
  const participants = new Set(messages.map((message) => message.from));
  if (requireBoth) {
    for (const alias of aliases) {
      if (![...participants].some((name) => legacyNameMatches(name, alias))) {
        throw new Error(`inherited DM channel ${channel} has no messages from workspace ${alias}`);
      }
    }
  }
  const unexpected = [...participants].filter((name) =>
    !aliases.some((alias) => legacyNameMatches(name, alias))
  );
  if (unexpected.length > 0) {
    throw new Error(`inherited DM channel ${channel} contains unexpected participants: ${unexpected.join(", ")}`);
  }
}

function mergedDmChannel(stableChannel: string, inheritedChannel: string, payload: string): string {
  const hash = createHash("sha256")
    .update(`${stableChannel}\u0000${inheritedChannel}\u0000${payload}`)
    .digest("hex")
    .slice(0, 40);
  return `dm-${hash}--merged-history`;
}

function resequence(messages: readonly OcsMessage[], firstSeq: number): OcsMessage[] {
  const seqs = new Map(messages.map((message, index) => [message.seq, firstSeq + index]));
  return messages.map((message, index) => {
    const replyTo = message.reply_to === undefined ? undefined : seqs.get(message.reply_to);
    return {
      ...message,
      seq: firstSeq + index,
      ...(replyTo === undefined ? { reply_to: undefined } : { reply_to: replyTo }),
    };
  });
}

/**
 * 旧频道和新稳定频道都已有消息时，不覆盖任何一边。把两份快照写入确定性合并频道，
 * 旧历史在前、新历史在后，reply_to 只在各自原频道内重映射。合并频道名包含快照内容摘要：
 * 崩溃后源频道又有追加时，重试会生成新快照，不会被上次未绑定的文件永久卡住。
 */
function materializeMergedDmChannel(
  stableChannel: string,
  inheritedChannel: string,
  aliases: readonly [string, string],
  env?: NodeJS.ProcessEnv,
): string {
  const channels = [...new Set([stableChannel, inheritedChannel])].sort();
  const unlocks: Array<() => void> = [];
  try {
    for (const channel of channels) {
      unlocks.push(acquireLock(join(channelsDir(env), `${channel}.lock`), env ?? process.env));
    }
    const inherited = readMessages(inheritedChannel, { env });
    const stable = readMessages(stableChannel, { env });
    validateDmParticipants(inheritedChannel, inherited, aliases);
    validateDmParticipants(stableChannel, stable, aliases, false);
    const merged = [
      ...resequence(inherited, 1),
      ...resequence(stable, inherited.length + 1),
    ];
    const payload = `${merged.map((message) => JSON.stringify(message)).join("\n")}\n`;
    const mergedChannel = mergedDmChannel(stableChannel, inheritedChannel, payload);
    unlocks.push(acquireLock(join(channelsDir(env), `${mergedChannel}.lock`), env ?? process.env));
    const path = channelLogPath(mergedChannel, env);
    let existing: string | null = null;
    try {
      existing = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing !== null) {
      if (existing !== payload) {
        throw new Error(`merged DM channel ${mergedChannel} failed its content-addressed integrity check`);
      }
      return mergedChannel;
    }
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, payload, { flag: "wx", mode: 0o600 });
      linkSync(tmp, path);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // 已清理
      }
    }
    return mergedChannel;
  } finally {
    for (const unlock of unlocks.reverse()) unlock();
  }
}

function writeDmBinding(binding: DmChannelBinding, env?: NodeJS.ProcessEnv): void {
  const path = dmBindingPath(binding.stable_channel, env);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(binding), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp 未生成或已 rename
    }
    throw error;
  }
}

export interface AppendDmInput {
  /** 双方都有唯一工作区身份时的稳定频道；否则缺省。 */
  stableChannel?: string;
  /** 没有稳定工作区身份时的会话级频道。 */
  fallbackChannel: string;
  /** 用户显式选择的旧 DM 频道，作为该稳定 pair 的历史。 */
  inheritChannel?: string;
  /** --inherit 时用来证明旧频道里双方都发过言；只接受当前两个活且唯一的 workspace alias。 */
  expectedLegacyAliases?: readonly [string, string];
  from: string;
  body: string;
  env?: NodeJS.ProcessEnv;
}

export interface AppendDmResult {
  channel: string;
  message: OcsMessage;
  bindingCreated: boolean;
}

/**
 * 稳定 DM pair 的「解析绑定 → append」共用一把锁，防止一边继承旧频道、另一边同时写入
 * 新稳定频道。绑定只能从「新稳定频道还是空的」状态创建，且一旦落盘不可改指。
 */
export function appendDmMessage(input: AppendDmInput): AppendDmResult {
  if (input.stableChannel === undefined) {
    if (input.inheritChannel !== undefined) {
      throw new Error("--inherit requires two uniquely addressable live Claude workspaces");
    }
    const message = appendMessage({
      channel: input.fallbackChannel,
      from: input.from,
      body: input.body,
      env: input.env,
    });
    return { channel: input.fallbackChannel, message, bindingCreated: false };
  }

  const stableChannel = input.stableChannel;
  const dir = dmBindingsDir(input.env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unlock = acquireLock(`${dmBindingPath(stableChannel, input.env)}.lock`, input.env ?? process.env);
  try {
    let binding = readDmBinding(stableChannel, input.env);
    let bindingCreated = false;
    const inheritChannel = input.inheritChannel;
    if (inheritChannel !== undefined) {
      if (input.expectedLegacyAliases === undefined) {
        throw new Error("--inherit requires two uniquely addressable live Claude workspaces");
      }
      if (!CHANNEL_RE.test(inheritChannel) || !inheritChannel.startsWith("dm-")) {
        throw new Error(`invalid inherited DM channel: ${inheritChannel}`);
      }
      if (
        binding !== null &&
        binding.channel !== inheritChannel &&
        binding.inherited_from !== inheritChannel
      ) {
        throw new Error(
          `stable DM channel is already bound to ${binding.channel}; refusing to replace it with ${inheritChannel}`,
        );
      }
      if (binding === null && inheritChannel !== stableChannel) {
        const inheritedMessages = readMessages(inheritChannel, { env: input.env });
        validateDmParticipants(inheritChannel, inheritedMessages, input.expectedLegacyAliases);
        const stableHasMessages = lastSeq(stableChannel, input.env) > 0;
        const channel = stableHasMessages
          ? materializeMergedDmChannel(
              stableChannel,
              inheritChannel,
              input.expectedLegacyAliases,
              input.env,
            )
          : inheritChannel;
        binding = {
          v: 1,
          stable_channel: stableChannel,
          channel,
          inherited_from: inheritChannel,
          created_at: new Date().toISOString(),
        };
        writeDmBinding(binding, input.env);
        bindingCreated = true;
      }
    }
    const channel = binding?.channel ?? stableChannel;
    if (binding !== null && lastSeq(channel, input.env) === 0) {
      throw new Error(`bound DM history channel ${channel} is missing or empty`);
    }
    const message = appendMessage({ channel, from: input.from, body: input.body, env: input.env });
    return { channel, message, bindingCreated };
  } finally {
    unlock();
  }
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
