// 「已读」的证据：宿主自己的会话记录里，这条唤醒 note 已经进了对话（docs/wake-protocol.md §7）。
//
// 唤醒 note 把正文（≤4096B）逐字带进对方会话，收件方其实已经读到了；但读游标只有 `ocs read`
// 才推进，于是 `ocs dm` 的 unread 提示和状态栏一直报「N 条未读」，模型还会为此多跑一次 read。
//
// 铁律 4 不变：投递成功（inbox accepted、交给 channel、queue 写入）都不算已读。这里只认宿主
// 写下的「进入对话」记录，而且只看会话自己的记录文件（同 uid、普通文件、不跟随符号链接）：
// - Claude：transcript 里 `attachment.type == "queued_command"`（收件箱注入出队进对话），或
//   `type == "user"` 的字符串内容（空闲时直接开轮 / channel 事件）。被扣留的消息只有 enqueue，
//   不会出现在这两类里。
// - Codex：rollout 里 `response_item` / `message` / `role: user` 的 input_text（queue、steer 进了回合）。
//   Desktop 委托信封不在此列，按未读处理。
// - Pi：会话文件里 `type: message`、`role: user` 的文本。
// 文本必须以唤醒首行开头（Claude 允许先有 ocs 自己的包装标签）；工具输出、模型回复里引用的首行
// 都不算。正文超过 4096B 被截成预览的 note 不算已读（对方只看到了前 512B）。合并唤醒只认它
// 自己那条 seq，「前面还有 N 条」不算。
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexSessionsRoot, listCodexRolloutFiles } from "./codex-sessions.ts";

/** 只读记录文件尾部这么多字节：够覆盖最近的往来，状态栏高频调用也不至于整读大文件。 */
export const SEEN_TAIL_BYTES = 8 * 1024 * 1024;
export const CLAUDE_PROJECTS_DIR_ENV = "OCS_CLAUDE_PROJECTS_DIR";
export const PI_AGENT_SESSIONS_DIR_ENV = "OCS_PI_AGENT_SESSIONS_DIR";

export type SeenSource =
  | { kind: "claude"; sessionId: string }
  | { kind: "codex"; threadId: string }
  | { kind: "pi"; sessionId: string };

export function seenKey(channel: string, seq: number): string {
  return `${channel}\u0000${seq}`;
}

const HEADER_EN = /^\[ocs wake\] (?:\S+ mentioned you in|New mention in) #([A-Za-z0-9._-]+) \(seq (\d+)[,)]/;
const HEADER_ZH = /^\[ocs 唤醒\] (?:\S+ 在 )?#([A-Za-z0-9._-]+) 提到了你（seq (\d+)[，）]/;
const TRUNCATED_RE = /^… \(\d+ bytes total; full text: /m;
// Claude 空闲时被唤醒会开新一轮，包装前多一行宿主自己的引导语（2.1.319：
// "Another Claude session sent a message:"）。只放过一行、且这一行里不能有 `<`。
const WRAPPER_RE = /^(?:[^\n<]*\n)?<(?:cross-session-message|channel source="ocs")[^\n>]*>\n/;

/** note 文本 → 它证明已读的 (channel, seq)；不是一条完整内联的唤醒 note 返回 null。 */
export function parseSeenWake(text: string, options: { allowWrapper: boolean }): { channel: string; seq: number } | null {
  let note = text;
  if (options.allowWrapper) {
    const wrapper = WRAPPER_RE.exec(note);
    if (wrapper !== null) note = note.slice(wrapper[0].length);
  }
  const match = HEADER_EN.exec(note) ?? HEADER_ZH.exec(note);
  if (match === null) return null;
  if (TRUNCATED_RE.test(note)) return null;
  const seq = Number(match[2]);
  return Number.isSafeInteger(seq) && seq > 0 ? { channel: match[1]!, seq } : null;
}

function trustedFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && (typeof process.getuid !== "function" || stat.uid === process.getuid());
  } catch {
    return false;
  }
}

/**
 * 只打开一次、不跟随符号链接，校验和取大小都对这个 fd 做：先按路径 lstat 再按路径打开，中间
 * 可以被换成指向别人记录的链接（检查与使用分离）。sessionRecordPath 里的 trustedFile 只是预筛。
 */
