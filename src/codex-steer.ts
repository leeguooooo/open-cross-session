// 回合进行中把唤醒插进当前回合：app-server 守护进程的 `turn/steer`（issue #41）。
//
// 为什么：`codex queue`（= `thread/queue/add`）在目标正跑回合时把消息排进线程的待发队列，
// 回合结束后**每条单独开一个新回合**——协作里连发 10 条 DM，任务结束后就是 10 个回合逐条
// 补放旧消息。终端 TUI 自己的「边跑边输入」走的是 `turn/steer`：消息进**当前**回合，agent
// 在这一轮里就看得到，回合结束后不会再补放。2026-10-06 实测（codex 0.160.1）：TUI 线程
// 托管在守护进程里（rollout 的持有者是 `codex app-server --managed-daemon`），从外部连守护
// 进程发 `turn/steer`，消息出现在同一个 turn 里、TUI 当场显示、agent 在最终回复里回应了它；
// 同样时机 `codex queue` 则在 `thread/queue/list` 里排着，回合结束后另起一轮。
//
// 传输：`$CODEX_HOME/app-server-control/app-server-control.sock`（指向 /tmp/codex-daemon-<uid>/…
// 的符号链接），上面跑的是 WebSocket，帧内是 app-server 的 JSON-RPC。先 initialize，再发
// `turn/steer {threadId, expectedTurnId, input}`。expectedTurnId 是宿主自己的前置条件：
// 回合已经换了就明确报错，不会插错回合。
//
// 结果分级（铁律 5 同构）：
//   * 没连上 / initialize 没过 / 返回 JSON-RPC 错误 → 明确没插进去，调用方走别的载体；
//   * steer 帧已写出但没等到应答（超时、断线）→ unknown-outcome，绝不重放、不降级。

import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { lstatSync, readlinkSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isCodexThreadId } from "./codex-sessions.ts";

/** 连接 + initialize 预算：本机 UDS，超了就当守护进程不可用。 */
export const CODEX_STEER_CONNECT_TIMEOUT_MS = 3000;
/** steer 应答预算：帧已写出，超时只能报 unknown。 */
export const CODEX_STEER_RESPONSE_TIMEOUT_MS = 10_000;

export type CodexSteerResult =
  | { ok: true; turnId: string }
  | { ok: false; reason: "unavailable" | "rejected" | "unknown-outcome"; detail?: string };

function codexHome(env: NodeJS.ProcessEnv): string {
  const configured = env.CODEX_HOME;
  return typeof configured === "string" && configured !== "" ? configured : join(homedir(), ".codex");
}

/** 守护进程控制 socket 路径；可用 OCS_CODEX_DAEMON_SOCK 覆盖（测试用）。 */
export function codexDaemonSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OCS_CODEX_DAEMON_SOCK;
  if (typeof override === "string" && override !== "") return override;
  return join(codexHome(env), "app-server-control", "app-server-control.sock");
}

/**
 * socket 必须是本用户的：守护进程会执行我们发过去的输入，连到别人放的 socket 上等于把消息
 * 交给陌生进程。解析符号链接后要求 socket 本身和所在目录都属于当前 uid，目录不许他人写。
 */
export function trustedDaemonSocket(path: string): string | null {
  if (typeof process.getuid !== "function") return null; // Windows：守护进程走别的传输，这里不碰
  const uid = process.getuid();
  try {
    // 不用 realpathSync：Bun 的实现会 open 目标，对 socket 报 EOPNOTSUPP。手动逐跳解析。
    let real = path;
    for (let hop = 0; lstatSync(real).isSymbolicLink(); hop++) {
      if (hop >= 8) return null;
      const target = readlinkSync(real);
      real = isAbsolute(target) ? target : resolve(dirname(real), target);
    }
    const sock = lstatSync(real);
    if (!sock.isSocket() || sock.uid !== uid) return null;
    const dir = statSync(dirname(real));
    if (dir.uid !== uid || (dir.mode & 0o022) !== 0) return null;
    return real;
  } catch {
    return null;
  }
}

/** 最小 WebSocket 客户端（只做文本帧 + ping/close），跑在 UDS 上。 */
export class DaemonConnection {
  private buffer = Buffer.alloc(0);
  private upgraded = false;
  private fragments: Buffer[] = [];
  private nextId = 0;
  private readonly waiters = new Map<number, (message: Record<string, unknown>) => void>();
  private closedReason: string | null = null;
  private readonly closeWaiters = new Set<(reason: string) => void>();

  private constructor(private readonly socket: Socket) {}

