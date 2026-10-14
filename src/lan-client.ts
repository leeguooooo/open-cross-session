import { parseCapabilities } from "./capabilities.ts";
// 局域网 ocs 的发起方：配对、给远端会话发 DM、看远端花名册。
//
// 寻址顺序：信任库里记的最近地址 → 局域网发现（按指纹筛）→ 放弃。地址只是提示，身份以
// 握手里服务端签名的公钥为准（钉死完整指纹）；公钥对不上的地址当作「那台机器不在这」，
// 但会报出来——DHCP 换了地址很常见，有人冒名也表现为这个。

import { base32, decodePairingCode, LanProtocolError, type LanIdentity } from "./lan-crypto.ts";
import { scanLan } from "./lan-discovery.ts";
import {
  liveDaemonState,
  loadLanConfig,
  notePeerAddress,
  PAIR_REQUEST_WAIT_MS,
  trustPeer,
  type LanPeer,
  type PeerTerms,
} from "./lan-store.ts";
import { connectSecure, parseHostPort, type ClientConnection, type ServerExpectation } from "./lan-wire.ts";
import type { LanWhoEntry } from "./lan-daemon.ts";
import { NAME_RE } from "./store.ts";

/** 一次请求最长等多久应答。远端要走完整唤醒阶梯（Codex Desktop 探测可能几秒）。 */
export const LAN_REQUEST_TIMEOUT_MS = 45_000;

export class LanClientError extends Error {
  constructor(readonly code: string, message: string, readonly mismatches: string[] = []) {
    super(message);
    this.name = "LanClientError";
  }
}

function listenPort(env: NodeJS.ProcessEnv): number | null {
  return liveDaemonState(env)?.port ?? null;
}

async function tryConnect(
  addrs: readonly string[],
  identity: LanIdentity,
  expect: ServerExpectation,
  env: NodeJS.ProcessEnv,
  mismatches: string[],
): Promise<{ conn: ClientConnection; addr: string } | null> {
  for (const addr of addrs) {
    const parsed = parseHostPort(addr);
    if (parsed === null) continue;
    try {
      const conn = await connectSecure(parsed, identity, expect, { listenPort: listenPort(env) });
      return { conn, addr };
    } catch (error) {
      if (error instanceof LanProtocolError && error.code === "peer-key-mismatch") mismatches.push(addr);
      // 连不上 / 超时 / 协议不符：换下一个
    }
  }
  return null;
}

/** 连上一个已配对对端。成功时把通了的地址记回信任库。 */
export async function connectPeer(
  peer: LanPeer,
  identity: LanIdentity,
  env: NodeJS.ProcessEnv = process.env,
  options: { scanTimeoutMs?: number } = {},
): Promise<ClientConnection> {
  const expect: ServerExpectation = { kind: "fingerprint", fingerprint: peer.fingerprint };
  const mismatches: string[] = [];
  let hit = await tryConnect(peer.addrs, identity, expect, env, mismatches);
  if (hit === null) {
    const found = await scanLan({ timeoutMs: options.scanTimeoutMs ?? 1500 }, env);
    const candidates = found
      .filter((instance) => instance.fingerprint === peer.fingerprint)
      .map((instance) => `${instance.host}:${instance.port}`)
      .filter((addr) => !peer.addrs.includes(addr))
      // 发现应答不认证、可被伪造：只试前几个，别让一堆假应答把 DM 拖上几十秒。
      .slice(0, 4);
    hit = await tryConnect(candidates, identity, expect, env, mismatches);
  }
  if (hit === null) {
    throw new LanClientError("offline", `peer ${peer.label} is not reachable`, mismatches);
  }
  notePeerAddress(peer.fingerprint, hit.addr, env);
  return hit.conn;
}

async function request(conn: ClientConnection, body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  conn.channel.send(body);
  try {
    const reply = await conn.channel.receive(timeoutMs);
    if (typeof reply !== "object" || reply === null || typeof (reply as { ok?: unknown }).ok !== "boolean") {
      throw new LanProtocolError("bad-frame", "malformed reply");
    }
    return reply as Record<string, unknown>;
  } finally {
    conn.channel.close();
  }
}