export function readRecordTail(path: string, maxBytes = SEEN_TAIL_BYTES): string[] {
  let fd: number;
  try {
    // O_NONBLOCK：路径若被换成命名管道，阻塞式 open 会一直等写端，fstat 校验根本轮不到。
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return [];
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return [];
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // 第一行可能被截断
    return lines;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

const MARKERS = ["[ocs wake]", "[ocs 唤醒]"];
const hasMarker = (line: string) => MARKERS.some((marker) => line.includes(marker));

function textsOfContent(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const p = part as Record<string, unknown>;
    return typeof p?.text === "string" && (p.type === "text" || p.type === "input_text") ? [p.text] : [];
  });
}

/** 一行记录里「进了对话」的 note 文本；不是这类记录返回空。 */
function conversationTexts(source: SeenSource["kind"], record: Record<string, unknown>): { texts: string[]; wrapper: boolean } {
  if (source === "claude") {
    const attachment = record.attachment as Record<string, unknown> | undefined;
    if (record.type === "attachment" && attachment?.type === "queued_command" && typeof attachment.prompt === "string") {
      return { texts: [attachment.prompt], wrapper: true };
    }
    const message = record.message as Record<string, unknown> | undefined;
    if (record.type === "user" && message?.role === "user" && typeof message.content === "string") {
      return { texts: [message.content], wrapper: true };
    }
    return { texts: [], wrapper: false };
  }
  if (source === "codex") {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (record.type === "response_item" && payload?.type === "message" && payload.role === "user") {
      return { texts: textsOfContent(payload.content), wrapper: false };
    }
    return { texts: [], wrapper: false };
  }
  const message = record.message as Record<string, unknown> | undefined;
  if (record.type === "message" && message?.role === "user") {
    return { texts: textsOfContent(message.content), wrapper: false };
  }
  return { texts: [], wrapper: false };
}

export function seenWakesInLines(source: SeenSource["kind"], lines: readonly string[]): Set<string> {
  const seen = new Set<string>();
  for (const line of lines) {
    if (!hasMarker(line)) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const { texts, wrapper } = conversationTexts(source, record as Record<string, unknown>);
    for (const text of texts) {
      const hit = parseSeenWake(text, { allowWrapper: wrapper });
      if (hit !== null) seen.add(seenKey(hit.channel, hit.seq));
    }
  }
  return seen;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 会话自己的记录文件；找不到或不可信返回 null。 */
export function sessionRecordPath(source: SeenSource, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  if (source.kind === "claude") {
    if (!/^[0-9a-f-]{36}$/i.test(source.sessionId)) return null;
    const override = env[CLAUDE_PROJECTS_DIR_ENV];
    const config = env.CLAUDE_CONFIG_DIR;
    const root = typeof override === "string" && override !== ""
      ? override
      : join(typeof config === "string" && config !== "" ? config : join(home, ".claude"), "projects");
    for (const project of safeReaddir(root)) {
      const path = join(root, project, `${source.sessionId}.jsonl`);
      if (trustedFile(path)) return path;
    }
    return null;
  }
  if (source.kind === "codex") {
    const wanted = source.threadId.toLowerCase();
    const hit = listCodexRolloutFiles(codexSessionsRoot(env, home)).find((file) => file.threadId.toLowerCase() === wanted);
    return hit !== undefined && trustedFile(hit.path) ? hit.path : null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(source.sessionId)) return null;
  const override = env[PI_AGENT_SESSIONS_DIR_ENV];
  const root = typeof override === "string" && override !== "" ? override : join(home, ".pi", "agent", "sessions");
  const suffix = `_${source.sessionId.toLowerCase()}.jsonl`;
  for (const project of safeReaddir(root)) {
    for (const file of safeReaddir(join(root, project))) {
      if (file.toLowerCase().endsWith(suffix) && trustedFile(join(root, project, file))) return join(root, project, file);
    }
  }
  return null;
}

/** 当前会话已经在对话里看到的唤醒（channel+seq）。拿不到证据就是空集：一切照旧按未读算。 */
export function seenWakes(source: SeenSource | null, env: NodeJS.ProcessEnv = process.env): Set<string> {
  if (source === null) return new Set();
  const path = sessionRecordPath(source, env);
  return path === null ? new Set() : seenWakesInLines(source.kind, readRecordTail(path));
}
