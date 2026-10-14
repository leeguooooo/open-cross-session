// `ocs lan …`、`ocs dm <地址>@<对端>`、`ocs who --lan` 的命令实现。
// cli.ts 只负责参数解析和分派；这里的输出一律走 i18n-lan 目录。

import { spawnSync } from "node:child_process";
import { spawnDetached } from "./detach.ts";
import { readFileSync } from "node:fs";
import type { Lang } from "./i18n.ts";
import { lanMessages } from "./i18n-lan.ts";
import { encodePairingCode, fingerprintDigest, formatSas, shortFingerprint, type LanIdentity } from "./lan-crypto.ts";
import { lanChannel, LAN_DAEMON_COMMAND, LAN_DAEMON_ENV_STRIP } from "./lan-daemon.ts";
import { autostartPlan, autostartState, disableAutostart, enableAutostart } from "./lan-autostart.ts";
import { localIpv4Addresses, scanLan } from "./lan-discovery.ts";
import { LanClientError, pairByRequest, pairWithCode, PAIR_TARGET_RE, remoteWho, sendRemoteDm } from "./lan-client.ts";
import {
  activePeers,
  clearDaemonState,
  createPairOffer,
  decidePairRequest,
  DEFAULT_PEER_GRANT,
  grantTerms,
  peerActive,
  pruneExpiredPeers,
  setPeerTerms,
  type PairOffer,
  type PeerGrant,
  type PeerTerms,
  daemonLogPath,
  closePairOffer,
  findPeer,
  liveDaemonState,
  listPeers,
  loadLanConfig,
  loadOrCreateIdentity,
  loadPairOffer,
  openPairOffers,
  PAIR_OFFER_TTL_MS,
  PEER_LABEL_RE,
  removePeer,
  saveLanConfig,
  LanStateError,
  type LanPeer,
} from "./lan-store.ts";
import { appendMessage, NAME_RE } from "./store.ts";

export interface LanCliContext {
  lang: Lang;
  version: string;
  positional: string[];
  flags: Map<string, string | true>;
  fail(message: string): never;
  /** 已落盘但唤醒失败（2）/ 结果未知（3）。 */
  markStored(outcome: "failed" | "unknown"): void;
  recordRemote?(result: { stored: boolean | null; channel?: string; seq?: number;
    wake?: "accepted" | "deferred" | "parked" | "skipped" | "failed" | "unknown" }): void;
  /** 本机发起命令（cli.ts 的 selfCommand 同款）：[bun, cli.ts] 或 [编译后的二进制]。 */
  selfCommand: string[];
}

function flagString(ctx: LanCliContext, name: string): string | undefined {
  const value = ctx.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function guarded<T>(ctx: LanCliContext, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof LanStateError) ctx.fail(lanMessages(ctx.lang).stateError(error.message));
    throw error;
  }
}

function identity(ctx: LanCliContext): LanIdentity {
  return guarded(ctx, () => loadOrCreateIdentity());
}

function requirePeer(ctx: LanCliContext, query: string, options: { allowExpired?: boolean } = {}): LanPeer {
  const peer = guarded(ctx, () => findPeer(query));
  if (peer === null) ctx.fail(lanMessages(ctx.lang).peerNotFound(query));
  if (options.allowExpired !== true && !peerActive(peer)) ctx.fail(lanMessages(ctx.lang).peerExpired(peer.label));
  return peer;
}

const DURATION_RE = /^(\d{1,4})(m|h|d)$/;
const DURATION_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * Trust period flags shared by `pair`, `join`-less issuing and `trust`:
 * --forever | [--once] [--for <30m|8h|7d>]. Nothing given → `fallback`
 * (8 hours for pairing); `null` fallback means "a flag is required".
 */
