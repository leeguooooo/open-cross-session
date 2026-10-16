import { entryCapabilities, type Capabilities } from "./capabilities.ts";
import { writeTraffic, type TrafficEvent } from "./traffic.ts";
// 局域网 ocs 守护进程：`ocs lan up` 以脱离终端的 `ocs _lan-daemon` 启动。
//
// 只做三件事：接受已配对对端的加密连接、兑现配对邀请、应答局域网发现。收到远端 DM 后
// 走和本地 `ocs dm` 完全相同的「落盘 → 唤醒阶梯」，只是落在 `lan-*` 频道，发送者一律显示
// 为 `<对方地址>@<对端 label>`——label 是本机给对端起的名字，远端改不了，所以远端冒充
// 不了本机会话。
//
// 授权模型：配对 = 允许对端列出本机可达会话、并给它们发 DM（等价于本机另一个会话能做的事）。
// 未配对连接除了兑现一份开着的邀请，什么都做不了。消息正文不进日志。

import { appendFileSync, renameSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { collectingSink, deliverDm } from "./deliver.ts";
import { messages, type Lang } from "./i18n.ts";
import { LanProtocolError, type LanIdentity } from "./lan-crypto.ts";
import { startDiscoveryResponder } from "./lan-discovery.ts";
import {
  clearDaemonState,
  daemonLogPath,
  findPeerByFingerprint,
  liveDaemonState,
  loadLanConfig,
  loadOrCreateIdentity,
  consumePeerUse,
  notePeerAddress,
  offerTerms,
  PAIR_REQUEST_WAIT_MS,
  redeemPairOffer,
  sanitizePeerLabel,
  settlePairRequest,
  submitPairRequest,
  trustPeer,
  writeDaemonState,
  type LanConfig,
  type LanPeer,
} from "./lan-store.ts";
import { fromB64 } from "./lan-crypto.ts";
import { PAIR_TOKEN_BYTES } from "./lan-crypto.ts";
import { acceptSecure } from "./lan-wire.ts";
import { claudeShortId, entryShortId, listOcsNames, ocsNameFor, readOcsName } from "./names.ts";
import { buildRoster, resolveDmTarget, type ResolvedDmTarget } from "./roster.ts";
import { findAgyWorker } from "./agy.ts";
import { grokTargetName, listGrokSessions } from "./grok.ts";
import { codexThreadLivePid } from "./codex-queue.ts";
import { hermesTargetName, listHermesSessions } from "./hermes.ts";
import { codexDesktopIpcAvailable, discoverCodexDesktopOwners } from "./codex-ipc.ts";
import { appendMessage, BODY_LIMIT, NAME_RE, OCS_IDENTITY_RE } from "./store.ts";

export const LAN_DAEMON_COMMAND = "_lan-daemon";
const MAX_CONNECTIONS = 64;
const MAX_PREAUTH_PER_IP = 8;
const MAX_PREAUTH_TOTAL = 32;
const REQUEST_TIMEOUT_MS = 30_000;
const UNPAIRED_REQUEST_TIMEOUT_MS = 5_000;
const SOCKET_IDLE_MS = 90_000;
const LOG_ROTATE_BYTES = 1024 * 1024;

/** 会话环境变量不许漏进守护进程：否则它会把启动它的那个会话当「自己」，永远不唤醒它。 */
export const LAN_DAEMON_ENV_STRIP = [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "OCS_NAME",
  "OCS_PI_SESSION_ID",
  "GROK_SESSION_ID",
  "HERMES_SESSION_ID",
  "HERMES_SESSION_SOURCE",
  "HERMES_UI_SESSION_ID",
];

/** 两端各自落盘的会话频道：同一对（对端、本机参与者、远端参与者）恒落同一频道，收发同源。 */
export function lanChannel(peerFingerprint: string, localKey: string, remoteKey: string): string {
  const digest = createHash("sha256").update(`${peerFingerprint}\0${localKey}\0${remoteKey}`).digest("hex");
  return `lan-${digest.slice(0, 32)}`;
}

export interface LocalAddress {
  /** 频道派生用：不随改名变的短 id（没有时用名字）。 */
  key: string;
  /** 给对方看、给对方回复用：ocs 名字优先。 */
  display: string;
}

/** 解析结果 → 本机参与者的地址。解析不到活目标、也不是登记过的 ocs 名字时返回 null。 */
export function localAddressOf(
  resolved: ResolvedDmTarget,
  requested: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalAddress | null {
  const names = listOcsNames(env);
  if (resolved.kind === "agy") return findAgyWorker(env) === null ? null : { key: "agy", display: "agy" };
  if (resolved.kind === "claude") {
    if (resolved.claude !== undefined) {
      const key = claudeShortId(resolved.claude.sessionId) ?? resolved.claude.name ?? requested;
      const display = ocsNameFor({ kind: "claude", session: resolved.claude }, names)?.name ?? key;
      return { key, display };
    }
    // 不在线：只接受登记过的 ocs 名字（停靠后本人重启还能 inbox 认领）。任意名字都停靠
    // 会让对端随手造频道。
    const entry = readOcsName(requested, env);
    if (entry === null) return null;
    return { key: entryShortId(entry), display: entry.name };
  }
  if (resolved.kind === "codex-task" && resolved.threadId !== undefined) {
    const key = `codex-${resolved.threadId.slice(0, 8)}`;
    return { key, display: ocsNameFor({ kind: "codex", id: resolved.threadId }, names)?.name ?? key };
  }
  if (resolved.kind === "pi" && resolved.piSessionId !== undefined) {
    const key = `pi-${resolved.piSessionId.slice(0, 8)}`;
    return { key, display: ocsNameFor({ kind: "pi", id: resolved.piSessionId }, names)?.name ?? key };
  }
  if (resolved.kind === "hermes" && resolved.hermesSessionKey !== undefined) {
    const key = hermesTargetName(resolved.hermesSessionKey);
    return { key, display: ocsNameFor({ kind: "hermes", id: resolved.hermesSessionKey }, names)?.name ?? key };
  }
  if (resolved.kind === "grok" && resolved.grokSessionId !== undefined) {
    const key = grokTargetName(resolved.grokSessionId);
    return { key, display: ocsNameFor({ kind: "grok", id: resolved.grokSessionId }, names)?.name ?? key };
  }
  return null;
}

export interface LanWhoEntry {
  address: string;
  kind: "claude" | "codex" | "pi" | "hermes" | "grok" | "agy";
  status?: string;
  label?: string;
  capabilities?: Capabilities;
}

/**
 * Codex 任务可达 = 有活进程持有 rollout（`codex queue` 可投）**或**被 Desktop renderer 认领
 * （IPC 可投）——和本机 `ocs who` 同一判据（铁律 10）。只认前者的话，Windows（没有 lsof）上
 * 开着的 Desktop 任务对远端整个隐身。探测失败按「没认领」处理。
 */
async function desktopClaimed(threadIds: readonly string[], env: NodeJS.ProcessEnv): Promise<Set<string>> {
  if (threadIds.length === 0 || !codexDesktopIpcAvailable(env)) return new Set();
  try {
    return new Set(Object.keys(await discoverCodexDesktopOwners(threadIds, { env })).map((id) => id.toLowerCase()));
  } catch {
    return new Set();
  }
}

/** 远端 who：只给地址、种类、状态和一句短标签，不给 pid / 路径。 */
export async function lanWhoEntries(env: NodeJS.ProcessEnv = process.env): Promise<LanWhoEntry[]> {
  const out: LanWhoEntry[] = [];
  const hermes = await listHermesSessions({ env });
  const grok = await listGrokSessions({ env });
  const roster = buildRoster(env, hermes.available ? hermes.sessions : [], grok.sessions);
  const claimed = await desktopClaimed(
    roster.entries.flatMap((e) => (e.kind === "codex-task" && e.livePid === null ? [e.threadId] : [])),
    env,
  );
  for (const entry of roster.entries) {
    const capabilities = { ...entryCapabilities(entry, roster,
      entry.kind === "codex-task" && claimed.has(entry.threadId.toLowerCase()), process.platform, env), deliveryReceipt: "none" as const };
    if (entry.kind === "agy") {
      out.push({ capabilities, address: "agy", kind: "agy", status: entry.status, label: "Antigravity CLI worker" });
      continue;
    }
    if (entry.kind === "grok") {
      out.push({ capabilities, address: entry.ocsName ?? entry.target, kind: "grok", status: entry.status,
        ...(entry.title === null ? {} : { label: entry.title.slice(0, 60) }) });
      continue;
    }
    if (entry.kind === "claude") {
      out.push({
        capabilities,
        address: entry.ocsName ?? entry.id ?? entry.name,
        kind: "claude",
        ...(entry.status === null ? {} : { status: entry.status }),
        ...(entry.ocsName === undefined ? { label: entry.name.slice(0, 60) } : {}),
      });
    } else if (entry.kind === "codex-task" && (entry.livePid !== null || claimed.has(entry.threadId.toLowerCase()))) {
      out.push({
        capabilities,
        address: entry.ocsName ?? entry.target,
        kind: "codex",
        ...(entry.summary === null ? {} : { label: entry.summary.slice(0, 60) }),
      });
    } else if (entry.kind === "hermes") {
      out.push({
        capabilities,
        address: entry.ocsName ?? entry.target,
        kind: "hermes",
        ...(entry.status === null ? {} : { status: entry.status }),
        ...(entry.title === null ? {} : { label: entry.title.slice(0, 60) }),
      });
    } else if (entry.kind === "pi") {
      out.push({
        capabilities,
        address: entry.ocsName ?? entry.target,
        kind: "pi",
        ...(entry.name === null ? {} : { label: entry.name.slice(0, 60) }),
      });
    }
  }
  return out;
}

type Reply = Record<string, unknown> & { ok: boolean };

/** `name(pid N)`、`queued … pid N` 里的 pid 抹掉再回给远端。 */
export function scrubPids(line: string): string {
  return line.replace(/\s*\(pid \d+\)/g, "").replace(/\bpid \d+/g, "pid ?");
}

export interface DmRequest {
  op: "dm";
  /** 发送方给自己的回复地址（ocs 名字或短 id）。 */
  from: string;
  /** 发送方的频道派生地址（短 id）。 */
  from_key: string;
  to: string;
  body: string;
  lang?: Lang;
}

/** 已认证对端的 DM：校验 → 解析本机目标 → 落 lan-* 频道 → 唤醒阶梯。 */
export async function handleLanDm(
  req: Record<string, unknown>,
  peer: LanPeer,
  localLang: Lang,
  env: NodeJS.ProcessEnv = process.env,
  /** Called right before storing; false = the peer's trust ran out, store nothing. */
  consumeUse: () => boolean = () => true,
): Promise<Reply> {
  const { from, from_key: fromKey, to, body } = req;
  if (typeof from !== "string" || !NAME_RE.test(from)) return { ok: false, error: "bad-request", detail: "from" };
  if (typeof fromKey !== "string" || !NAME_RE.test(fromKey)) return { ok: false, error: "bad-request", detail: "from_key" };
  if (typeof to !== "string" || !NAME_RE.test(to)) return { ok: false, error: "bad-request", detail: "to" };
  if (typeof body !== "string" || body.length === 0 || Buffer.byteLength(body, "utf8") > BODY_LIMIT) {
    return { ok: false, error: "bad-request", detail: "body" };
  }
  const replyLang: Lang = req.lang === "zh" ? "zh" : "en";
  let resolved: ResolvedDmTarget | null;
  try {
    resolved = resolveDmTarget(to, env);
  } catch (error) {
    return { ok: false, error: "resolve-failed" };
  }
  if (resolved === null) return { ok: false, error: "not-found" };
  // 候选列表里有 pid / cwd，不回给远端；让对方用 `ocs who --lan` 给的唯一地址重发。
  const ambiguous = resolved.ambiguousClaudeTargets ?? resolved.ambiguousCodexTargets ??
    resolved.ambiguousPiTargets ?? resolved.ambiguousNameTargets;
  if (ambiguous !== undefined) return { ok: false, error: "ambiguous" };
  // 远端只投活目标：格式合法的 codex uuid / pi-<uuid> 本机未必有，照单落盘等于让对端随手造频道。
  if (resolved.kind === "codex-task") {
    const thread = resolved.threadId;
    const live = thread !== undefined &&
      (codexThreadLivePid(thread, env) !== null || (await desktopClaimed([thread], env)).has(thread.toLowerCase()));
    if (!live) return { ok: false, error: "not-found" };
  }
  if (resolved.kind === "pi" && resolved.piSession === undefined) return { ok: false, error: "not-found" };
  if (resolved.kind === "grok") {
    const grok = await listGrokSessions({ env });
    if (!grok.sessions.some((s) => s.id === resolved.grokSessionId)) return { ok: false, error: "not-found" };
  }
  if (resolved.kind === "hermes") {
    // 同 Pi：只投此刻打开的会话。宿主连不上 / 会话没开都不落盘，免得对端随手造频道。
    const hermes = await listHermesSessions({ env });
    if (!hermes.available || !hermes.sessions.some((session) => session.key === resolved.hermesSessionKey)) {
      return { ok: false, error: "not-found" };
    }
  }
  const local = localAddressOf(resolved, to, env);
  if (local === null) return { ok: false, error: "not-found" };

  const channel = lanChannel(peer.fingerprint, local.key, fromKey);
  const remoteAddress = `${from}@${peer.label}`;
  // 频道日志里的 from 必须过 NAME_RE（'@' 不在字符集里，旧二进制会拒读整条）。
  const logFrom = [`${from}.${peer.label}`, `${fromKey}.${peer.label}`].find((name) => NAME_RE.test(name));
  if (logFrom === undefined) return { ok: false, error: "bad-request", detail: "sender name too long" };
  // Count a use only for a DM that is about to be stored (a typo'd address must not burn a
  // --once grant). Expired since the handshake, or the last use taken by a concurrent DM:
  // treat as unpaired and store nothing.
  if (!consumeUse()) return { ok: false, error: "unpaired" };
  const toIdentity = OCS_IDENTITY_RE.test(resolved.identity) ? resolved.identity : undefined;
  const message = appendMessage({
    channel,
    from: logFrom,
    ...(toIdentity === undefined ? {} : { from_identity: `lan:${peer.fingerprint}:${fromKey}`, to_identity: toIdentity }),
    body,
    env,
  });
  const sink = collectingSink();
  const quiet = req.op === "dm-quiet";
  const traffic: TrafficEvent = { v: 1, kind: "message", channel, seq: message.seq,
    at: new Date().toISOString(), outcome: quiet ? "skipped" : "unknown", items: 1 };
  const trafficId = writeTraffic(traffic, env);
  let pending: "parked" | "deferred" | undefined;
  sink.pending = (state) => { pending = state; };
  if (!quiet) try { await deliverDm({
    resolved,
    target: local.display,
    channel,
    firstMessage: message.seq === 1,
    stableChannel: false,
    wakeInput: { channel, seq: message.seq, from: remoteAddress, body, lang: localLang },
    dmReplyTarget: remoteAddress,
    anyReplyTarget: remoteAddress,
    // 同一条带回执的唤醒；发送方在另一台机器上，第一阶段结果随应答回传，终态只记在本机
    // 频道日志里（不做跨机回传：那要本机主动连回对端并再发一条请求，见 docs/lan.md）。
    receipts: { sender: null, followUp: false },
    env,
  }, messages(replyLang), sink); } catch { sink.fail("unknown"); }
  const outcome = sink.outcome();
  const wake = quiet ? "skipped" : outcome !== "ok" ? outcome : pending ?? "accepted";
  writeTraffic({ ...traffic, outcome: wake }, env, trafficId);
  return {
    ok: true,
    channel,
    seq: message.seq,
    to_key: local.key,
    to_display: local.display,
    outcome,
    wake,
    // 投递行里有 pid（`name(pid N)`、codex queued pid N）：远端 who 刻意不给 pid，这里也不给。
    lines: sink.lines.map(scrubPids),
  };
}

/** 兑现配对邀请。成功时把对方写进信任库，并把结果回写给等待中的 `ocs lan pair`。 */
export function handleLanPair(
  req: Record<string, unknown>,
  client: { key: Buffer; fingerprint: string; host: string; port: number | null },
  config: LanConfig,
  identity: LanIdentity,
  env: NodeJS.ProcessEnv = process.env,
): Reply {
  if (client.fingerprint === identity.fingerprint) return { ok: false, error: "self" };
  let token: Buffer;
  try {
    token = fromB64(req.token, PAIR_TOKEN_BYTES, "token");
  } catch {
    return { ok: false, error: "bad-request", detail: "token" };
  }
  const claimed = typeof req.name === "string" ? sanitizePeerLabel(req.name) ?? "peer" : "peer";
  const redeemed = redeemPairOffer(token, (offer) => trustPeer({
    key: client.key,
    name: claimed,
    ...(offer.label === undefined ? {} : { label: offer.label }),
    ...(client.port === null ? {} : { addr: `${client.host}:${client.port}` }),
    terms: offerTerms(offer),
  }, env), env);
  if (!redeemed.ok) return { ok: false, error: redeemed.reason };
  return { ok: true, name: config.name, ...termsReply(redeemed.peer) };
}

/** Tell the peer the period we granted so it trusts us back for the same (old clients ignore it). */
function termsReply(peer: LanPeer): Record<string, unknown> {
  return {
    ...(peer.expires_at === undefined ? {} : { expires_at: peer.expires_at }),
    ...(peer.uses_left === undefined ? {} : { uses: peer.uses_left }),
  };
}

/**
 * Pair request (0.8+): attach to the open approve invitation and wait for the local human to
 * compare the 6-digit code and confirm. The connection is held meanwhile (it still counts
 * against the unauthenticated slots), for at most PAIR_REQUEST_WAIT_MS. When nobody is
 * waiting (no `ocs lan pair` running) the answer is an immediate no-offer — strangers cannot
 * pop prompts onto this machine's screen.
 */
export async function handleLanPairRequest(
  req: Record<string, unknown>,
  client: { key: Buffer; fingerprint: string; host: string; port: number | null; sas: string },
  config: LanConfig,
  identity: LanIdentity,
  env: NodeJS.ProcessEnv = process.env,
  options: { waitMs?: number; pollMs?: number } = {},
): Promise<Reply> {
  if (client.fingerprint === identity.fingerprint) return { ok: false, error: "self" };
  const name = typeof req.name === "string" ? sanitizePeerLabel(req.name) ?? "peer" : "peer";
  const addr = client.port === null ? undefined : `${client.host}:${client.port}`;
  const submitted = submitPairRequest({
    fingerprint: client.fingerprint,
    key: client.key.toString("base64"),
    name,
    sas: client.sas,
    ...(addr === undefined ? {} : { addr }),
  }, env);
  if (!submitted.ok) return { ok: false, error: submitted.reason };
  const approve = (offer: Parameters<Parameters<typeof settlePairRequest>[2]>[0]) => trustPeer({
    key: client.key,
    name,
    ...(offer.label === undefined ? {} : { label: offer.label }),
    ...(addr === undefined ? {} : { addr }),
    terms: offerTerms(offer),
  }, env);
  const deadline = Date.now() + (options.waitMs ?? PAIR_REQUEST_WAIT_MS);
  for (;;) {
    const giveUp = Date.now() >= deadline;
    const result = settlePairRequest(submitted.offerId, submitted.requestId, approve, giveUp, env);
    if (result.state === "approved") return { ok: true, name: config.name, ...termsReply(result.peer) };
    if (result.state === "rejected") return { ok: false, error: "rejected" };
    if (result.state === "timeout") return { ok: false, error: "timeout" };
    if (result.state === "gone") return { ok: false, error: "cancelled" };
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250));
  }
}

