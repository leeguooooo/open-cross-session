import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inject.ts";
import { encodePairingCode, fingerprintDigest, generateIdentity, type LanIdentity } from "../src/lan-crypto.ts";
import { handleLanPairRequest, startLanServer, type LanServerHandle } from "../src/lan-daemon.ts";
import { LanClientError, pairByRequest, pairWithCode, replyTerms, sendRemoteDm } from "../src/lan-client.ts";
import {
  createPairOffer,
  decidePairRequest,
  findPeer,
  findPeerByFingerprint,
  listPeers,
  loadOrCreateIdentity,
  loadPairOffer,
  peerActive,
  redeemPairOffer,
  saveLanConfig,
  setPeerTerms,
  submitPairRequest,
  trustPeer,
} from "../src/lan-store.ts";
import { connectSecure } from "../src/lan-wire.ts";
import { OCS_HOME_ENV } from "../src/store.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

const T = 30_000;
const HOUR = 3_600_000;

interface Machine {
  env: NodeJS.ProcessEnv;
  identity: LanIdentity;
  sessionsDir: string;
}

function machine(name: string): Machine {
  const dir = tempDir(`ocs-lantrust-${name}-`);
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { mode: 0o700 });
  const env = { ...process.env } as Record<string, string>;
  for (const key of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CODEX_THREAD_ID", "OCS_NAME", "OCS_PI_SESSION_ID"]) {
    delete env[key];
  }
  Object.assign(env, {
    OCS_LANG: "en",
    [OCS_HOME_ENV]: join(dir, "home"),
    [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir,
    CODEX_HOME: join(dir, "codex"),
    // Discovery only hits a dead local port: tests never multicast on the real LAN.
    OCS_LAN_DISCOVERY_TARGETS: "127.0.0.1",
    OCS_LAN_DISCOVERY_PORT: "9",
  });
  saveLanConfig({ name, port: 0, bind: "127.0.0.1", discover: false }, env);
  return { env, identity: loadOrCreateIdentity(env), sessionsDir };
}

function serve(m: Machine): Promise<LanServerHandle> {
  return startLanServer({ identity: m.identity, config: { name: "srv", port: 0, bind: "127.0.0.1", discover: false }, lang: "en", env: m.env });
}

/** A live fake Claude session (inbox socket + a sleeping child as its pid). */
function fakeClaude(m: Machine, name: string, sessionId: string) {
  const sockPath = join(tempDir("ocs-lantrust-sock-"), "inbox.sock");
  const frames: string[] = [];
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    socket.on("end", () => {
      if (buf !== "") frames.push(buf);
    });
  });
  server.listen(sockPath);
  const proc = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  writeFileSync(
    join(m.sessionsDir, `${proc.pid}.json`),
    JSON.stringify({ pid: proc.pid, sessionId, name, cwd: "/work", status: "idle", messagingSocketPath: sockPath }),
    { mode: 0o600 },
  );
  return { frames, close: () => { server.close(); proc.kill(); } };
}

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const target = (m: Machine) => m.identity.fingerprint.slice(0, 20);