// ───────────────────────── 配对 ─────────────────────────

export interface PairJoinResult {
  peer: LanPeer;
  addr: string;
}

/**
 * 兑码方：配对码 → 指纹前缀 + 令牌。候选地址来自 --addr 或局域网发现（按指纹前缀筛），
 * 握手时核对服务端公钥的指纹前缀，对上了才发出本机身份和令牌。
 */
export async function pairWithCode(
  code: string,
  identity: LanIdentity,
  options: { addr?: string; label?: string; scanTimeoutMs?: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<PairJoinResult> {
  const decoded = decodePairingCode(code);
  if (decoded === null) throw new LanClientError("bad-code", "malformed pairing code");
  let addrs: string[];
  if (options.addr !== undefined) {
    if (parseHostPort(options.addr) === null) throw new LanClientError("bad-addr", `bad address ${options.addr} (want host:port)`);
    addrs = [options.addr];
  } else {
    const found = await scanLan({ timeoutMs: options.scanTimeoutMs ?? 2000 }, env);
    const prefix = decoded.fpPrefix;
    // 发现应答里的指纹是 base32 文本；配对码里是摘要前 8 字节。比较摘要前缀的 base32 前缀：
    // 8 字节 = 64 位 → 前 12 个 base32 字符（60 位）完全由它决定，剩下 4 位交给握手精确核对。
    const wanted = base32(prefix).slice(0, 12);
    addrs = found.filter((instance) => instance.fingerprint.startsWith(wanted)).map((i) => `${i.host}:${i.port}`).slice(0, 4);
    if (addrs.length === 0) {
      throw new LanClientError("not-found", "no ocs instance with that pairing code answered on the LAN");
    }
  }
  const mismatches: string[] = [];
  const hit = await tryConnect(addrs, identity, { kind: "prefix", prefix: decoded.fpPrefix }, env, mismatches);
  if (hit === null) {
    throw new LanClientError(mismatches.length > 0 ? "key-mismatch" : "offline", "could not reach the issuing machine", mismatches);
  }
  if (hit.conn.serverFingerprint === identity.fingerprint) {
    hit.conn.channel.destroy();
    throw new LanClientError("self", "that pairing code belongs to this machine");
  }
  const reply = await request(hit.conn, {
    op: "pair",
    token: decoded.token.toString("base64"),
    name: loadLanConfig(env).name,
  }, LAN_REQUEST_TIMEOUT_MS);
  if (reply.ok !== true) throw new LanClientError(String(reply.error ?? "failed"), `pairing refused: ${String(reply.error)}`);
  const peer = trustPeer({
    key: hit.conn.serverKey,
    name: typeof reply.name === "string" ? reply.name : hit.conn.serverName,
    ...(options.label === undefined ? {} : { label: options.label }),
    addr: hit.addr,
    terms: replyTerms(reply),
  }, env);
  return { peer, addr: hit.addr };
}

/**
 * The period the other side granted us; we trust it back for the same period (if it only
 * gives us 8 hours, we should not stay open to it for longer). Invalid or missing fields
 * (0.7 peers send none) mean permanent, which is what older versions did.
 */
export function replyTerms(reply: Record<string, unknown>, now = Date.now()): PeerTerms {
  const expires = typeof reply.expires_at === "string" ? Date.parse(reply.expires_at) : Number.NaN;
  const uses = reply.uses;
  return {
    ...(Number.isFinite(expires) && expires > now ? { expires_at: new Date(expires).toISOString() } : {}),
    ...(Number.isInteger(uses) && (uses as number) > 0 && (uses as number) <= 1000 ? { uses_left: uses as number } : {}),
  };
}

/** Key prefix in the copied pairing text: lowercase base32, at least 16 chars (80 bits). */
export const PAIR_TARGET_RE = /^[a-z2-7]{16,52}$/;

/**
 * Pair by request (0.8+): the other side ran `ocs lan pair` and sent us a text with its key
 * prefix and addresses. The prefix is pinned during the handshake (no match → our identity is
 * never sent); once connected, the 6-digit check code goes to `onSas` for display, then we
 * send pair-request and wait for their human to compare codes and confirm.
 */
export async function pairByRequest(
  target: string,
  identity: LanIdentity,
  options: { addrs?: string[]; label?: string; scanTimeoutMs?: number; onSas?: (sas: string, serverName: string) => void },
  env: NodeJS.ProcessEnv = process.env,
): Promise<PairJoinResult> {
  const prefix = target.toLowerCase();
  if (!PAIR_TARGET_RE.test(prefix)) throw new LanClientError("bad-target", `bad pairing target ${target}`);
  if (identity.fingerprint.startsWith(prefix)) throw new LanClientError("self", "that is this machine's own key");
  const given = options.addrs ?? [];
  for (const addr of given) {
    if (parseHostPort(addr) === null) throw new LanClientError("bad-addr", `bad address ${addr} (want host:port)`);
  }
  const expect: ServerExpectation = { kind: "fp-prefix", prefix };
  const mismatches: string[] = [];
  let hit = await tryConnect(given, identity, expect, env, mismatches);
  if (hit === null) {
    const found = await scanLan({ timeoutMs: options.scanTimeoutMs ?? 2000 }, env);
    const candidates = found
      .filter((instance) => instance.fingerprint.startsWith(prefix))
      .map((instance) => `${instance.host}:${instance.port}`)
      .filter((addr) => !given.includes(addr))
      .slice(0, 4);
    hit = await tryConnect(candidates, identity, expect, env, mismatches);
  }
  if (hit === null) {
    throw new LanClientError(mismatches.length > 0 ? "key-mismatch" : "not-found", "could not reach the machine that sent the pairing text", mismatches);
  }
  options.onSas?.(hit.conn.sas, cleanText(hit.conn.serverName, 64));
  const reply = await request(hit.conn, { op: "pair-request", name: loadLanConfig(env).name }, PAIR_REQUEST_WAIT_MS + 15_000);
  if (reply.ok !== true) {
    // A 0.7 daemon does not know pair-request and answers it like any unpaired request.
    const code = reply.error === "unpaired" ? "old-peer" : typeof reply.error === "string" && /^[a-z-]{1,32}$/.test(reply.error) ? reply.error : "failed";
    throw new LanClientError(code, `pairing refused: ${code}`);
  }
  const peer = trustPeer({
    key: hit.conn.serverKey,
    name: typeof reply.name === "string" ? reply.name : hit.conn.serverName,
    ...(options.label === undefined ? {} : { label: options.label }),
    addr: hit.addr,
    terms: replyTerms(reply),
  }, env);
  return { peer, addr: hit.addr };
}

// ───────────────────────── DM / who ─────────────────────────

/** 远端文本进本机终端前：剥控制字符（含 ESC，防转义序列）、限长。 */
export function cleanText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, max);
}