// ───────────────────────── 服务 ─────────────────────────

class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly capacity: number, private readonly perSecond: number) {}

  take(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond);
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 4096) this.buckets.clear();
    return true;
  }
}

/** 每对端每个 UTC 日最多落盘这么多正文字节：限速之外再封顶磁盘占用。 */
const PEER_DAILY_BYTES = 16 * 1024 * 1024;

class DailyQuota {
  private used = new Map<string, { day: string; bytes: number }>();
  constructor(private readonly limit: number) {}

  take(key: string, bytes: number, now = new Date()): boolean {
    const day = now.toISOString().slice(0, 10);
    const entry = this.used.get(key);
    const current = entry?.day === day ? entry.bytes : 0;
    if (current + bytes > this.limit) return false;
    this.used.set(key, { day, bytes: current + bytes });
    return true;
  }
}

function daemonLogger(env: NodeJS.ProcessEnv): (line: string) => void {
  const path = daemonLogPath(env);
  return (line) => {
    try {
      if (statSync(path).size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // 还没有日志
    }
    try {
      // 行里有对端可控的字段（目标地址等）：剥控制字符、限长，防止伪造日志行。
      const safe = line.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 500).toLowerCase();
      appendFileSync(path, `${new Date().toISOString()} ${safe}\n`, { mode: 0o600 });
    } catch {
      // 日志写不了不影响服务
    }
  };
}

