// 局域网 ocs 的本机状态：身份私钥、信任库（已配对对端）、配对邀请、守护进程配置与运行态。
//
// 全部落在 $OCS_HOME/lan/（0700），文件 0600，原子写（临时文件 + rename）。读侧对私钥和
// 信任库做 ssh 式的权限自检：不是本人的普通文件、或者组/其他人可读写，就拒绝使用——
// 信任库被别人改一行就等于给陌生机器发了通行证，这里不许静默容忍。

import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  constantTimeHexEqual,
  fingerprintOf,
  generateIdentity,
  identityFromPkcs8,
  PAIR_TOKEN_BYTES,
  tokenDigest,
  type LanIdentity,
} from "./lan-crypto.ts";
import { acquireLock, ocsHome } from "./store.ts";

/** 对端本地昵称：`bob@<label>` 里的 label。只在本机有意义，对方看不到。 */
export const PEER_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const FINGERPRINT_RE = /^[a-z2-7]{52}$/;
export const LAN_DEFAULT_PORT = 47890;
export const PAIR_OFFER_TTL_MS = 10 * 60 * 1000;
/** 一份邀请最多容忍这么多次错码，之后作废——56 位令牌只给在线猜这几次机会。 */
export const PAIR_MAX_FAILURES = 5;
/** Trust granted when pairing without a period flag: 8 hours (a working day). Permanent needs --forever. */
export const DEFAULT_PEER_TTL_MS = 8 * 60 * 60 * 1000;

export function lanDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(ocsHome(env), "lan");
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export class LanStateError extends Error {}

/** 本人所有、非符号链接、非组/其他人可访问的普通文件；否则抛错（不是返回 null）。 */
function assertPrivateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new LanStateError(`${path} is not a regular file`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new LanStateError(`${path} is not owned by the current user`);
  }
  // Windows 的权限在 NTFS ACL 里，mode 位恒是 0o666，没有意义；用户目录默认只有本人、
  // SYSTEM、Administrators 可访问。
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new LanStateError(`${path} is accessible by other users (mode ${(stat.mode & 0o777).toString(8)}); run: chmod 600 ${path}`);
  }
}

function readPrivateJson(path: string): unknown | null {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  assertPrivateFile(path);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function writePrivateJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // 已 rename 或从未创建
    }
  }
}

function withLock<T>(name: string, env: NodeJS.ProcessEnv, fn: () => T): T {
  ensureDir(lanDir(env));
  const unlock = acquireLock(join(lanDir(env), `${name}.lock`), env);
  try {
    return fn();
  } finally {
    unlock();
  }
}

// ───────────────────────── 身份 ─────────────────────────

/** 读本机身份；没有就生成（O_EXCL 建文件，两个进程同时首跑也只会有一把钥匙）。 */
export function loadOrCreateIdentity(env: NodeJS.ProcessEnv = process.env): LanIdentity {
  const dir = lanDir(env);
  ensureDir(dir);
  const path = join(dir, "identity.json");
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = readPrivateJson(path) as { v?: unknown; ed25519_pkcs8?: unknown } | null;
    if (existing !== null) {
      if (existing.v !== 1 || typeof existing.ed25519_pkcs8 !== "string") {
        throw new LanStateError(`${path} is malformed`);
      }
      return identityFromPkcs8(existing.ed25519_pkcs8);
    }
    const { identity, pkcs8 } = generateIdentity();
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify({ v: 1, ed25519_pkcs8: pkcs8, fingerprint: identity.fingerprint, created_at: new Date().toISOString() }, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
      return identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // 别的进程先建好了：下一轮读它的
    }
  }
  throw new LanStateError(`could not create ${path}`);
}

// ───────────────────────── 配置 ─────────────────────────

export interface LanConfig {
  /** 在局域网里自报的实例名（发现应答、配对时告诉对方）。 */
  name: string;
  port: number;
  /** 监听地址；默认 0.0.0.0（全部 IPv4 接口）。 */
  bind: string;
  /** 是否应答局域网发现查询。关掉后只能靠 --addr 配对、靠已知地址互联。 */
  discover: boolean;
}

export function defaultInstanceName(): string {
  const base = hostname().split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitizePeerLabel(base) ?? "ocs";
}

/** 把任意字符串收成合法 label；收不出来返回 null。 */
export function sanitizePeerLabel(raw: string): string | null {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return PEER_LABEL_RE.test(cleaned) ? cleaned : null;
}