function parseGrant(ctx: LanCliContext, fallback: PeerGrant | null): PeerGrant {
  const L = lanMessages(ctx.lang);
  const forever = ctx.flags.has("forever");
  const once = ctx.flags.has("once");
  const forValue = flagString(ctx, "for");
  if (forever && (once || forValue !== undefined)) ctx.fail(L.grantConflict);
  if (forever) return { ttl_ms: null, uses: null };
  let ttl: number | null = null;
  if (forValue !== undefined) {
    const match = DURATION_RE.exec(forValue);
    const ms = match === null ? 0 : Number(match[1]) * DURATION_UNIT_MS[match[2] as keyof typeof DURATION_UNIT_MS];
    if (ms < 60_000 || ms > 366 * 86_400_000) ctx.fail(L.badDuration(forValue));
    ttl = ms;
  }
  if (!once && ttl === null) {
    if (fallback === null) ctx.fail(L.trustUsage);
    return fallback;
  }
  return { ttl_ms: ttl ?? DEFAULT_PEER_GRANT.ttl_ms, uses: once ? 1 : null };
}

/** "valid for 8h (until 10-07 18:30), 1 message" / "permanent". */
function describeTerms(lang: Lang, terms: PeerTerms, now = Date.now()): string {
  const L = lanMessages(lang);
  const parts: string[] = [];
  if (terms.expires_at !== undefined) {
    const at = new Date(terms.expires_at);
    const left = Math.max(0, at.getTime() - now);
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    const span = left >= 86_400_000 ? `${Math.round(left / 86_400_000)}d`
      : left >= 3_600_000 ? `${Math.round(left / 3_600_000)}h`
      : `${Math.max(1, Math.round(left / 60_000))}m`;
    parts.push(L.termsUntil(span, stamp));
  }
  if (terms.uses_left !== undefined) parts.push(L.termsUses(terms.uses_left));
  return parts.length === 0 ? L.termsForever : parts.join(L.termsJoin);
}

function describeGrant(lang: Lang, grant: PeerGrant): string {
  return describeTerms(lang, grantTerms(grant));
}

function describeClientError(ctx: LanCliContext, peer: string, error: unknown): string {
  const L = lanMessages(ctx.lang);
  if (error instanceof LanClientError && error.mismatches.length > 0) {
    return L.keyMismatch(peer, error.mismatches.join(", "));
  }
  return L.offline(peer, error instanceof Error ? error.message : String(error));
}

// ───────────────────────── 守护进程生命周期 ─────────────────────────

async function lanUp(ctx: LanCliContext): Promise<void> {
  const L = lanMessages(ctx.lang);
  const running = liveDaemonState();
  if (running !== null) {
    console.log(L.upAlready(running.pid, running.port));
    return;
  }
  const config = guarded(ctx, () => loadLanConfig());
  const port = flagString(ctx, "port");
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) ctx.fail(L.badPort(port));
    config.port = n;
  }
  const bind = flagString(ctx, "bind");
  if (bind !== undefined) config.bind = bind;
  const name = flagString(ctx, "name");
  if (name !== undefined) {
    if (!PEER_LABEL_RE.test(name)) ctx.fail(L.badLabel(name));
    config.name = name;
  }
  if (ctx.flags.has("no-discover")) config.discover = false;
  if (ctx.flags.has("discover")) config.discover = true;
  saveLanConfig(config);
  const id = identity(ctx); // 首次在前台生成身份：权限问题在这里报，而不是让守护进程静默退出
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of LAN_DAEMON_ENV_STRIP) delete env[key];
  const [cmd, ...args] = ctx.selfCommand;
  const child = spawnDetached(cmd!, [...args, LAN_DAEMON_COMMAND], { stdio: "ignore", env, windowsHide: true });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = liveDaemonState();
    if (state !== null && state.pid === child.pid) {
      console.log(L.upStarted(state.name, state.port, shortFingerprint(id.fingerprint), state.discover));
      if (process.platform === "darwin" && !state.bind.startsWith("127.")) {
        const firewall = allowThroughMacFirewall(ctx.selfCommand);
        if (firewall === "failed") console.log(L.upFirewallHint);
        else if (firewall === "allowed") console.log(L.upFirewallAllowed);
      }
      return;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let tail = "";
  try {
    tail = readFileSync(daemonLogPath(), "utf8").trim().split("\n").slice(-3).join("\n");
  } catch {
    // 没日志
  }
  ctx.fail(L.upFailed(tail === "" ? "no state written within 5s" : tail));
}