function normalizeIp(address: string | undefined): string {
  return (address ?? "?").replace(/^::ffff:/, "");
}

export interface LanServerHandle {
  port: number;
  close(): Promise<void>;
}

/** 起 TCP 服务（测试直接调它；守护进程入口在 runLanDaemon）。 */
export async function startLanServer(
  input: { identity: LanIdentity; config: LanConfig; lang: Lang; env?: NodeJS.ProcessEnv; log?: (line: string) => void },
): Promise<LanServerHandle> {
  const env = input.env ?? process.env;
  const log = input.log ?? (() => {});
  const { identity, config } = input;
  const preauth = new Map<string, number>();
  let preauthTotal = 0;
  const peerLimiter = new RateLimiter(30, 0.5);
  const pairLimiter = new RateLimiter(10, 10 / 60);
  const quota = new DailyQuota(PEER_DAILY_BYTES);

  const handle = async (socket: Socket): Promise<void> => {
    const ip = normalizeIp(socket.remoteAddress);
    socket.setTimeout(SOCKET_IDLE_MS, () => socket.destroy());
    socket.on("error", () => {});
    const pending = (preauth.get(ip) ?? 0) + 1;
    // 每 IP 8 个、全局 32 个未认证名额：64 个连接位里始终留一半给已配对对端。
    if (pending > MAX_PREAUTH_PER_IP || preauthTotal >= MAX_PREAUTH_TOTAL) {
      socket.destroy();
      return;
    }
    preauth.set(ip, pending);
    preauthTotal++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      preauthTotal--;
      const left = (preauth.get(ip) ?? 1) - 1;
      if (left <= 0) preauth.delete(ip);
      else preauth.set(ip, left);
    };
    try {
      const conn = await acceptSecure(socket, identity, (fp) => ({
        paired: findPeerByFingerprint(fp, env) !== null,
        name: config.name,
      }));
      const peer = findPeerByFingerprint(conn.clientFingerprint, env);
      // 未配对的连接握手能完成（用一次性钥匙就行），所以它们一直算在每 IP 的未认证名额里，
      // 直到断开；而且只给 5 秒发那一条 pair 请求——否则一个 IP 就能占满全部连接位。
      if (peer !== null) release();
      const req = await conn.channel.receive(peer !== null ? REQUEST_TIMEOUT_MS : UNPAIRED_REQUEST_TIMEOUT_MS) as Record<string, unknown>;
      const op = typeof req?.op === "string" ? req.op : "?";
      let reply: Reply;
      if (op === "pair") {
        if (!pairLimiter.take(ip)) reply = { ok: false, error: "rate-limited" };
        else {
          reply = handleLanPair(req, {
            key: conn.clientKey,
            fingerprint: conn.clientFingerprint,
            host: ip,
            port: conn.clientPort,
          }, config, identity, env);
        }
        log(`pair from ${ip} fp=${conn.clientFingerprint.slice(0, 16)}: ${reply.ok ? "paired" : String(reply.error)}`);
      } else if (op === "pair-request") {
        if (!pairLimiter.take(ip)) reply = { ok: false, error: "rate-limited" };
        else {
          reply = await handleLanPairRequest(req, {
            key: conn.clientKey,
            fingerprint: conn.clientFingerprint,
            host: ip,
            port: conn.clientPort,
            sas: conn.sas,
          }, config, identity, env);
        }
        log(`pair-request from ${ip} fp=${conn.clientFingerprint.slice(0, 16)}: ${reply.ok ? "paired" : String(reply.error)}`);
      } else if (peer === null) {
        reply = { ok: false, error: "unpaired" };
        log(`rejected unpaired ${op} from ${ip} fp=${conn.clientFingerprint.slice(0, 16)}`);
      } else if (!peerLimiter.take(peer.fingerprint)) {
        reply = { ok: false, error: "rate-limited" };
        log(`rate-limited ${op} from ${peer.label}`);
      } else {
        if (conn.clientPort !== null) notePeerAddress(peer.fingerprint, `${ip}:${conn.clientPort}`, env);
        if (op === "ping") reply = { ok: true, name: config.name };
        else if (op === "who") reply = { ok: true, name: config.name, entries: await lanWhoEntries(env) };
        else if ((op === "dm" || op === "dm-quiet") && !quota.take(peer.fingerprint, typeof req.body === "string" ? Buffer.byteLength(req.body, "utf8") : 0)) {
          reply = { ok: false, error: "quota-exceeded" };
          log(`quota exceeded for ${peer.label}`);
        } else if (op === "dm" || op === "dm-quiet") {
          reply = await handleLanDm(req, peer, input.lang, env, () => consumePeerUse(peer.fingerprint, env));
          log(`dm from ${peer.label} to ${String(req.to)}: ${reply.ok ? `seq ${String(reply.seq)} ${String(reply.outcome)}` : String(reply.error)}`);
        } else reply = { ok: false, error: "unknown-op" };
      }
      conn.channel.send(reply);
      conn.channel.close();
    } catch (error) {
      const code = error instanceof LanProtocolError ? error.code : "error";
      log(`connection from ${ip} dropped: ${code}${code === "error" ? ` ${String(error)}` : ""}`);
      socket.destroy();
    } finally {
      release();
    }
  };

  const server = createServer((socket) => {
    void handle(socket);
  });
  server.maxConnections = MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bind, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** `ocs _lan-daemon` 入口：单实例、写运行态、收 SIGTERM 清理退出。 */