describe("pairing by request + check code", () => {
  test("both sides show the same check code; approval trusts both ways for the issuer's period", async () => {
    const a = machine("alpha");
    const b = machine("bravo");
    const server = await serve(a);
    try {
      const { offer } = createPairOffer({ mode: "approve", label: "bee", grant: { ttl_ms: 2 * HOUR, uses: null } }, a.env);
      let shownOnB = "";
      const joining = pairByRequest(target(a), b.identity, {
        addrs: [`127.0.0.1:${server.port}`],
        onSas: (sas) => {
          shownOnB = sas;
        },
      }, b.env);
      const request = await waitFor(() => loadPairOffer(offer.id, a.env)?.request);
      expect(request.sas).toMatch(/^\d{6}$/);
      expect(request.sas).toBe(shownOnB);
      expect(request.fingerprint).toBe(b.identity.fingerprint);
      // Nothing is trusted before the human says yes.
      expect(listPeers(a.env)).toEqual([]);
      expect(decidePairRequest(offer.id, request.id, true, a.env)).toBe(true);
      const joined = await joining;
      expect(joined.peer.fingerprint).toBe(a.identity.fingerprint);
      const onA = findPeer("bee", a.env)!;
      expect(onA.fingerprint).toBe(b.identity.fingerprint);
      for (const p of [onA, joined.peer]) {
        expect(Math.abs(Date.parse(p.expires_at!) - (Date.now() + 2 * HOUR))).toBeLessThan(10_000);
        expect(p.uses_left).toBeUndefined();
      }
      expect(loadPairOffer(offer.id, a.env)).toMatchObject({ status: "paired", peer: { label: "bee" } });
    } finally {
      await server.close();
    }
  }, T);

  test("refused: requester learns it, nothing is trusted, the invitation stays open for the next request", async () => {
    const a = machine("alpha");
    const b = machine("bravo");
    const server = await serve(a);
    try {
      const { offer } = createPairOffer({ mode: "approve", grant: { ttl_ms: HOUR, uses: null } }, a.env);
      const joining = pairByRequest(target(a), b.identity, { addrs: [`127.0.0.1:${server.port}`] }, b.env).catch((e) => e);
      const request = await waitFor(() => loadPairOffer(offer.id, a.env)?.request);
      decidePairRequest(offer.id, request.id, false, a.env);
      const error = await joining;
      expect(error).toBeInstanceOf(LanClientError);
      expect((error as LanClientError).code).toBe("rejected");
      expect(listPeers(a.env)).toEqual([]);
      expect(listPeers(b.env)).toEqual([]);
      const after = loadPairOffer(offer.id, a.env)!;
      expect(after.status).toBe("open");
      expect(after.request).toBeUndefined();
    } finally {
      await server.close();
    }
  }, T);

  test("the copied key prefix is pinned: a different machine at that address gets no identity and no request", async () => {
    const real = machine("real");
    const imposter = machine("imposter");
    const b = machine("victim");
    const server = await serve(imposter);
    try {
      const { offer } = createPairOffer({ mode: "approve" }, imposter.env);
      const error = await pairByRequest(target(real), b.identity, { addrs: [`127.0.0.1:${server.port}`] }, b.env).catch((e) => e);
      expect((error as LanClientError).code).toBe("key-mismatch");
      expect(loadPairOffer(offer.id, imposter.env)?.request).toBeUndefined();
      expect(listPeers(b.env)).toEqual([]);
    } finally {
      await server.close();
    }
  }, T);

  test("strangers cannot pop requests on a machine that is not waiting; modes do not cross", async () => {
    const a = machine("alpha");
    const b = machine("bravo");
    const server = await serve(a);
    try {
      const nothing = await pairByRequest(target(a), b.identity, { addrs: [`127.0.0.1:${server.port}`] }, b.env).catch((e) => e);
      expect((nothing as LanClientError).code).toBe("no-offer");
      // A code invitation does not accept requests…
      createPairOffer({}, a.env);
      const codeOnly = await pairByRequest(target(a), b.identity, { addrs: [`127.0.0.1:${server.port}`] }, b.env).catch((e) => e);
      expect((codeOnly as LanClientError).code).toBe("no-offer");
      // …and an approve invitation cannot be redeemed with a token (its token is never shown).
      const c = machine("charlie");
      const { token } = createPairOffer({ mode: "approve" }, c.env);
      const redeemed = redeemPairOffer(token, () => { throw new Error("must not trust"); }, c.env);
      expect(redeemed).toEqual({ ok: false, reason: "no-offer" });
    } finally {
      await server.close();
    }
  }, T);

  test("one request at a time; an unanswered request times out and frees the invitation", async () => {
    const a = machine("alpha");
    const { offer } = createPairOffer({ mode: "approve" }, a.env);
    const first = submitPairRequest({ fingerprint: "x".repeat(52), key: "", name: "one", sas: "123456" }, a.env);
    expect(first.ok).toBe(true);
    expect(submitPairRequest({ fingerprint: "y".repeat(52), key: "", name: "two", sas: "654321" }, a.env))
      .toEqual({ ok: false, reason: "busy" });
    // Clear it, then let a real request time out quickly.
    decidePairRequest(offer.id, (first as { requestId: string }).requestId, false, a.env);
    const other = generateIdentity().identity;
    await waitFor(() => (loadPairOffer(offer.id, a.env)?.decision !== undefined ? true : undefined));
    // settle the refusal so the slot is free
    const { settlePairRequest } = await import("../src/lan-store.ts");
    settlePairRequest(offer.id, (first as { requestId: string }).requestId, () => { throw new Error("no"); }, false, a.env);
    const reply = await handleLanPairRequest(
      { op: "pair-request", name: "slow" },
      { key: other.publicKey, fingerprint: other.fingerprint, host: "127.0.0.1", port: null, sas: "000111" },
      { name: "alpha", port: 0, bind: "127.0.0.1", discover: false },
      a.identity,
      a.env,
      { waitMs: 300, pollMs: 20 },
    );
    expect(reply).toEqual({ ok: false, error: "timeout" });
    expect(loadPairOffer(offer.id, a.env)?.request).toBeUndefined();
    expect(listPeers(a.env)).toEqual([]);
  }, T);

  test("an older code invitation without a period still pairs permanently (0.7 behaviour)", async () => {
    const a = machine("alpha");
    const b = machine("bravo");
    const server = await serve(a);
    try {
      const { token } = createPairOffer({ label: "bee" }, a.env);
      const code = encodePairingCode(fingerprintDigest(a.identity.publicKey), token);
      const joined = await pairWithCode(code, b.identity, { addr: `127.0.0.1:${server.port}` }, b.env);
      expect(joined.peer.expires_at).toBeUndefined();
      expect(findPeer("bee", a.env)?.expires_at).toBeUndefined();
    } finally {
      await server.close();
    }
  }, T);
});