/**
 * macOS 应用防火墙开着时，没登记过的二进制收不到局域网连接——而且不报错：对端只看到
 * 「连不上」，本机日志里什么都没有（2026-09-29 真机：换到正式安装路径后就是这样）。
 * 放行规则按程序路径记，换位置、每次升级（ad-hoc 签名的 cdhash 会变）都得重登。
 * `socketfilterfw --add/--unblockapp` 对当前用户自己的程序不需要 sudo，只登记 ocs 本身。
 */
function allowThroughMacFirewall(selfCommand: readonly string[]): "allowed" | "off" | "failed" | "skipped" {
  // 源码方式跑（bun + cli.ts）时要放行的是 bun 本身，不替用户做这个决定。
  if (selfCommand.length !== 1) return "skipped";
  const fw = "/usr/libexec/ApplicationFirewall/socketfilterfw";
  const state = spawnSync(fw, ["--getglobalstate"], { encoding: "utf8" });
  if (state.status !== 0 || typeof state.stdout !== "string") return "failed";
  if (!/enabled/i.test(state.stdout)) return "off";
  const exe = selfCommand[0]!;
  spawnSync(fw, ["--add", exe], { stdio: "ignore" });
  spawnSync(fw, ["--unblockapp", exe], { stdio: "ignore" });
  const apps = spawnSync(fw, ["--listapps"], { encoding: "utf8" });
  const text = typeof apps.stdout === "string" ? apps.stdout : "";
  const at = text.indexOf(`${exe} `) >= 0 ? text.indexOf(`${exe} `) : text.indexOf(`${exe}\n`);
  return at >= 0 && /Allow incoming connections/.test(text.slice(at, at + exe.length + 80)) ? "allowed" : "failed";
}

/** 目标 pid 的命令行里要有 `_lan-daemon`：pid 复用时绝不能把别的进程杀掉。 */
function isLanDaemonPid(pid: number): boolean {
  if (process.platform === "win32") {
    // tasklist 只给映像名：要求它就是当前这个 ocs 可执行文件（守护进程由它自己拉起）。
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8", windowsHide: true });
    const image = process.execPath.split(/[\\/]/).pop()!.toLowerCase();
    return typeof out.stdout === "string" && out.stdout.toLowerCase().includes(`"${image}"`);
  }
  const out = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return typeof out.stdout === "string" && out.stdout.includes(LAN_DAEMON_COMMAND);
}

async function lanDown(ctx: LanCliContext): Promise<void> {
  const L = lanMessages(ctx.lang);
  const state = liveDaemonState();
  if (state === null) {
    console.log(L.downNotRunning);
    return;
  }
  if (!isLanDaemonPid(state.pid)) {
    clearDaemonState(state.pid);
    console.log(L.downNotOurs(state.pid));
    return;
  }
  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && liveDaemonState() !== null) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(L.downDone(state.pid));
}

function lanStatus(ctx: LanCliContext): void {
  const L = lanMessages(ctx.lang);
  const state = liveDaemonState();
  const id = identity(ctx);
  const peers = guarded(ctx, () => activePeers());
  const offers = openPairOffers();
  if (ctx.flags.has("json")) {
    console.log(JSON.stringify({
      running: state !== null,
      daemon: state,
      fingerprint: id.fingerprint,
      peers: peers.map((p) => ({ label: p.label, name: p.name, fingerprint: p.fingerprint, addrs: p.addrs, last_seen: p.last_seen ?? null, expires_at: p.expires_at ?? null, uses_left: p.uses_left ?? null })),
      open_pairing_codes: offers.length,
    }, null, 2));
    return;
  }
  console.log(state === null
    ? L.statusStopped
    : L.statusRunning({ pid: state.pid, name: state.name, bind: state.bind, port: state.port, discover: state.discover, version: state.version, started: state.started_at }));
  console.log(L.statusIdentity(id.fingerprint));
  console.log(L.statusPeers(peers.length));
  if (offers.length > 0) console.log(L.statusOffers(offers.length));
  const plan = autostartPlan(process.platform, ctx.selfCommand);
  if (plan !== null) console.log(L.statusAutostart(autostartState(plan)));
}