export async function runLanDaemon(version: string, lang: Lang, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const log = daemonLogger(env);
  const running = liveDaemonState(env);
  if (running !== null && running.pid !== process.pid) {
    log(`another daemon is running (pid ${running.pid}); exiting`);
    process.exit(1);
  }
  const identity = loadOrCreateIdentity(env);
  const config = loadLanConfig(env);
  let server: LanServerHandle;
  try {
    server = await startLanServer({ identity, config, lang, env, log });
  } catch (error) {
    log(`listen on ${config.bind}:${config.port} failed: ${String(error)}`);
    process.exit(1);
  }
  const responder = config.discover
    ? await startDiscoveryResponder({ name: config.name, port: server.port, fingerprint: identity.fingerprint, bind: config.bind }, env, log)
    : null;
  writeDaemonState({
    pid: process.pid,
    port: server.port,
    bind: config.bind,
    name: config.name,
    fingerprint: identity.fingerprint,
    discover: responder !== null,
    version,
    started_at: new Date().toISOString(),
  }, env);
  log(`listening on ${config.bind}:${server.port} as ${config.name} fp=${identity.fingerprint.slice(0, 16)} discovery=${responder !== null ? "on" : "off"}`);
  const shutdown = async (signal: string) => {
    log(`${signal}: shutting down`);
    responder?.close();
    clearDaemonState(process.pid, env);
    await Promise.race([server.close(), new Promise((resolve) => setTimeout(resolve, 1000))]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("sigterm"));
  process.on("SIGINT", () => void shutdown("sigint"));
  await new Promise(() => {}); // 常驻
}
