import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inject.ts";
import {
  AeadStream,
  crockfordDecode,
  crockfordEncode,
  decodePairingCode,
  encodePairingCode,
  fingerprintDigest,
  generateIdentity,
  LanProtocolError,
  respondServerHandshake,
  startClientHandshake,
  type LanIdentity,
} from "../src/lan-crypto.ts";
import { lanChannel, scrubPids, startLanServer, type LanServerHandle } from "../src/lan-daemon.ts";
import { pairWithCode, remoteWho, sendRemoteDm, LanClientError } from "../src/lan-client.ts";
import {
  createPairOffer,
  findPeer,
  listPeers,
  loadOrCreateIdentity,
  loadPairOffer,
  PAIR_MAX_FAILURES,
  saveLanConfig,
  trustPeer,
  LanStateError,
} from "../src/lan-store.ts";
import { acceptSecure, connectSecure, FrameReader, HANDSHAKE_FRAME_MAX, writeFrame } from "../src/lan-wire.ts";
import { cleanText } from "../src/lan-client.ts";
import { MIN_QUERY_BYTES, startDiscoveryResponder } from "../src/lan-discovery.ts";
import { closePairOffer, redeemPairOffer } from "../src/lan-store.ts";
import { createSocket } from "node:dgram";
import { readdirSync } from "node:fs";
import { startClientHandshake as clientHs } from "../src/lan-crypto.ts";
import { OCS_HOME_ENV, readRoutedMessages, appendMessage, readMessages } from "../src/store.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

const T = 30_000;

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env } as Record<string, string>;
  for (const key of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CODEX_THREAD_ID", "OCS_NAME", "OCS_PI_SESSION_ID"]) {
    delete env[key];
  }
  return { ...env, OCS_LANG: "en", ...extra };
}

interface Machine {
  env: NodeJS.ProcessEnv;
  identity: LanIdentity;
  sessionsDir: string;
}

function machine(name: string): Machine {
  const dir = tempDir(`ocs-lan-${name}-`);
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { mode: 0o700 });
  const env = cleanEnv({
    [OCS_HOME_ENV]: join(dir, "home"),
    [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir,
    // 远端 who 会建花名册：别去扫本机真实的 ~/.codex（真 lsof、真 rollout，全量并发时慢且不确定）
    CODEX_HOME: join(dir, "codex"),
    // 发现只打到本机一个不存在的端口：测试不往真实局域网发组播。
    OCS_LAN_DISCOVERY_TARGETS: "127.0.0.1",
    OCS_LAN_DISCOVERY_PORT: "9",
  });
  saveLanConfig({ name, port: 0, bind: "127.0.0.1", discover: false }, env);
  return { env, identity: loadOrCreateIdentity(env), sessionsDir };
}

async function serve(m: Machine): Promise<LanServerHandle> {
  return startLanServer({
    identity: m.identity,
    config: { name: "srv", port: 0, bind: "127.0.0.1", discover: false },
    lang: "en",
    env: m.env,
  });
}

/** 一个活的 fake Claude 会话：收帧 socket + sleep 子进程当 pid。 */
function fakeClaude(m: Machine, name: string, sessionId: string) {
  const dir = tempDir("ocs-lan-sock-");
  const sockPath = join(dir, "inbox.sock");
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
  return {
    frames,
    close: () => {
      server.close();
      proc.kill();
    },
  };
}

const content = (frame: string) =>
  (JSON.parse(frame.trim().split("\n").at(-1)!) as { message: { content: string } }).message.content;

async function waitFor<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function pairMachines(a: Machine, b: Machine, server: LanServerHandle, label?: string) {
  const { token } = createPairOffer(label === undefined ? {} : { label }, a.env);
  const code = encodePairingCode(fingerprintDigest(a.identity.publicKey), token);
  return pairWithCode(code, b.identity, { addr: `127.0.0.1:${server.port}` }, b.env);
}