function lanPeers(ctx: LanCliContext): void {
  const L = lanMessages(ctx.lang);
  const gone = guarded(ctx, () => pruneExpiredPeers());
  const peers = guarded(ctx, () => listPeers());
  if (ctx.flags.has("json")) {
    console.log(JSON.stringify(peers.map(({ key: _key, ...rest }) => rest), null, 2));
    return;
  }
  if (gone.length > 0) console.log(L.peersPruned(gone.map((p) => p.label).join(", ")));
  if (peers.length === 0) {
    console.log(L.peersNone);
    return;
  }
  for (const p of peers) {
    console.log(L.peerLine(p.label, p.name, shortFingerprint(p.fingerprint), p.addrs[0] ?? "?", p.last_seen ?? "?", describeTerms(ctx.lang, p)));
  }
}

/** `ocs lan trust <peer> --once|--for <d>|--forever`: change how long *this* machine trusts it. */
function lanTrust(ctx: LanCliContext, query: string): void {
  const L = lanMessages(ctx.lang);
  const peer = requirePeer(ctx, query, { allowExpired: true });
  const grant = parseGrant(ctx, null);
  const updated = guarded(ctx, () => setPeerTerms(peer.fingerprint, grantTerms(grant)));
  if (updated === null) ctx.fail(L.peerNotFound(query));
  console.log(L.trustUpdated(updated.label, describeTerms(ctx.lang, updated)));
  console.log(L.trustLocalOnly);
}

// ───────────────────────── 配对 ─────────────────────────

async function lanPairIssue(ctx: LanCliContext): Promise<void> {
  const L = lanMessages(ctx.lang);
  const state = liveDaemonState();
  if (state === null) ctx.fail(L.pairNeedsDaemon);
  const label = flagString(ctx, "label");
  if (label !== undefined && !PEER_LABEL_RE.test(label)) ctx.fail(L.badLabel(label));
  const grant = parseGrant(ctx, DEFAULT_PEER_GRANT);
  const mode = ctx.flags.has("code") ? "code" : "approve";
  const id = identity(ctx);
  const { offer, token } = createPairOffer({ ...(label === undefined ? {} : { label }), mode, grant });
  const minutes = Math.round(PAIR_OFFER_TTL_MS / 60000);
  // Link-local (169.254/16) addresses are self-assigned on idle NICs and only add noise
  // to the copied text; discovery still finds the machine if none of the rest work.
  const addrs = localIpv4Addresses().filter((ip) => !ip.startsWith("169.254.")).map((ip) => `${ip}:${state.port}`);
  if (mode === "code") {
    const code = encodePairingCode(fingerprintDigest(id.publicKey), token);
    console.log(L.pairIssued(code, minutes));
    if (addrs.length > 0) console.log(L.pairAddrHint(addrs.join(", ")));
    console.log(L.pairTermsLine(describeGrant(ctx.lang, grant)));
  } else {
    // The copyable text pins this machine's key (100-bit fingerprint prefix), so
    // whoever runs it cannot be steered to an impostor; this side then checks the
    // requester through the 6-digit code before trusting it.
    console.log(L.pairInvite({
      name: state.name,
      target: id.fingerprint.slice(0, 20),
      addrs,
      terms: describeGrant(ctx.lang, grant),
      minutes,
    }));
  }
  console.log(mode === "code" ? L.pairWaiting : L.pairWaitingRequest);
  await waitForOffer(ctx, offer);
}

/**
 * Block until the offer is redeemed, expires, is burned or cancelled. In approve
 * mode, every incoming request is shown with its 6-digit code; on a TTY we ask
 * y/N inline, otherwise the user (or an agent) answers with `ocs lan approve <code>`.
 */