export type RemoteDmReply =
  | {
      ok: true;
      channel: string;
      seq: number;
      to_key: string;
      to_display: string;
      outcome: "ok" | "failed" | "unknown";
      lines: string[];
      wake?: "accepted" | "deferred" | "parked" | "skipped" | "failed" | "unknown";
    }
  | { ok: false; error: string; detail?: string };

export type RemoteDmResult =
  | { delivered: true; reply: RemoteDmReply }
  /** 请求已发出但没拿到应答：对端可能已落盘并唤醒。铁律 5：绝不自动重发。 */
  | { delivered: "unknown"; detail: string };

export async function sendRemoteDm(
  peer: LanPeer,
  identity: LanIdentity,
  payload: { from: string; from_key: string; to: string; body: string; lang: "en" | "zh"; noWake?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<RemoteDmResult> {
  const conn = await connectPeer(peer, identity, env);
  if (!conn.paired) {
    conn.channel.destroy();
    throw new LanClientError("unpaired", `peer ${peer.label} no longer trusts this machine; pair again`);
  }
  const { noWake, ...fields } = payload;
  // New op: old receivers reject it before storing instead of ignoring a flag and waking.
  let raw: unknown;
  try {
    conn.channel.send({ op: noWake === true ? "dm-quiet" : "dm", ...fields });
    raw = await conn.channel.receive(LAN_REQUEST_TIMEOUT_MS);
  } catch (error) {
    conn.channel.destroy();
    return { delivered: "unknown", detail: error instanceof Error ? error.message : String(error) };
  }
  conn.channel.close();
  const reply = raw as RemoteDmReply;
  if (typeof reply !== "object" || reply === null || typeof reply.ok !== "boolean") {
    return { delivered: "unknown", detail: "malformed reply" };
  }
  // 远端给的每个字符串都当不可信输入：地址要过 NAME_RE（它会进频道派生和 lan: 身份），
  // 其余文本剥控制字符、限长后才进本机终端和发送方 agent 的上下文。
  if (reply.ok) {
    const valid = typeof reply.channel === "string" && /^lan-[0-9a-f]{32}$/.test(reply.channel) &&
      Number.isInteger(reply.seq) && reply.seq >= 1 &&
      typeof reply.to_key === "string" && NAME_RE.test(reply.to_key) &&
      typeof reply.to_display === "string" && NAME_RE.test(reply.to_display) &&
      (reply.outcome === "ok" || reply.outcome === "failed" || reply.outcome === "unknown") &&
      Array.isArray(reply.lines) && reply.lines.every((line) => typeof line === "string");
    if (!valid || (reply.wake !== undefined && !["accepted", "deferred", "parked", "skipped", "failed", "unknown"].includes(reply.wake)) ||
        (noWake === true && reply.wake !== "skipped")) return { delivered: "unknown", detail: "malformed reply" };
    reply.lines = reply.lines.map((line) => cleanText(line, 500)).slice(0, 20);
    return { delivered: true, reply };
  }
  const error = typeof reply.error === "string" && /^[a-z-]{1,32}$/.test(reply.error) ? reply.error : "refused";
  const detail = typeof reply.detail === "string" ? cleanText(reply.detail, 200) : undefined;
  return { delivered: true, reply: { ok: false, error, ...(detail === undefined ? {} : { detail }) } };
}

export async function remoteWho(
  peer: LanPeer,
  identity: LanIdentity,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ name: string; entries: LanWhoEntry[] }> {
  const conn = await connectPeer(peer, identity, env, { scanTimeoutMs: 1000 });
  if (!conn.paired) {
    conn.channel.destroy();
    throw new LanClientError("unpaired", `peer ${peer.label} no longer trusts this machine; pair again`);
  }
  const reply = await request(conn, { op: "who" }, 15_000);
  if (reply.ok !== true || !Array.isArray(reply.entries)) {
    throw new LanClientError(String(reply.error ?? "failed"), `who refused: ${String(reply.error)}`);
  }
  const clean = (value: unknown, max: number) => typeof value === "string" ? cleanText(value, max) : undefined;
  const entries: LanWhoEntry[] = [];
  for (const raw of reply.entries.slice(0, 200)) {
    const e = raw as Record<string, unknown>;
    const address = clean(e.address, 64);
    if (address === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(address)) continue;
    if (e.kind !== "claude" && e.kind !== "codex" && e.kind !== "pi" && e.kind !== "hermes" && e.kind !== "agy") continue;
    const status = clean(e.status, 16);
    const label = clean(e.label, 60);
    const capabilities = parseCapabilities(e.capabilities);
    entries.push({
      address,
      kind: e.kind,
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(status === undefined ? {} : { status }),
      ...(label === undefined ? {} : { label }),
    });
  }
  return { name: clean(reply.name, 64) ?? peer.name, entries };
}