export function loadLanConfig(env: NodeJS.ProcessEnv = process.env): LanConfig {
  const raw = readPrivateJson(join(lanDir(env), "config.json")) as Partial<LanConfig> | null;
  return {
    name: typeof raw?.name === "string" && PEER_LABEL_RE.test(raw.name) ? raw.name : defaultInstanceName(),
    port: Number.isInteger(raw?.port) && raw!.port! > 0 && raw!.port! < 65536 ? raw!.port! : LAN_DEFAULT_PORT,
    bind: typeof raw?.bind === "string" && raw.bind !== "" ? raw.bind : "0.0.0.0",
    discover: raw?.discover !== false,
  };
}

export function saveLanConfig(config: LanConfig, env: NodeJS.ProcessEnv = process.env): void {
  ensureDir(lanDir(env));
  writePrivateJson(join(lanDir(env), "config.json"), config);
}

// ───────────────────────── 信任库 ─────────────────────────

export interface LanPeer {
  label: string;
  /** Ed25519 原始公钥 base64。身份以它为准；label / 地址都只是提示。 */
  key: string;
  fingerprint: string;
  /** 对方自报的实例名（仅展示）。 */
  name: string;
  /** 最近成功互通过的地址 `host:port`，新的在前。 */
  addrs: string[];
  paired_at: string;
  last_seen?: string;
  /** When trust ends; absent = permanent (own devices, or anything paired before 0.8). */
  expires_at?: string;
  /** DMs still accepted; absent = unlimited. Inactive at 0 (`--once` pairs with 1). */
  uses_left?: number;
}

/** Period chosen by the inviting side; null ttl_ms / uses means unlimited. */
export interface PeerGrant {
  ttl_ms: number | null;
  uses: number | null;
}

export const DEFAULT_PEER_GRANT: PeerGrant = { ttl_ms: DEFAULT_PEER_TTL_MS, uses: null };

/** A period as stored in the trust store (absolute time). */
export interface PeerTerms {
  expires_at?: string;
  uses_left?: number;
}

export function grantTerms(grant: PeerGrant, now = Date.now()): PeerTerms {
  return {
    ...(grant.ttl_ms === null ? {} : { expires_at: new Date(now + grant.ttl_ms).toISOString() }),
    ...(grant.uses === null ? {} : { uses_left: grant.uses }),
  };
}

export function isPeerGrant(value: unknown): value is PeerGrant {
  if (typeof value !== "object" || value === null) return false;
  const g = value as Record<string, unknown>;
  const ok = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) > 0);
  return ok(g.ttl_ms) && ok(g.uses);
}

/** An expired or used-up peer counts as unpaired: not trusted at the handshake, no DMs either way. */
export function peerActive(peer: LanPeer, now = Date.now()): boolean {
  if (peer.expires_at !== undefined && !(Date.parse(peer.expires_at) > now)) return false;
  return peer.uses_left === undefined || peer.uses_left > 0;
}

function peersPath(env: NodeJS.ProcessEnv): string {
  return join(lanDir(env), "peers.json");
}

function isPeer(value: unknown): value is LanPeer {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  if (typeof p.label !== "string" || !PEER_LABEL_RE.test(p.label)) return false;
  if (typeof p.key !== "string" || typeof p.fingerprint !== "string" || !FINGERPRINT_RE.test(p.fingerprint)) return false;
  // 指纹必须能从公钥重算出来：手改信任库只改其一，一律当损坏处理。
  const raw = Buffer.from(p.key, "base64");
  if (raw.length !== 32 || fingerprintOf(raw) !== p.fingerprint) return false;
  if (p.expires_at !== undefined && (typeof p.expires_at !== "string" || Number.isNaN(Date.parse(p.expires_at)))) return false;
  if (p.uses_left !== undefined && (!Number.isInteger(p.uses_left) || (p.uses_left as number) < 0)) return false;
  return typeof p.name === "string" && Array.isArray(p.addrs) && p.addrs.every((a) => typeof a === "string") &&
    typeof p.paired_at === "string";
}

export function listPeers(env: NodeJS.ProcessEnv = process.env): LanPeer[] {
  const raw = readPrivateJson(peersPath(env)) as { v?: unknown; peers?: unknown } | null;
  if (raw === null) return [];
  if (raw.v !== 1 || !Array.isArray(raw.peers)) throw new LanStateError(`${peersPath(env)} is malformed`);
  const peers = raw.peers.filter(isPeer);
  if (peers.length !== raw.peers.length) throw new LanStateError(`${peersPath(env)} has malformed entries`);
  return peers;
}