async function waitForOffer(ctx: LanCliContext, offer: PairOffer): Promise<void> {
  const L = lanMessages(ctx.lang);
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  let cancelled = false;
  const cancel: NodeJS.SignalsListener = () => {
    cancelled = true;
  };
  // Closing the terminal (SIGHUP) must void the offer too, or it stays live until expiry.
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.once(signal, cancel);
  let final: ReturnType<typeof closePairOffer> = null;
  let stop: "cancelled" | "expired" | "burned" | "paired" = "expired";
  let shown: string | null = null;
  let prompt: { requestId: string; abort: () => void } | null = null;
  try {
    for (;;) {
      const current = loadPairOffer(offer.id);
      if (current?.status === "paired") {
        stop = "paired";
        break;
      }
      if (cancelled) {
        stop = "cancelled";
        break;
      }
      if (current?.status === "burned") {
        stop = "burned";
        break;
      }
      if (current === null || Date.parse(current.expires_at) <= Date.now()) break;
      const request = current.request;
      if (prompt !== null && request?.id !== prompt.requestId) {
        prompt.abort();
        prompt = null;
        console.log(L.pairRequestWithdrawn);
      }
      if (request !== undefined && current.decision === undefined && request.id !== shown) {
        shown = request.id;
        console.log(L.pairRequestShown(request.name, request.addr ?? "?", formatSas(request.sas), shortFingerprint(request.fingerprint)));
        if (interactive) {
          const requestId: string = request.id;
          const asked = askYesNo(L.pairAskConfirm);
          prompt = { requestId, abort: asked.abort };
          void asked.answer.then((yes) => {
            if (prompt?.requestId !== requestId) return;
            prompt = null;
            if (yes === null) return;
            if (!decidePairRequest(offer.id, requestId, yes)) console.log(L.pairRequestWithdrawn);
            else if (!yes) console.log(L.pairRequestRejected);
          });
        } else {
          console.log(L.pairApproveHint(request.sas));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    prompt?.abort();
    for (const signal of signals) (process as NodeJS.EventEmitter).removeListener(signal, cancel);
    // Close under the lock and read the final state: redeem/settle and close are
    // mutually exclusive, so a pairing that lands at the last moment is reported as such.
    final = closePairOffer(offer.id);
  }
  if (final?.status === "paired" && final.peer !== undefined) {
    console.log(L.pairIssuerDone(final.peer.label, final.peer.name, shortFingerprint(final.peer.fingerprint)));
    const peer = findPeer(final.peer.label);
    if (peer !== null) console.log(L.pairTermsLine(describeTerms(ctx.lang, peer)));
    return;
  }
  if (stop === "cancelled") {
    console.log(L.pairCancelled);
    process.exitCode = 130;
    return;
  }
  ctx.fail(stop === "burned" ? L.pairBurned : L.pairExpired);
}

/**
 * One-line y/N question that can be withdrawn (the request timed out on the daemon side).
 * Reads stdin in the terminal's cooked mode instead of using node:readline: under Bun,
 * closing a readline interface on a TTY blocks the event loop, which froze the approval.
 * In cooked mode Ctrl+C still raises SIGINT, so the offer's own signal handler cancels it.
 */
function askYesNo(question: string): { answer: Promise<boolean | null>; abort: () => void } {
  let settle: (value: boolean | null) => void = () => {};
  const answer = new Promise<boolean | null>((resolve) => {
    settle = resolve;
  });
  let buffer = "";
  let done = false;
  const finish = (value: boolean | null) => {
    if (done) return;
    done = true;
    process.stdin.off("data", onData);
    process.stdin.pause();
    settle(value);
  };
  const onData = (chunk: string | Buffer) => {
    buffer += chunk.toString();
    const nl = buffer.indexOf("\n");
    if (nl >= 0) finish(/^\s*y(es)?\s*$/i.test(buffer.slice(0, nl)));
  };
  process.stdout.write(question);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);
  process.stdin.resume();
  return { answer, abort: () => finish(null) };
}

/** `ocs lan approve <code>` / `ocs lan reject`: answer a pending request without a TTY. */
function lanDecide(ctx: LanCliContext, approve: boolean, given: string): void {
  const L = lanMessages(ctx.lang);
  const pending = openPairOffers().filter((o) => o.mode === "approve" && o.request !== undefined && o.decision === undefined);
  if (pending.length === 0) ctx.fail(L.decideNone);
  const digits = given.replace(/\s+/g, "");
  const offer = approve ? pending.find((o) => o.request!.sas === digits) : pending[0]!;
  if (offer === undefined) ctx.fail(L.approveMismatch(given));
  if (!decidePairRequest(offer.id, offer.request!.id, approve)) ctx.fail(L.pairRequestWithdrawn);
  console.log(approve ? L.approveDone(offer.request!.name) : L.pairRequestRejected);
}

async function lanPairJoin(ctx: LanCliContext, code: string): Promise<void> {
  const L = lanMessages(ctx.lang);
  const label = flagString(ctx, "label");
  if (label !== undefined && !PEER_LABEL_RE.test(label)) ctx.fail(L.badLabel(label));
  const addr = flagString(ctx, "addr");
  try {
    const { peer, addr: used } = await pairWithCode(code, identity(ctx), {
      ...(addr === undefined ? {} : { addr }),
      ...(label === undefined ? {} : { label }),
    });
    console.log(L.pairJoined(peer.label, peer.name, shortFingerprint(peer.fingerprint), used));
    console.log(L.pairTermsLine(describeTerms(ctx.lang, peer)));
    console.log(L.pairCheckFingerprint);
  } catch (error) {
    if (error instanceof LanClientError) {
      ctx.fail(error.mismatches.length > 0
        ? L.pairFailed(error.code, L.keyMismatch("the code's issuer", error.mismatches.join(", ")))
        : L.pairFailed(error.code, error.message));
    }
    ctx.fail(L.pairFailed("error", error instanceof Error ? error.message : String(error)));
  }
}

/** `ocs lan join <key-prefix> [--addr a,b]`: the command inside the copied pairing text. */
async function lanJoin(ctx: LanCliContext, target: string): Promise<void> {
  const L = lanMessages(ctx.lang);
  if (!PAIR_TARGET_RE.test(target.toLowerCase())) ctx.fail(L.joinBadTarget(target));
  const label = flagString(ctx, "label");
  if (label !== undefined && !PEER_LABEL_RE.test(label)) ctx.fail(L.badLabel(label));
  const addrs = (flagString(ctx, "addr") ?? "").split(",").map((a) => a.trim()).filter((a) => a !== "");
  if (liveDaemonState() === null) console.log(L.joinDaemonHint);
  try {
    const { peer, addr: used } = await pairByRequest(target, identity(ctx), {
      addrs,
      ...(label === undefined ? {} : { label }),
      onSas: (sas, serverName) => console.log(L.joinShowSas(serverName, formatSas(sas))),
    });
    console.log(L.pairJoined(peer.label, peer.name, shortFingerprint(peer.fingerprint), used));
    console.log(L.pairTermsLine(describeTerms(ctx.lang, peer)));
  } catch (error) {
    if (error instanceof LanClientError) {
      ctx.fail(error.mismatches.length > 0
        ? L.pairFailed(error.code, L.keyMismatch(target, error.mismatches.join(", ")))
        : L.pairFailed(error.code, L.joinErrorHint(error.code) ?? error.message));
    }
    ctx.fail(L.pairFailed("error", error instanceof Error ? error.message : String(error)));
  }
}

// ───────────────────────── 发现 / 花名册 / 解除 ─────────────────────────

async function lanScan(ctx: LanCliContext): Promise<void> {
  const L = lanMessages(ctx.lang);
  const own = identity(ctx).fingerprint;
  const peers = guarded(ctx, () => listPeers());
  const found = (await scanLan({ timeoutMs: 2000 })).filter((i) => i.fingerprint !== own);
  if (ctx.flags.has("json")) {
    console.log(JSON.stringify(found.map((i) => ({
      ...i,
      paired_as: peers.find((p) => p.fingerprint === i.fingerprint)?.label ?? null,
    })), null, 2));
    return;
  }
  if (found.length === 0) {
    console.log(L.scanNone);
    return;
  }
  for (const i of found) {
    const label = peers.find((p) => p.fingerprint === i.fingerprint)?.label ?? null;
    console.log(L.scanLine(i.name, shortFingerprint(i.fingerprint), i.host, i.port, label));
  }
}

function lanUnpair(ctx: LanCliContext, query: string): void {
  const peer = requirePeer(ctx, query, { allowExpired: true });
  removePeer(peer.fingerprint);
  console.log(lanMessages(ctx.lang).unpaired(peer.label));
}

export async function lanWhoJson() {
  const peers = activePeers();
  if (peers.length === 0) return [];
  const id = loadOrCreateIdentity();
  return Promise.all(peers.map(async (peer) => {
    try {
      const who = await remoteWho(peer, id);
      return { peer: peer.label, name: who.name, entries: who.entries.map((entry) => ({
        ...entry, address: `${entry.address}@${peer.label}` })) };
    } catch { return { peer: peer.label, error: "unavailable" }; }
  }));
}

/** `ocs lan who [peer]` 和 `ocs who --lan` 共用：并发查每个对端，离线的单独一行。 */
export async function printLanWho(ctx: Pick<LanCliContext, "lang" | "fail"> & { flags?: Map<string, string | true> }, only?: LanPeer): Promise<void> {
  const L = lanMessages(ctx.lang);
  let peers: LanPeer[];
  try {
    peers = only === undefined ? activePeers() : [only];
  } catch (error) {
    ctx.fail(L.stateError(error instanceof Error ? error.message : String(error)));
  }
  if (peers.length === 0) {
    console.log(ctx.flags?.has("json") ? JSON.stringify({ v: 1, peers: [] }) : L.whoNoPeers);
    return;
  }
  const id = loadOrCreateIdentity();
  const results = await Promise.all(peers.map(async (peer) => {
    try {
      return { peer, who: await remoteWho(peer, id) };
    } catch (error) {
      return { peer, error };
    }
  }));
  if (ctx.flags?.has("json")) {
    console.log(JSON.stringify({ v: 1, peers: results.map((result) => "error" in result
      ? { peer: result.peer.label, error: "unavailable" }
      : { peer: result.peer.label, name: result.who.name, entries: result.who.entries.map((entry) => ({
          ...entry, address: `${entry.address}@${result.peer.label}` })) }) }));
    return;
  }
  for (const result of results) {
    if ("error" in result) {
      const e = result.error;
      console.log(e instanceof LanClientError && e.mismatches.length > 0
        ? L.keyMismatch(result.peer.label, e.mismatches.join(", "))
        : L.whoOffline(result.peer.label, e instanceof Error ? e.message : String(e)));
      continue;
    }
    console.log(L.whoHeader(result.peer.label, result.who.name));
    if (result.who.entries.length === 0) console.log(L.whoEmpty);
    for (const e of result.who.entries) {
      console.log(L.whoEntry(`${e.address}@${result.peer.label}`, e.kind, e.status ?? "", e.label ?? ""));
    }
  }
}

/** `ocs doctor` 的局域网一节：没开时给入口，开着时报对端数和自启。 */
export function doctorLanSection(
  lang: Lang,
  selfCommand: readonly string[],
  report: { ok(line: string): void; warn(line: string): void; info(line: string): void; bad(line: string): void },
): void {
  const L = lanMessages(lang);
  console.log(L.doctorHeader);
  let peers: number;
  try {
    peers = activePeers().length;
  } catch (error) {
    report.bad(L.stateError(error instanceof Error ? error.message : String(error)));
    return;
  }
  const state = liveDaemonState();
  if (state === null) {
    report.info(peers > 0 ? `${L.statusStopped}` : L.doctorOff);
    return;
  }
  report.ok(L.doctorRunning(state.name, state.port, peers));
  if (peers === 0) report.info(L.doctorNoPeers);
  const plan = autostartPlan(process.platform, selfCommand);
  if (plan !== null && autostartState(plan) !== "on") report.warn(L.doctorAutostartOff);
}

export function lanPeerCount(): number {
  try {
    return activePeers().length;
  } catch {
    return 0;
  }
}

// ───────────────────────── 跨机 DM ─────────────────────────

export interface LanDmSender {
  /** 对方回复用的地址（ocs 名字 > 短 id > 发送者名）。 */
  display: string;
  /** 频道派生用（短 id > 发送者名）。 */
  key: string;
  /** 本机副本的 from（频道日志里的名字）。 */
  logFrom: string;
  /** 本机副本的 from_identity（inbox 归属用）；null 时不写 route。 */
  identity: string | null;
}

export function splitRemoteAddress(target: string): { address: string; peer: string } | null {
  const at = target.lastIndexOf("@");
  if (at <= 0 || at === target.length - 1) return null;
  const address = target.slice(0, at);
  const peer = target.slice(at + 1).toLowerCase();
  if (!NAME_RE.test(address)) return null;
  if (!PEER_LABEL_RE.test(peer) && !/^[a-z2-7]{8,52}$/.test(peer)) return null;
  return { address, peer };
}

export async function lanDm(ctx: LanCliContext, target: string, body: string, sender: LanDmSender): Promise<void> {
  const L = lanMessages(ctx.lang);
  const parsed = splitRemoteAddress(target);
  if (parsed === null) ctx.fail(L.dmAddressInvalid(target));
  const peer = requirePeer(ctx, parsed.peer);
  let result: Awaited<ReturnType<typeof sendRemoteDm>>;
  try {
    result = await sendRemoteDm(peer, identity(ctx), {
      from: sender.display,
      from_key: sender.key,
      to: parsed.address,
      body,
      lang: ctx.lang,
      noWake: ctx.flags.has("no-wake"),
    });
  } catch (error) {
    ctx.fail(describeClientError(ctx, peer.label, error));
  }
  if (result.delivered === "unknown") {
    ctx.recordRemote?.({ stored: null, wake: "unknown" });
    console.log(L.dmUnknown(peer.label, result.detail));
    ctx.markStored("unknown");
    return;
  }
  const reply = result.reply;
  if (!reply.ok) {
    ctx.fail(L.dmRefused(target, reply.error, reply.detail ?? ""));
  }
  ctx.recordRemote?.({ stored: true, channel: reply.channel, seq: reply.seq,
    wake: reply.wake ?? (reply.outcome === "ok" ? "accepted" : reply.outcome) });
  const remoteTarget = `${reply.to_display}@${peer.label}`;
  console.log(L.dmSent(remoteTarget, reply.channel, reply.seq));
  for (const line of reply.lines) console.log(L.dmRemoteLine(peer.label, line));
  if (reply.outcome !== "ok") ctx.markStored(reply.outcome);
  // 本机副本：远端确认落盘后才写，频道与对方回信落在同一个 lan-* 频道（两边同样的派生规则）。
  try {
    const channel = lanChannel(peer.fingerprint, sender.key, reply.to_key);
    const toIdentity = `lan:${peer.fingerprint}:${reply.to_key}`;
    const copy = appendMessage({
      channel,
      from: sender.logFrom,
      ...(sender.identity === null || !NAME_RE.test(reply.to_key) ? {} : { from_identity: sender.identity, to_identity: toIdentity }),
      body,
    });
    console.log(L.dmLocalCopy(channel, copy.seq));
  } catch (error) {
    console.log(L.dmLocalCopyFailed(error instanceof Error ? error.message : String(error)));
  }
}

// ───────────────────────── 分派 ─────────────────────────

export async function cmdLan(ctx: LanCliContext): Promise<void> {
  const L = lanMessages(ctx.lang);
  const [sub, arg, ...extra] = ctx.positional;
  // `ocs lan approve 482 913` — the code may be typed with its space.
  if (sub === "approve") {
    if (arg === undefined) ctx.fail(L.usage);
    return lanDecide(ctx, true, [arg, ...extra].join(""));
  }
  if (extra.length > 0) ctx.fail(L.usage);
  switch (sub) {
    case "reject":
      return lanDecide(ctx, false, "");
    case "join":
      if (arg === undefined) ctx.fail(L.usage);
      return lanJoin(ctx, arg);
    case "trust":
      if (arg === undefined) ctx.fail(L.usage);
      return lanTrust(ctx, arg);
    case "up":
      return lanUp(ctx);
    case "down":
      return lanDown(ctx);
    case "status":
    case undefined:
      return lanStatus(ctx);
    case "peers":
      return lanPeers(ctx);
    case "pair":
      return arg === undefined ? lanPairIssue(ctx) : lanPairJoin(ctx, arg);
    case "scan":
      return lanScan(ctx);
    case "unpair":
      if (arg === undefined) ctx.fail(L.usage);
      return lanUnpair(ctx, arg);
    case "who":
      return printLanWho(ctx, arg === undefined ? undefined : requirePeer(ctx, arg));
    case "autostart": {
      if (arg !== "on" && arg !== "off") ctx.fail(L.usage);
      const plan = autostartPlan(process.platform, ctx.selfCommand);
      if (plan === null) ctx.fail(L.autostartUnsupported);
      if (arg === "on") console.log(L.autostartOn(enableAutostart(plan)));
      else console.log(L.autostartOff(disableAutostart(plan)));
      return;
    }
    default:
      ctx.fail(L.usage);
  }
}