  static open(path: string, timeoutMs: number): Promise<DaemonConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      const conn = new DaemonConnection(socket);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("daemon handshake timed out"));
      }, timeoutMs);
      socket.on("error", (error) => {
        clearTimeout(timer);
        conn.markClosed(String(error));
        reject(error);
      });
      socket.on("close", () => conn.markClosed("daemon closed the connection"));
      socket.on("connect", () => {
        socket.write(
          "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      socket.on("data", (chunk: Buffer) => {
        conn.buffer = Buffer.concat([conn.buffer, chunk]);
        if (!conn.upgraded) {
          const end = conn.buffer.indexOf("\r\n\r\n");
          if (end === -1) return;
          const status = conn.buffer.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
          conn.buffer = conn.buffer.subarray(end + 4);
          clearTimeout(timer);
          if (!/^HTTP\/1\.1 101\b/.test(status)) {
            socket.destroy();
            reject(new Error(`daemon refused websocket upgrade: ${status}`));
            return;
          }
          conn.upgraded = true;
          resolve(conn);
        }
        conn.drain();
      });
    });
  }

  private markClosed(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const waiter of this.closeWaiters) waiter(reason);
    this.closeWaiters.clear();
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(message: Record<string, unknown>): void {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(message), "utf8"));
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0]!;
      const b1 = this.buffer[1]!;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const maskKey = masked ? this.buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (maskKey !== null) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i % 4]!;
      this.buffer = this.buffer.subarray(offset + length);
      const opcode = b0 & 0x0f;
      const fin = (b0 & 0x80) !== 0;
      if (opcode === 0x9) {
        this.sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0x8) {
        this.socket.end();
        this.markClosed("daemon closed the websocket");
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (!fin) continue;
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        let message: unknown;
        try {
          message = JSON.parse(text);
        } catch {
          continue;
        }
        if (typeof message !== "object" || message === null) continue;
        const id = (message as Record<string, unknown>).id;
        if (typeof id === "number" && this.waiters.has(id)) {
          const waiter = this.waiters.get(id)!;
          this.waiters.delete(id);
          waiter(message as Record<string, unknown>);
        }
        // 通知（configWarning、account/updated …）一律忽略
      }
    }
  }

  /**
   * 发一个请求等应答。`onWritten` 在帧交给 socket 之前调用：之后出的任何事都不能证明对方没收到。
   * 超时或断线 reject 一个带 `written` 标记的错误，由调用方决定是 unavailable 还是 unknown。
   */
  request(method: string, params: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.closedReason !== null) {
        reject(new Error(this.closedReason));
        return;
      }
      const id = ++this.nextId;
      const onClose = (reason: string) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        reject(new Error(reason));
      };
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        this.closeWaiters.delete(onClose);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.closeWaiters.add(onClose);
      this.waiters.set(id, (message) => {
        clearTimeout(timer);
        this.closeWaiters.delete(onClose);
        resolve(message);
      });
      this.send({ id, method, params });
    });
  }

  close(): void {
    try {
      this.sendFrame(0x8, Buffer.alloc(0));
    } catch {
      // 已经断了
    }
    this.socket.destroy();
  }
}

function errorText(message: Record<string, unknown>): string {
  const error = message.error;
  if (typeof error === "object" && error !== null) {
    const text = (error as Record<string, unknown>).message;
    if (typeof text === "string") return text;
  }
  return JSON.stringify(error);
}

/**
 * 把一条唤醒插进目标线程正在跑的回合。`expectedTurnId` 来自 rollout 尾部的 task_started——
 * 宿主拿它做前置条件，回合已经结束/换了就报错，我们明确知道没插进去。
 */
export async function steerCodexTurn(input: {
  threadId: string;
  expectedTurnId: string;
  prompt: string;
  env?: NodeJS.ProcessEnv;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
}): Promise<CodexSteerResult> {
  const env = input.env ?? process.env;
  if (!isCodexThreadId(input.threadId)) return { ok: false, reason: "rejected", detail: `bad thread id ${input.threadId}` };
  const path = trustedDaemonSocket(codexDaemonSocketPath(env));
  if (path === null) {
    return { ok: false, reason: "unavailable", detail: "no Codex app-server daemon socket owned by this user" };
  }
  const connectTimeout = input.connectTimeoutMs ?? CODEX_STEER_CONNECT_TIMEOUT_MS;
  let conn: DaemonConnection;
  try {
    conn = await DaemonConnection.open(path, connectTimeout);
  } catch (error) {
    return { ok: false, reason: "unavailable", detail: `cannot reach Codex app-server daemon: ${String(error)}` };
  }
  try {
    let init: Record<string, unknown>;
    try {
      init = await conn.request(
        "initialize",
        { clientInfo: { name: "ocs", title: null, version: "1" }, capabilities: { experimentalApi: true } },
        connectTimeout,
      );
    } catch (error) {
      return { ok: false, reason: "unavailable", detail: `daemon initialize failed: ${String(error)}` };
    }
    if (init.error !== undefined) {
      return { ok: false, reason: "unavailable", detail: `daemon initialize rejected: ${errorText(init)}` };
    }
    conn.send({ method: "initialized" });
    let response: Record<string, unknown>;
    try {
      response = await conn.request(
        "turn/steer",
        {
          threadId: input.threadId.toLowerCase(),
          expectedTurnId: input.expectedTurnId,
          input: [{ type: "text", text: input.prompt, text_elements: [] }],
        },
        input.responseTimeoutMs ?? CODEX_STEER_RESPONSE_TIMEOUT_MS,
      );
    } catch (error) {
      // 帧已经交出去了：宿主可能已经把它插进回合，结果未知，绝不重放。
      return { ok: false, reason: "unknown-outcome", detail: `turn/steer sent but no answer: ${String(error)}` };
    }
    if (response.error !== undefined) return { ok: false, reason: "rejected", detail: errorText(response) };
    const result = response.result;
    const turnId = typeof result === "object" && result !== null ? (result as Record<string, unknown>).turnId : undefined;
    if (typeof turnId !== "string") {
      return { ok: false, reason: "unknown-outcome", detail: "turn/steer answered without a turn id" };
    }
    return { ok: true, turnId };
  } finally {
    conn.close();
  }
}