/**
 * Inactive (expired / used-up) peers are kept (#79): `ocs lan peers` and `ocs who --lan` still
 * list them with the renew command, and `ocs lan trust` renews them without re-pairing. Keeping
 * the record grants nothing — the handshake and every DM go through `peerActive`. Only
 * `ocs lan unpair` removes an entry.
 */
function savePeers(peers: LanPeer[], env: NodeJS.ProcessEnv): void {
  writePrivateJson(peersPath(env), { v: 1, peers });
}

/** Peers whose trust is still active. */
export function activePeers(env: NodeJS.ProcessEnv = process.env, now = Date.now()): LanPeer[] {
  return listPeers(env).filter((peer) => peerActive(peer, now));
}

/** Why an inactive peer is inactive; null while it is active. */
export function peerInactiveReason(peer: LanPeer, now = Date.now()): "expired" | "used-up" | null {
  if (peer.expires_at !== undefined && !(Date.parse(peer.expires_at) > now)) return "expired";
  if (peer.uses_left !== undefined && peer.uses_left <= 0) return "used-up";
  return null;
}

/** Active trust ends within this window → `ocs who --lan` / `ocs dm …@peer` warn once. */
export const PEER_EXPIRY_WARN_MS = 30 * 60 * 1000;

/** Active peer whose time-limited trust ends within `PEER_EXPIRY_WARN_MS`. */
export function peerExpiringSoon(peer: LanPeer, now = Date.now()): boolean {
  if (!peerActive(peer, now) || peer.expires_at === undefined) return false;
  return Date.parse(peer.expires_at) - now <= PEER_EXPIRY_WARN_MS;
}

export function findPeerByFingerprint(fp: string, env: NodeJS.ProcessEnv = process.env): LanPeer | null {
  return activePeers(env).find((peer) => peer.fingerprint === fp) ?? null;
}