describe("编码与配对码", () => {
  test("Crockford 往返，容忍小写、空格、I/L/O 混淆", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 9, 8, 7, 6, 5, 4]);
    const text = crockfordEncode(bytes);
    expect(crockfordDecode(text)!.equals(bytes)).toBe(true);
    expect(crockfordDecode(text.toLowerCase().replace(/1/g, "l").replace(/0/g, "o"))!.equals(bytes)).toBe(true);
  });

  test("配对码 24 字符 6 组；多一个少一个字符都拒", () => {
    const { identity } = generateIdentity();
    const token = Buffer.alloc(7, 0xab);
    const code = encodePairingCode(fingerprintDigest(identity.publicKey), token);
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
    const decoded = decodePairingCode(code)!;
    expect(decoded.token.equals(token)).toBe(true);
    expect(decoded.fpPrefix.equals(fingerprintDigest(identity.publicKey).subarray(0, 8))).toBe(true);
    expect(decodePairingCode(code.slice(0, -1))).toBeNull();
    expect(decodePairingCode(`${code}0`)).toBeNull();
    expect(decodePairingCode(code.replace(/.$/, "U"))).toBeNull();
  });
});

describe("握手与记录层", () => {
  function handshake() {
    const server = generateIdentity().identity;
    const client = generateIdentity().identity;
    const hs = startClientHandshake();
    const srv = respondServerHandshake(JSON.parse(JSON.stringify(hs.hello)), server);
    const { serverKey, keys } = hs.receive(JSON.parse(JSON.stringify(srv.ack)));
    return { server, client, hs, srv, serverKey, keys };
  }

  test("双方派生出同一对方向密钥，客户端认证通过", () => {
    const { server, client, hs, srv, serverKey, keys } = handshake();
    expect(serverKey.equals(server.publicKey)).toBe(true);
    expect(keys.c2s.equals(srv.keys.c2s)).toBe(true);
    expect(keys.s2c.equals(srv.keys.s2c)).toBe(true);
    expect(keys.c2s.equals(keys.s2c)).toBe(false);
    const { clientKey } = srv.verifyAuth(hs.auth(client, 1234));
    expect(clientKey.equals(client.publicKey)).toBe(true);
  });

  test("中间人换掉服务端公钥或临时公钥：签名验不过", () => {
    const server = generateIdentity().identity;
    const mallory = generateIdentity().identity;
    const hs = startClientHandshake();
    const srv = respondServerHandshake(hs.hello, server);
    // 换公钥：签名是 server 私钥签的，对 mallory 公钥验不过
    expect(() => hs.receive({ ...srv.ack, key: mallory.publicKey.toString("base64") })).toThrow(LanProtocolError);
    // 换临时公钥（想自己做 DH）：签名覆盖了 eph，同样失败
    const hs2 = startClientHandshake();
    const srv2 = respondServerHandshake(hs2.hello, server);
    const other = respondServerHandshake(startClientHandshake().hello, server);
    expect(() => hs2.receive({ ...srv2.ack, eph: other.ack.eph })).toThrow(LanProtocolError);
  });

  test("客户端 auth 不能搬到另一条握手里重放", () => {
    const server = generateIdentity().identity;
    const client = generateIdentity().identity;
    const hs1 = startClientHandshake();
    const srv1 = respondServerHandshake(hs1.hello, server);
    hs1.receive(srv1.ack);
    const auth = hs1.auth(client, null);
    const hs2 = startClientHandshake();
    const srv2 = respondServerHandshake(hs2.hello, server);
    expect(() => srv2.verifyAuth(auth)).toThrow("client signature does not verify");
  });

  test("字段长度/编码不严格的帧直接拒", () => {
    const server = generateIdentity().identity;
    const hs = startClientHandshake();
    expect(() => respondServerHandshake({ ...hs.hello, eph: "AAAA" }, server)).toThrow(LanProtocolError);
    expect(() => respondServerHandshake({ ...hs.hello, proto: "ocs-lan/0" }, server)).toThrow("unsupported protocol");
    expect(() => respondServerHandshake(null, server)).toThrow(LanProtocolError);
  });

  test("AEAD：篡改、重放、调序、反射全部解密失败", () => {
    const { keys, srv } = handshake();
    const send = new AeadStream(keys.c2s, "c2s");
    const recv = new AeadStream(srv.keys.c2s, "c2s");
    const f0 = send.seal(Buffer.from("zero"));
    const f1 = send.seal(Buffer.from("one"));
    expect(recv.open(f0).toString()).toBe("zero");
    const tampered = Buffer.from(f1);
    tampered[0]! ^= 1;
    expect(() => new AeadStream(srv.keys.c2s, "c2s").open(tampered)).toThrow("frame authentication failed");
    expect(() => recv.open(f0)).toThrow("frame authentication failed"); // 重放第 0 帧（接收方已在等第 1 帧）
    const reorder = new AeadStream(srv.keys.c2s, "c2s");
    expect(() => reorder.open(f1)).toThrow("frame authentication failed"); // 删掉第 0 帧
    // 反射：把客户端发的帧当服务端方向解
    expect(() => new AeadStream(srv.keys.s2c, "s2c").open(f0)).toThrow("frame authentication failed");
  });
});