describe("trust that runs out", () => {
  test("an expired peer is unpaired at the handshake and cannot be messaged", async () => {
    const a = machine("alpha");
    const b = machine("bravo");
    const server = await serve(a);
    try {
      trustPeer({ key: b.identity.publicKey, name: "bravo", label: "bee", terms: { expires_at: new Date(Date.now() + 400).toISOString() } }, a.env);
      expect(findPeerByFingerprint(b.identity.fingerprint, a.env)).not.toBeNull();
      await new Promise((r) => setTimeout(r, 500));
      expect(findPeerByFingerprint(b.identity.fingerprint, a.env)).toBeNull();
      const conn = await connectSecure(
        { host: "127.0.0.1", port: server.port },
        b.identity,
        { kind: "fingerprint", fingerprint: a.identity.fingerprint },
        { listenPort: null },
      );
      expect(conn.paired).toBe(false);
      conn.channel.send({ op: "dm", from: "x", from_key: "x", to: "y", body: "hi" });
      expect(await conn.channel.receive(5000)).toEqual({ ok: false, error: "unpaired" });
    } finally {
      await server.close();
    }
  }, T);

  for (const noWake of [false, true]) test(`--once (quiet=${noWake}): a typo does not use it up; the first stored DM does; the second is refused`, async () => {
    const a = machine("alpha");
    const b = machine("bravo");
    const server = await serve(a);
    const session = fakeClaude(a, "worker", "aaaaaaaa-1111-2222-3333-444455556666");
    try {
      trustPeer({ key: b.identity.publicKey, name: "bravo", label: "bee", terms: { uses_left: 1 } }, a.env);
      const peerOnB = trustPeer({ key: a.identity.publicKey, name: "alpha", label: "alpha", addr: `127.0.0.1:${server.port}` }, b.env);
      const payload = { from: "claude-bbbbbbbb", from_key: "claude-bbbbbbbb", body: "hello", lang: "en" as const, noWake };
      const typo = await sendRemoteDm(peerOnB, b.identity, { ...payload, to: "nobody-here" }, b.env);
      expect(typo).toMatchObject({ delivered: true, reply: { ok: false, error: "not-found" } });
      expect(findPeer("bee", a.env)?.uses_left).toBe(1);
      const first = await sendRemoteDm(peerOnB, b.identity, { ...payload, to: "worker" }, b.env);
      expect(first).toMatchObject({ delivered: true, reply: { ok: true } });
      if (!noWake) await waitFor(() => session.frames[0]);
      else expect(session.frames.length).toBe(0);
      expect(peerActive(findPeer("bee", a.env)!)).toBe(false);
      const second = await sendRemoteDm(peerOnB, b.identity, { ...payload, to: "worker" }, b.env).catch((e) => e);
      expect((second as LanClientError).code).toBe("unpaired");
    } finally {
      session.close();
      await server.close();
    }
  }, T);

  test("`trust` can extend or make permanent this machine's side only", () => {
    const a = machine("alpha");
    const other = generateIdentity().identity;
    trustPeer({ key: other.publicKey, name: "x", label: "x", terms: { expires_at: new Date(Date.now() + 1000).toISOString(), uses_left: 1 } }, a.env);
    const forever = setPeerTerms(other.fingerprint, {}, a.env)!;
    expect(forever.expires_at).toBeUndefined();
    expect(forever.uses_left).toBeUndefined();
    const later = setPeerTerms(other.fingerprint, { expires_at: new Date(Date.now() + HOUR).toISOString() }, a.env)!;
    expect(peerActive(later)).toBe(true);
  });

  test("terms in a pairing reply are validated before they reach the trust store", () => {
    const now = Date.now();
    expect(replyTerms({ expires_at: new Date(now + HOUR).toISOString(), uses: 1 }, now)).toEqual({
      expires_at: new Date(now + HOUR).toISOString(),
      uses_left: 1,
    });
    expect(replyTerms({ expires_at: "soon", uses: -3 }, now)).toEqual({});
    expect(replyTerms({ expires_at: new Date(now - 1).toISOString(), uses: 1.5 }, now)).toEqual({});
    expect(replyTerms({}, now)).toEqual({});
  });
});