/** Find a peer by label or fingerprint prefix, inactive ones included (callers check peerActive). */
export function findPeer(query: string, env: NodeJS.ProcessEnv = process.env): LanPeer | null {
  const peers = listPeers(env);
  const lower = query.toLowerCase();
  const byLabel = peers.find((peer) => peer.label === lower);
  if (byLabel !== undefined) return byLabel;
  // 指纹前缀（≥8 字符）也能寻址，但必须唯一
  if (/^[a-z2-7]{8,52}$/.test(lower)) {
    const matches = peers.filter((peer) => peer.fingerprint.startsWith(lower));
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}

function uniqueLabel(wanted: string, peers: readonly LanPeer[], fp: string): string {
  const taken = new Set(peers.filter((peer) => peer.fingerprint !== fp).map((peer) => peer.label));
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const candidate = `${wanted.slice(0, 32 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Add or update a trusted peer (same fingerprint overwrites, keeping its label). `terms` is the
 * period from this pairing and replaces the old one wholesale — re-pairing a permanently
 * trusted machine for 8 hours makes it 8 hours. Omitted = permanent.
 */
export function trustPeer(
  input: { key: Buffer; name: string; label?: string; addr?: string; terms?: PeerTerms },
  env: NodeJS.ProcessEnv = process.env,
): LanPeer {
  return withLock("peers", env, () => {
    const peers = listPeers(env);
    const fp = fingerprintOf(input.key);
    const existing = peers.find((peer) => peer.fingerprint === fp);
    const wanted = input.label ?? existing?.label ?? sanitizePeerLabel(input.name) ?? "peer";
    const peer: LanPeer = {
      label: uniqueLabel(wanted, peers, fp),
      key: input.key.toString("base64"),
      fingerprint: fp,
      // 自报名来自对端：只留 label 字符集，免得控制字符/转义序列进信任库再被打印出来。
      name: sanitizePeerLabel(input.name) ?? "peer",
      addrs: [...new Set([...(input.addr === undefined ? [] : [input.addr]), ...(existing?.addrs ?? [])])].slice(0, 4),
      paired_at: existing?.paired_at ?? new Date().toISOString(),
      last_seen: new Date().toISOString(),
      ...(input.terms?.expires_at === undefined ? {} : { expires_at: input.terms.expires_at }),
      ...(input.terms?.uses_left === undefined ? {} : { uses_left: input.terms.uses_left }),
    };
    savePeers([...peers.filter((p) => p.fingerprint !== fp), peer], env);
    return peer;
  });
}

/** 已配对对端从新地址连进来 / 被连通：把地址提到最前。未配对的指纹不会被写入。 */
export function notePeerAddress(fp: string, addr: string, env: NodeJS.ProcessEnv = process.env): void {
  withLock("peers", env, () => {
    const peers = listPeers(env);
    const peer = peers.find((p) => p.fingerprint === fp);
    if (peer === undefined || !peerActive(peer)) return;
    peer.addrs = [...new Set([addr, ...peer.addrs])].slice(0, 4);
    peer.last_seen = new Date().toISOString();
    savePeers(peers, env);
  });
}

/**
 * Take one use for an incoming DM (atomic under the lock). Returns false when the peer is no
 * longer active — that DM must not be stored. The DM that takes the last use still goes
 * through; the peer is inactive afterwards (listed as used up until renewed or unpaired).
 */
export function consumePeerUse(fp: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return withLock("peers", env, () => {
    const peers = listPeers(env);
    const peer = peers.find((p) => p.fingerprint === fp);
    if (peer === undefined || !peerActive(peer)) return false;
    if (peer.uses_left === undefined) return true;
    peer.uses_left--;
    savePeers(peers, env);
    return true;
  });
}

/** `ocs lan trust`: change this machine's period for a peer (the other side keeps its own). */
export function setPeerTerms(fp: string, terms: PeerTerms, env: NodeJS.ProcessEnv = process.env): LanPeer | null {
  return withLock("peers", env, () => {
    const peers = listPeers(env);
    const at = peers.findIndex((p) => p.fingerprint === fp);
    if (at < 0) return null;
    const { expires_at: _e, uses_left: _u, ...rest } = peers[at]!;
    const next: LanPeer = { ...rest, ...terms };
    peers[at] = next;
    savePeers(peers, env);
    return next;
  });
}

export function removePeer(fp: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return withLock("peers", env, () => {
    const peers = listPeers(env);
    const rest = peers.filter((peer) => peer.fingerprint !== fp);
    if (rest.length === peers.length) return false;
    savePeers(rest, env);
    return true;
  });
}

// ───────────────────────── 配对邀请 ─────────────────────────

/** A pairing request from an unpaired machine, waiting for the inviting human to check the code. */
export interface PairRequest {
  id: string;
  fingerprint: string;
  /** Ed25519 public key, base64. */
  key: string;
  /** Self-reported name (sanitized to the label charset, display only). */
  name: string;
  /** 6-digit check code, derived by both ends from this handshake's session keys. */
  sas: string;
  addr?: string;
  at: string;
}

export interface PairOffer {
  v: 1;
  id: string;
  /** "code": the other side redeems a pairing code (0.7 style); "approve": it sends a request we confirm. Absent = code. */
  mode?: "code" | "approve";
  /** Period granted on success; absent (a 0.7 invitation) = permanent. */
  grant?: PeerGrant;
  request?: PairRequest;
  decision?: { request_id: string; approved: boolean };
  /** 令牌只存摘要：邀请文件泄露不等于码泄露。 */
  token_sha256: string;
  /** 兑码方配对成功后在本机的 label（发码时 --label 指定；缺省用对方自报名）。 */
  label?: string;
  created_at: string;
  expires_at: string;
  failures: number;
  status: "open" | "paired" | "burned";
  peer?: { label: string; fingerprint: string; name: string };
}

function offersDir(env: NodeJS.ProcessEnv): string {
  return join(lanDir(env), "offers");
}

export function createPairOffer(
  input: { label?: string; ttlMs?: number; mode?: "code" | "approve"; grant?: PeerGrant },
  env: NodeJS.ProcessEnv = process.env,
): { offer: PairOffer; token: Buffer } {
  ensureDir(offersDir(env));
  const token = randomBytes(PAIR_TOKEN_BYTES);
  const now = Date.now();
  const offer: PairOffer = {
    v: 1,
    id: randomUUID(),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.grant === undefined ? {} : { grant: input.grant }),
    // In approve mode the token is never shown; it only keeps the old field mandatory.
    token_sha256: tokenDigest(token),
    ...(input.label === undefined ? {} : { label: input.label }),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + (input.ttlMs ?? PAIR_OFFER_TTL_MS)).toISOString(),
    failures: 0,
    status: "open",
  };
  writePrivateJson(join(offersDir(env), `${offer.id}.json`), offer);
  return { offer, token };
}

export function loadPairOffer(id: string, env: NodeJS.ProcessEnv = process.env): PairOffer | null {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  try {
    return readPrivateJson(join(offersDir(env), `${id}.json`)) as PairOffer | null;
  } catch {
    return null;
  }
}

function listOffers(env: NodeJS.ProcessEnv): PairOffer[] {
  let files: string[];
  try {
    files = readdirSync(offersDir(env));
  } catch {
    return [];
  }
  const offers: PairOffer[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const offer = loadPairOffer(file.slice(0, -5), env);
    if (offer !== null && offer.v === 1) offers.push(offer);
  }
  return offers;
}

export function openPairOffers(env: NodeJS.ProcessEnv = process.env, now = Date.now()): PairOffer[] {
  return listOffers(env).filter((offer) => offer.status === "open" && Date.parse(offer.expires_at) > now);
}

export type RedeemResult =
  | { ok: true; offer: PairOffer; peer: LanPeer }
  | { ok: false; reason: "no-offer" | "bad-code" };

/**
 * 兑码：锁内比对令牌摘要（常数时间）。命中则在**同一把锁里**调 onHit 把对方写进信任库、
 * 再把邀请标 paired 并记下对端——发码 CLI 关闭邀请也走这把锁，所以不会出现「对方已被信任、
 * 发码方却报取消/过期」的撕裂。不中则**所有**开着的邀请各记一次失败（攻击者不知道自己在猜
 * 哪份），满 PAIR_MAX_FAILURES 作废。
 */
export function redeemPairOffer(
  token: Buffer,
  onHit: (offer: PairOffer) => LanPeer,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): RedeemResult {
  return withLock("offers", env, () => {
    // Only code invitations can be redeemed with a token; approve ones need a request + human confirmation.
    const open = openPairOffers(env, now).filter((offer) => (offer.mode ?? "code") === "code");
    if (open.length === 0) return { ok: false, reason: "no-offer" } as const;
    const digest = tokenDigest(token);
    let hit: PairOffer | null = null;
    for (const offer of open) {
      if (constantTimeHexEqual(offer.token_sha256, digest)) hit = offer;
    }
    if (hit !== null) {
      const peer = onHit(hit);
      const done: PairOffer = {
        ...hit,
        status: "paired",
        peer: { label: peer.label, fingerprint: peer.fingerprint, name: peer.name },
      };
      writePrivateJson(join(offersDir(env), `${hit.id}.json`), done);
      return { ok: true, offer: done, peer } as const;
    }
    for (const offer of open) {
      offer.failures++;
      if (offer.failures >= PAIR_MAX_FAILURES) offer.status = "burned";
      writePrivateJson(join(offersDir(env), `${offer.id}.json`), offer);
    }
    return { ok: false, reason: "bad-code" } as const;
  });
}

export function offerTerms(offer: PairOffer, now = Date.now()): PeerTerms {
  return offer.grant === undefined ? {} : grantTerms(offer.grant, now);
}

// ── approve mode: request → human confirmation ──

/** How long a request waits for the human. The daemon holds that connection meanwhile. */
export const PAIR_REQUEST_WAIT_MS = 75_000;

export type SubmitResult =
  | { ok: true; offerId: string; requestId: string }
  | { ok: false; reason: "no-offer" | "busy" };

/** Daemon got a pair-request: attach it to the open approve invitation; busy if one is already waiting. */
export function submitPairRequest(
  input: Omit<PairRequest, "id" | "at">,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): SubmitResult {
  return withLock("offers", env, () => {
    const offer = openPairOffers(env, now)
      .filter((o) => o.mode === "approve")
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (offer === undefined) return { ok: false, reason: "no-offer" } as const;
    if (offer.request !== undefined && now - Date.parse(offer.request.at) < PAIR_REQUEST_WAIT_MS + 5_000) {
      return { ok: false, reason: "busy" } as const;
    }
    const request: PairRequest = { ...input, id: randomUUID(), at: new Date(now).toISOString() };
    const { decision: _d, ...rest } = offer;
    writePrivateJson(join(offersDir(env), `${offer.id}.json`), { ...rest, request });
    return { ok: true, offerId: offer.id, requestId: request.id } as const;
  });
}

/** The inviting human (or `ocs lan approve <code>`) decides. False if withdrawn or already decided. */
export function decidePairRequest(
  offerId: string,
  requestId: string,
  approved: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return withLock("offers", env, () => {
    const offer = loadPairOffer(offerId, env);
    if (offer === null || offer.status !== "open" || offer.request?.id !== requestId || offer.decision !== undefined) return false;
    writePrivateJson(join(offersDir(env), `${offerId}.json`), { ...offer, decision: { request_id: requestId, approved } });
    return true;
  });
}

export type SettleResult =
  | { state: "approved"; offer: PairOffer; peer: LanPeer }
  | { state: "rejected" | "pending" | "timeout" | "gone" };

/**
 * Daemon polls for the outcome. On approval it writes the trust store and marks the invitation
 * paired under the **same lock** (as redeeming does, so the inviting CLI closing the offer cannot
 * tear it). Refusal or `giveUp` detaches the request and leaves the invitation open for the next.
 * If the human decided just before `giveUp`, the decision wins over the timeout.
 */
export function settlePairRequest(
  offerId: string,
  requestId: string,
  onApprove: (offer: PairOffer, request: PairRequest) => LanPeer,
  giveUp: boolean,
  env: NodeJS.ProcessEnv = process.env,
): SettleResult {
  return withLock("offers", env, () => {
    const offer = loadPairOffer(offerId, env);
    if (offer === null || offer.request?.id !== requestId) return { state: "gone" } as const;
    const path = join(offersDir(env), `${offerId}.json`);
    const { request: _r, decision: _d, ...rest } = offer;
    if (offer.decision?.request_id === requestId && offer.decision.approved && offer.status === "open") {
      const peer = onApprove(offer, offer.request);
      const done: PairOffer = { ...offer, status: "paired", peer: { label: peer.label, fingerprint: peer.fingerprint, name: peer.name } };
      writePrivateJson(path, done);
      return { state: "approved", offer: done, peer } as const;
    }
    if (offer.decision?.request_id === requestId) {
      writePrivateJson(path, rest);
      return { state: "rejected" } as const;
    }
    if (giveUp || offer.status !== "open" || Date.parse(offer.expires_at) <= Date.now()) {
      if (offer.status === "open") writePrivateJson(path, rest);
      return { state: "timeout" } as const;
    }
    return { state: "pending" } as const;
  });
}

/** 发码 CLI 退出时（成功、过期、作废、取消）在锁内删掉邀请，返回删之前的最终状态。 */
export function closePairOffer(id: string, env: NodeJS.ProcessEnv = process.env): PairOffer | null {
  return withLock("offers", env, () => {
    const offer = loadPairOffer(id, env);
    try {
      unlinkSync(join(offersDir(env), `${id}.json`));
    } catch {
      // 已不存在
    }
    return offer;
  });
}

// ───────────────────────── 守护进程运行态 ─────────────────────────

export interface LanDaemonState {
  pid: number;
  port: number;
  bind: string;
  name: string;
  fingerprint: string;
  discover: boolean;
  version: string;
  started_at: string;
}

export function daemonStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(lanDir(env), "daemon.json");
}

export function daemonLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(lanDir(env), "daemon.log");
}

export function writeDaemonState(state: LanDaemonState, env: NodeJS.ProcessEnv = process.env): void {
  ensureDir(lanDir(env));
  writePrivateJson(daemonStatePath(env), state);
}

export function clearDaemonState(pid: number, env: NodeJS.ProcessEnv = process.env): void {
  const state = readDaemonState(env);
  if (state !== null && state.pid !== pid) return; // 别的实例的状态，不许删
  try {
    unlinkSync(daemonStatePath(env));
  } catch {
    // 不存在
  }
}

export function readDaemonState(env: NodeJS.ProcessEnv = process.env): LanDaemonState | null {
  try {
    const raw = readPrivateJson(daemonStatePath(env)) as LanDaemonState | null;
    return raw !== null && Number.isInteger(raw.pid) ? raw : null;
  } catch {
    return null;
  }
}

/** 运行态文件里的 pid 还活着吗（ESRCH 以外的错误——如 EPERM——当活着处理）。 */
export function liveDaemonState(env: NodeJS.ProcessEnv = process.env): LanDaemonState | null {
  const state = readDaemonState(env);
  if (state === null) return null;
  try {
    process.kill(state.pid, 0);
    return state;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? null : state;
  }
}