test("AEAD：即使两个方向碰巧同钥，方向写进 AAD 也挡住反射", () => {
  const key = Buffer.alloc(32, 7);
  const frame = new AeadStream(key, "c2s").seal(Buffer.from("x"));
  expect(() => new AeadStream(key, "s2c").open(frame)).toThrow("frame authentication failed");
});

describe("身份与信任库文件", () => {
  test("私钥文件权限放宽后拒绝加载", () => {
    const m = machine("perm");
    const path = join(m.env[OCS_HOME_ENV]!, "lan", "identity.json");
    expect(loadOrCreateIdentity(m.env).fingerprint).toBe(m.identity.fingerprint);
    chmodSync(path, 0o644);
    expect(() => loadOrCreateIdentity(m.env)).toThrow(LanStateError);
  });

  test("信任库里公钥和指纹对不上视为损坏", () => {
    const m = machine("tamper");
    const other = generateIdentity().identity;
    trustPeer({ key: other.publicKey, name: "x" }, m.env);
    const path = join(m.env[OCS_HOME_ENV]!, "lan", "peers.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.peers[0].key = generateIdentity().identity.publicKey.toString("base64");
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
    expect(() => listPeers(m.env)).toThrow("malformed entries");
  });
});

describe("配对", () => {
  test("兑码成功后双方互信，邀请回写对端信息", async () => {
    const a = machine("alpha");
    const b = machine("bravo");
    const server = await serve(a);
    try {
      const { offer, token } = createPairOffer({ label: "bravo-box" }, a.env);
      const code = encodePairingCode(fingerprintDigest(a.identity.publicKey), token);
      const joined = await pairWithCode(code, b.identity, { addr: `127.0.0.1:${server.port}` }, b.env);
      expect(joined.peer.fingerprint).toBe(a.identity.fingerprint);
      expect(joined.peer.name).toBe("srv");
      const onA = findPeer("bravo-box", a.env);
      expect(onA?.fingerprint).toBe(b.identity.fingerprint);
      expect(loadPairOffer(offer.id, a.env)).toMatchObject({ status: "paired", peer: { label: "bravo-box" } });
      // 码是一次性的
      await expect(pairWithCode(code, machine("charlie").identity, { addr: `127.0.0.1:${server.port}` }, machine("c2").env))
        .rejects.toThrow("pairing refused");
    } finally {
      await server.close();
    }
  }, T);

  test("配对码里的指纹前缀对不上（冒名的发码方）：不发出身份和令牌", async () => {
    const a = machine("real");
    const imposter = machine("imposter");
    const b = machine("victim");
    const server = await serve(imposter);
    try {
      const { token } = createPairOffer({}, imposter.env);
      const code = encodePairingCode(fingerprintDigest(a.identity.publicKey), token);
      const error = await pairWithCode(code, b.identity, { addr: `127.0.0.1:${server.port}` }, b.env).catch((e) => e);
      expect(error).toBeInstanceOf(LanClientError);
      expect((error as LanClientError).code).toBe("key-mismatch");
      expect(listPeers(imposter.env)).toEqual([]);
      expect(listPeers(b.env)).toEqual([]);
    } finally {
      await server.close();
    }
  }, T);

  test("拿本机自己的码配对：拒绝，邀请原样保留", async () => {
    const a = machine("solo");
    const server = await serve(a);
    try {
      const { offer, token } = createPairOffer({}, a.env);
      const code = encodePairingCode(fingerprintDigest(a.identity.publicKey), token);
      const error = await pairWithCode(code, a.identity, { addr: `127.0.0.1:${server.port}` }, a.env).catch((e) => e);
      expect((error as LanClientError).code).toBe("self");
      expect(loadPairOffer(offer.id, a.env)).toMatchObject({ status: "open", failures: 0 });
      expect(listPeers(a.env)).toEqual([]);
    } finally {
      await server.close();
    }
  }, T);

  test(`错码累计 ${PAIR_MAX_FAILURES} 次邀请作废，之后正确的码也不行`, async () => {
    const a = machine("issuer");
    const b = machine("joiner");
    const server = await serve(a);
    try {
      const { offer, token } = createPairOffer({}, a.env);
      const digest = fingerprintDigest(a.identity.publicKey);
      for (let i = 0; i < PAIR_MAX_FAILURES; i++) {
        const wrong = Buffer.from(token);
        wrong[0] = (wrong[0]! + 1 + i) & 0xff;
        await expect(pairWithCode(encodePairingCode(digest, wrong), b.identity, { addr: `127.0.0.1:${server.port}` }, b.env))
          .rejects.toThrow("pairing refused: bad-code");
      }
      expect(loadPairOffer(offer.id, a.env)?.status).toBe("burned");
      await expect(pairWithCode(encodePairingCode(digest, token), b.identity, { addr: `127.0.0.1:${server.port}` }, b.env))
        .rejects.toThrow("pairing refused: no-offer");
      expect(listPeers(a.env)).toEqual([]);
    } finally {
      await server.close();
    }
  }, T);
});

describe("已配对对端的请求", () => {
  test("远端 DM：落 lan-* 频道、唤醒本机会话、发送者显示为 x@label、Reply 行可直接回", async () => {
    const a = machine("mini");
    const b = machine("laptop");
    const server = await serve(a);
    const worker = fakeClaude(a, "worker-a", "ae38e21b-1111-2222-3333-444455556666");
    try {
      await pairMachines(a, b, server, "lap");
      const peer = findPeer("srv", b.env)!;
      const result = await sendRemoteDm(peer, b.identity, {
        from: "alice",
        from_key: "claude-12345678",
        to: "worker-a",
        body: "hello from the laptop",
        lang: "en",
      }, b.env);
      expect(result.delivered).toBe(true);
      const reply = (result as { reply: { ok: boolean; channel: string; seq: number; to_key: string; outcome: string } }).reply;
      expect(reply).toMatchObject({ ok: true, seq: 1, to_key: "claude-ae38e21b", outcome: "ok" });
      expect(reply.channel).toBe(lanChannel(b.identity.fingerprint, "claude-ae38e21b", "claude-12345678"));
      const frame = await waitFor(() => worker.frames[0]);
      const note = content(frame);
      expect(note).toContain('from-name="alice@lap"');
      expect(note).toContain("hello from the laptop");
      expect(note).toContain('ocs dm alice@lap "<your reply>"');
      const [stored] = readRoutedMessages(reply.channel, { env: a.env });
      expect(stored).toMatchObject({
        from: "alice.lap",
        body: "hello from the laptop",
        from_identity: `lan:${b.identity.fingerprint}:claude-12345678`,
        to_identity: "claude:ae38e21b-1111-2222-3333-444455556666",
      });
    } finally {
      worker.close();
      await server.close();
    }
  }, T);

  test("远端 DM 找不到目标：不落盘、如实回 not-found；任意名字不许造频道", async () => {
    const a = machine("mini");
    const b = machine("laptop");
    const server = await serve(a);
    try {
      await pairMachines(a, b, server);
      const peer = findPeer("srv", b.env)!;
      const result = await sendRemoteDm(peer, b.identity, {
        from: "alice", from_key: "alice", to: "nobody-here", body: "x", lang: "en",
      }, b.env);
      expect(result).toMatchObject({ delivered: true, reply: { ok: false, error: "not-found" } });
    } finally {
      await server.close();
    }
  }, T);

  test("远端 who 只给地址/种类/状态，不给 pid 和路径", async () => {
    const a = machine("mini");
    const b = machine("laptop");
    const server = await serve(a);
    const worker = fakeClaude(a, "worker-a", "ae38e21b-1111-2222-3333-444455556666");
    try {
      await pairMachines(a, b, server);
      const who = await remoteWho(findPeer("srv", b.env)!, b.identity, b.env);
      expect(who.entries).toContainEqual(expect.objectContaining({ address: "claude-ae38e21b", kind: "claude", status: "idle", label: "worker-a" }));
      expect(JSON.stringify(who)).not.toContain("/work");
    } finally {
      worker.close();
      await server.close();
    }
  }, T);

  test("未配对的机器：握手能完成，但 who / dm 一律 unpaired", async () => {
    const a = machine("mini");
    const stranger = machine("stranger");
    const server = await serve(a);
    try {
      const conn = await connectSecure(
        { host: "127.0.0.1", port: server.port },
        stranger.identity,
        { kind: "fingerprint", fingerprint: a.identity.fingerprint },
        { listenPort: null },
      );
      expect(conn.paired).toBe(false);
      conn.channel.send({ op: "who" });
      expect(await conn.channel.receive(5000)).toEqual({ ok: false, error: "unpaired" });
    } finally {
      await server.close();
    }
  }, T);

  test("对端换了钥匙（重装 / 冒名）：钉死的指纹对不上就不发请求", async () => {
    const a = machine("mini");
    const b = machine("laptop");
    const server = await serve(a);
    try {
      // b 以为 127.0.0.1:port 上是另一把钥匙
      const ghost = generateIdentity().identity;
      trustPeer({ key: ghost.publicKey, name: "ghost", addr: `127.0.0.1:${server.port}` }, b.env);
      const error = await sendRemoteDm(findPeer("ghost", b.env)!, b.identity, {
        from: "alice", from_key: "alice", to: "worker-a", body: "x", lang: "en",
      }, b.env).catch((e) => e);
      expect(error).toBeInstanceOf(LanClientError);
      expect((error as LanClientError).mismatches).toEqual([`127.0.0.1:${server.port}`]);
    } finally {
      await server.close();
    }
  }, T);
});

describe("资源上限", () => {
  test("握手阶段超大帧：不分配、直接断开", async () => {
    const a = machine("mini");
    const server = await serve(a);
    try {
      const socket: Socket = connect({ host: "127.0.0.1", port: server.port });
      await new Promise((r) => socket.once("connect", r));
      const head = Buffer.alloc(4);
      head.writeUInt32BE(HANDSHAKE_FRAME_MAX + 1, 0);
      socket.write(head);
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    } finally {
      await server.close();
    }
  }, T);

  test("FrameReader 按上限拒帧", async () => {
    const pair = await new Promise<{ a: Socket; b: Socket; server: Server }>((resolve) => {
      const server = createServer((b) => {
        resolve({ a, b, server });
      }).listen(0, "127.0.0.1", () => {});
      let a: Socket;
      server.on("listening", () => {
        const addr = server.address() as { port: number };
        a = connect({ host: "127.0.0.1", port: addr.port });
      });
    });
    const reader = new FrameReader(pair.b, 8);
    writeFrame(pair.a, Buffer.from("12345678"));
    expect((await reader.next(1000)).toString()).toBe("12345678");
    writeFrame(pair.a, Buffer.from("123456789"));
    await expect(reader.next(1000)).rejects.toThrow("exceeds 8");
    // 一问一答：没人取的帧最多积压一帧，第二帧即断开（不无限排队）
    const pair2 = await new Promise<{ a: Socket; b: Socket; server: Server }>((resolve) => {
      const server = createServer((b) => resolve({ a, b, server })).listen(0, "127.0.0.1");
      let a: Socket;
      server.on("listening", () => {
        a = connect({ host: "127.0.0.1", port: (server.address() as { port: number }).port });
      });
    });
    const strict = new FrameReader(pair2.b, 64);
    writeFrame(pair2.a, Buffer.from("one"));
    writeFrame(pair2.a, Buffer.from("two"));
    await new Promise((r) => setTimeout(r, 100));
    // 连已积压的那帧一起丢弃：流水线灌帧的连接不配得到任何处理
    await expect(strict.next(1000)).rejects.toThrow("out of turn");
    pair2.a.destroy();
    pair2.server.close();
    pair.a.destroy();
    pair.server.close();
  });
});

describe("安全审查回归（v0.6.0 发布前）", () => {
  test("未认证流水线灌帧：立即断开，服务不被卡住", async () => {
    const a = machine("mini");
    const b = machine("laptop");
    const server = await serve(a);
    try {
      await pairMachines(a, b, server);
      const socket: Socket = connect({ host: "127.0.0.1", port: server.port });
      await new Promise((r) => socket.once("connect", r));
      socket.on("error", () => {});
      const hello = Buffer.from(JSON.stringify(clientHs().hello));
      const head = Buffer.alloc(4);
      head.writeUInt32BE(hello.length, 0);
      socket.write(Buffer.concat([head, hello, Buffer.alloc(4 * 128 * 1024)])); // 12.8 万个零长帧
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
      const started = Date.now();
      await remoteWho(findPeer("srv", b.env)!, b.identity, b.env);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await server.close();
    }
  }, T);

  test("未配对连接握完手也一直占每 IP 名额：第 9 个直接被拒", async () => {
    const a = machine("mini");
    const server = await serve(a);
    const held: Array<{ destroy(): void }> = [];
    try {
      for (let i = 0; i < 8; i++) {
        const conn = await connectSecure(
          { host: "127.0.0.1", port: server.port },
          generateIdentity().identity,
          { kind: "fingerprint", fingerprint: a.identity.fingerprint },
          { listenPort: null },
        );
        held.push(conn.channel);
      }
      await expect(connectSecure(
        { host: "127.0.0.1", port: server.port },
        generateIdentity().identity,
        { kind: "fingerprint", fingerprint: a.identity.fingerprint },
        { listenPort: null },
      )).rejects.toThrow();
    } finally {
      for (const conn of held) conn.destroy();
      await server.close();
    }
  }, T);

  test("远端 DM 给格式合法但不存在的 codex / pi 目标：not-found，不建任何频道", async () => {
    const a = machine("mini");
    const b = machine("laptop");
    const server = await serve(a);
    try {
      await pairMachines(a, b, server);
      const peer = findPeer("srv", b.env)!;
      for (const to of ["019a0000-0000-7000-8000-00000000abcd", "pi-019a0000-0000-7000-8000-00000000abcd"]) {
        const result = await sendRemoteDm(peer, b.identity, { from: "x", from_key: `k-${to.length}`, to, body: "junk", lang: "en" }, b.env);
        expect(result).toMatchObject({ delivered: true, reply: { ok: false, error: "not-found" } });
      }
      let channels: string[] = [];
      try {
        channels = readdirSync(join(a.env[OCS_HOME_ENV]!, "channels")).filter((f) => f.startsWith("lan-"));
      } catch {
        // 目录都没建
      }
      expect(channels).toEqual([]);
    } finally {
      await server.close();
    }
  }, T);

  test("pid 两种写法都抹掉", () => {
    expect(scrubPids("wake: delivered to inbox → worker-a(pid 4242)")).toBe("wake: delivered to inbox → worker-a");
    expect(scrubPids("codex: queued via codex queue (pid 777, message m1)")).not.toMatch(/\d{3}/);
  });

  test("投递行不带 pid 回给远端", async () => {
    const a = machine("mini");
    const b = machine("laptop");
    const server = await serve(a);
    const worker = fakeClaude(a, "worker-a", "ae38e21b-1111-2222-3333-444455556666");
    try {
      await pairMachines(a, b, server);
      const result = await sendRemoteDm(findPeer("srv", b.env)!, b.identity, {
        from: "alice", from_key: "alice", to: "worker-a", body: "x", lang: "en",
      }, b.env);
      const lines = (result as { reply: { lines: string[] } }).reply.lines;
      expect(lines.join("\n")).toContain("worker-a");
      expect(lines.join("\n")).not.toMatch(/pid \d/);
    } finally {
      worker.close();
      await server.close();
    }
  }, T);

  test("发现：小于 256 字节的查询不应答（无放大），补齐的查询应答且应答更小", async () => {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const env = cleanEnv({ OCS_LAN_DISCOVERY_PORT: String(port) });
    const responder = await startDiscoveryResponder(
      { name: "alpha", port: 47890, fingerprint: "a".repeat(52), bind: "127.0.0.1" },
      env,
    );
    const client = createSocket({ type: "udp4" });
    const replies: Buffer[] = [];
    client.on("message", (msg) => replies.push(msg));
    await new Promise<void>((resolve) => client.bind(0, "127.0.0.1", () => resolve()));
    try {
      const small = Buffer.from(JSON.stringify({ ocs: "lan-query", v: 1, n: "0123456789abcdef" }));
      client.send(small, port, "127.0.0.1");
      await new Promise((r) => setTimeout(r, 200));
      expect(replies).toHaveLength(0);
      const bare = JSON.stringify({ ocs: "lan-query", v: 1, n: "0123456789abcdef", pad: "" });
      const padded = Buffer.from(JSON.stringify({ ocs: "lan-query", v: 1, n: "0123456789abcdef", pad: "0".repeat(MIN_QUERY_BYTES - bare.length) }));
      client.send(padded, port, "127.0.0.1");
      await waitFor(() => replies[0]);
      expect(replies[0]!.length).toBeLessThan(padded.length);
    } finally {
      client.close();
      responder?.close();
    }
  }, T);

  test("兑码与关闭邀请互斥：最后一刻兑现成功的，关闭时拿到的是 paired", () => {
    const a = machine("race");
    const { offer, token } = createPairOffer({}, a.env);
    const other = generateIdentity().identity;
    const redeemed = redeemPairOffer(token, () => trustPeer({ key: other.publicKey, name: "x" }, a.env), a.env);
    expect(redeemed.ok).toBe(true);
    expect(closePairOffer(offer.id, a.env)).toMatchObject({ status: "paired", peer: { fingerprint: other.fingerprint } });
    expect(loadPairOffer(offer.id, a.env)).toBeNull();
  });

  test("对端自报名与远端文本：控制字符/转义序列不进信任库和终端", () => {
    const m = machine("names");
    const peer = trustPeer({ key: generateIdentity().identity.publicKey, name: "evil\u001b[2J\nname" }, m.env);
    expect(peer.name).toMatch(/^[a-z0-9-]+$/);
    expect(cleanText("ok\u001b]0;pwned\u0007\nnext", 100)).toBe("ok]0;pwnednext");
  });
});

describe("登录自启（lan autostart）", () => {
  const { autostartPlan, autostartState, disableAutostart, enableAutostart } = require("../src/lan-autostart.ts") as typeof import("../src/lan-autostart.ts");

  test("macOS：LaunchAgent 起 _lan-daemon，RunAtLoad、不 KeepAlive；OCS_HOME 带进去；路径里的特殊字符转义", () => {
    const plan = autostartPlan("darwin", ["/Users/x/.local/bin/ocs"], { OCS_HOME: "/tmp/a&b" }, "/Users/x")!;
    expect(plan.kind).toBe("file");
    if (plan.kind !== "file") return;
    expect(plan.path).toBe("/Users/x/Library/LaunchAgents/com.leeguooooo.ocs.lan.plist");
    expect(plan.content).toContain("<string>/Users/x/.local/bin/ocs</string>\n    <string>_lan-daemon</string>");
    expect(plan.content).toContain("<key>KeepAlive</key>\n  <false/>");
    expect(plan.content).toContain("<string>/tmp/a&amp;b</string>");
  });

  test("Windows：HKCU Run 跑 `ocs.exe lan up`（隐藏窗口拉起守护进程），路径带空格要加引号", () => {
    const plan = autostartPlan("win32", ["C:\\Program Files\\ocs\\ocs.exe"], {}, "C:\\Users\\x")!;
    expect(plan).toEqual({
      kind: "registry",
      key: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      value: "ocs-lan",
      data: '"C:\\Program Files\\ocs\\ocs.exe" lan up',
    });
  });

  test("Linux：systemd user unit", () => {
    const plan = autostartPlan("linux", ["/home/x/.local/bin/ocs"], {}, "/home/x")!;
    expect(plan.kind === "file" && plan.content).toContain("ExecStart=/home/x/.local/bin/ocs _lan-daemon");
  });

  test("写入 / 状态 / 删除（文件型，临时目录）", () => {
    const home = tempDir("ocs-autostart-");
    const plan = autostartPlan("darwin", ["/opt/ocs"], {}, home)!;
    expect(autostartState(plan)).toBe("off");
    enableAutostart(plan);
    expect(autostartState(plan)).toBe("on");
    expect(autostartState(autostartPlan("darwin", ["/elsewhere/ocs"], {}, home)!)).toBe("stale");
    expect(disableAutostart(plan)).toBe(true);
    expect(autostartState(plan)).toBe("off");
  });
});


for (const mode of ["old-receiver", "lost-reply"] as const) {
  test(`LAN JSON ${mode}: one authenticated request, no fallback or retry`, async () => {
    const a = machine("receiver"), b = machine("sender");
    const channel = "lan-" + "a".repeat(32);
    const requests: Record<string, unknown>[] = [];
    const server = createServer((socket) => {
      void (async () => {
        const conn = await acceptSecure(socket, a.identity, () => ({ paired: true, name: "receiver" }));
        const req = await conn.channel.receive(5000) as Record<string, unknown>;
        requests.push(req);
        if (mode === "old-receiver") { conn.channel.send({ ok: false, error: "unknown-op" }); conn.channel.close(); }
        else {
          appendMessage({ channel, from: "sender", body: String(req.body), env: a.env });
          conn.channel.destroy(); // Remote commit exists, sender never gets proof.
        }
      })().catch(() => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    trustPeer({ key: a.identity.publicKey, name: "receiver", label: "receiver", addr: `127.0.0.1:${port}` }, b.env);
    try {
      const cli = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"),
        "dm", "worker@receiver", "test task", "--as", "sender", "--no-wake", "--json"],
        { env: { ...b.env, OCS_UPGRADE_CHECK: "0" }, stdout: "pipe", stderr: "pipe" });
      const output = await new Response(cli.stdout).text();
      const err = await new Response(cli.stderr).text();
      const code = await cli.exited;
      expect(err).toBe("");
      expect(output.trim().split("\n").length).toBe(1);
      expect(requests.length).toBe(1);
      expect(requests[0]!.op).toBe("dm-quiet");
      if (mode === "old-receiver") {
        expect(code).toBe(1);
        expect(JSON.parse(output)).toMatchObject({ stored: false, exit: 1 });
        expect(readMessages(channel, { env: a.env }).length).toBe(0);
      } else {
        expect(code).toBe(3);
        expect(JSON.parse(output)).toMatchObject({ remote: true, stored: null, wake: "unknown", exit: 3 });
        expect(readMessages(channel, { env: a.env }).length).toBe(1);
        expect(readMessages(channel, { env: b.env }).length).toBe(0);
      }
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, T);
}
