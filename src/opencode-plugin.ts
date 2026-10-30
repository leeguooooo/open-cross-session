import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, isAbsolute } from "node:path";
import { homedir } from "node:os";

export const OPENCODE_PLUGIN_SOURCE = String.raw`// Installed by open-cross-session. Re-run: ocs skill install
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export default {
  id: "ocs",
  async setup(ctx) {
    const home = isAbsolute(process.env.OCS_HOME || "") ? process.env.OCS_HOME : join(homedir(), ".ocs");
    const sessions = new Map();
    const scope = new AsyncLocalStorage();
    const dirs = [join(home, "opencode-sessions"), join(home, "opencode-inbox")];
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") chmodSync(dir, 0o700);
    }
    let closed = false;
    async function stopSession(id) {
      const pending = sessions.get(id);
      if (!pending) return;
      sessions.delete(id);
      let current;
      try { current = await pending; } catch { return; }
      try { if (JSON.parse(readFileSync(current.registryPath, "utf8")).token === current.token) unlinkSync(current.registryPath); } catch {}
      for (const socket of current.sockets) socket.destroy();
      await new Promise((resolve) => current.server.close(resolve));
      if (process.platform !== "win32") try { unlinkSync(current.socketPath); } catch {}
    }
    async function register(id) {
      if (closed || !/^ses_[A-Za-z0-9]{1,51}$/.test(id)) throw new Error("invalid OpenCode session");
      if (sessions.has(id)) return sessions.get(id);
      const pending = (async () => {
        const info = await ctx.session.get({ sessionID: id });
        if (closed || info.time?.archived) throw new Error("OpenCode session is unavailable");
        const cwd = info.location?.directory;
        if (!isAbsolute(cwd || "")) throw new Error("OpenCode session has no absolute directory");
        const token = randomBytes(32).toString("hex");
        const key = createHash("sha256").update(id).digest("hex").slice(0, 24);
        const socketPath = process.platform === "win32"
          ? "\\\\.\\pipe\\ocs-opencode-" + key + "-" + process.pid + "-" + randomBytes(16).toString("hex")
          : join(dirs[1], key + "-" + process.pid + "-" + randomBytes(4).toString("hex") + ".sock");
        const registryPath = join(dirs[0], id + "." + process.pid + ".json");
        const sockets = new Set();
        const server = createServer((socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
          socket.on("error", () => {});
          socket.setTimeout(2000, () => socket.destroy());
          socket.setEncoding("utf8");
          let buffer = "", handled = false;
          const reply = (value) => socket.end(JSON.stringify(value) + "\n");
          socket.on("data", async (chunk) => {
            if (handled) return;
            buffer += chunk;
            if (Buffer.byteLength(buffer) > 16 * 1024) { handled = true; socket.destroy(); return; }
            const n = buffer.indexOf("\n");
            if (n < 0) return;
            handled = true;
            let frame;
            try { frame = JSON.parse(buffer.slice(0, n)); } catch { reply({ v: 1, ok: false, error: "invalid JSON" }); return; }
            if (frame?.v !== 1 || frame.type !== "wake" || frame.session_id !== id || frame.token !== token ||
                typeof frame.note !== "string" || !frame.note || Buffer.byteLength(frame.note) > 16 * 1024) {
              reply({ v: 1, ok: false, error: "invalid wake frame" }); return;
            }
            try {
              const info = await ctx.session.get({ sessionID: id });
              if (info.time?.archived) throw new Error("session archived");
            } catch { reply({ v: 1, ok: false, error: "session is gone" }); return; }
            try {
              const admitted = await ctx.session.prompt({ sessionID: id, text: frame.note, delivery: "queue",
                metadata: { source: "ocs", transport: "local-ipc" } });
              if (admitted.sessionID !== id || admitted.delivery !== "queue") { socket.destroy(); return; }
              reply({ v: 1, ok: true, session_id: id, delivery: "queued" });
            } catch {
              // Admission may have committed before an error. Never claim a safe retry.
              socket.destroy();
            }
          });
        });
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
        server.on("error", () => {});
        if (process.platform !== "win32") chmodSync(socketPath, 0o600);
        const value = { v: 1, plugin_version: 1, harness: "opencode", session_id: id,
          target: "opencode-" + id, name: typeof info.title === "string" ? info.title.replace(/[\r\n\t]/g, " ").slice(0,96) : null,
          pid: process.pid, cwd, socket_path: socketPath, token, registered_at: new Date().toISOString() };
        const tmp = registryPath + "." + randomBytes(8).toString("hex") + ".tmp";
        try {
          writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
          renameSync(tmp, registryPath);
        } catch (error) {
          server.close();
          if (process.platform !== "win32") try { unlinkSync(socketPath); } catch {}
          throw error;
        } finally { try { unlinkSync(tmp); } catch {} }
        return { token, registryPath, socketPath, server, sockets };
      })();
      sessions.set(id, pending);
      try { return await pending; } catch (error) { sessions.delete(id); throw error; }
    }
    // Hook-local identity must never mutate process.env: one server runs many sessions.
    const hooks = [];
    hooks.push(await ctx.session.hook("prompt", async (event) => { await register(event.sessionID); }));
    hooks.push(await ctx.session.hook("context", async (event) => { await register(event.sessionID); }));
    hooks.push(await ctx.tool.transform((editor) => {
      for (const tool of editor.list()) {
        const execute = tool.execute;
        editor.update(tool.id, (draft) => {
          draft.execute = async (input, context) => {
            await register(context.sessionID);
            return scope.run(context.sessionID, () => execute(input, context));
          };
        });
      }
    }));
    hooks.push(await ctx.shell.hook("create.before", (event) => {
      const id = scope.getStore();
      if (id) {
        for (const key of ["CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "OCS_PI_SESSION_ID", "GROK_SESSION_ID", "HERMES_SESSION_ID", "HERMES_SESSION_SOURCE"]) event.env[key] = undefined;
        event.env.OCS_OPENCODE_SESSION_ID = id;
        event.env.OCS_HOME = home;
      }
    }));
    const events = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.deleted", "session.archived", "session.moved"], signal: events.signal })) {
        await stopSession(event.data.sessionID);
      }
    })().finally(async () => {
      if (!events.signal.aborted) {
        closed = true;
        await Promise.all([...sessions.keys()].map(stopSession));
      }
    }).catch(() => {});
    return async () => {
      closed = true;
      events.abort();
      for (const hook of hooks) await hook.dispose();
      await Promise.all([...sessions.keys()].map(stopSession));
    };
  },
};
`;

export function openCodeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const root = env.OPENCODE_CONFIG_DIR;
  return root && isAbsolute(root) ? root : join(env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config"), "opencode");
}
export function openCodePluginPath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  return join(openCodeConfigDir(env, home), "plugins", "ocs.js");
}
export function openCodeSkillPath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  return join(openCodeConfigDir(env, home), "skills", "ocs", "SKILL.md");
}
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { if (readFileSync(path, "utf8") === content) return; } catch {}
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, content, { mode: 0o600, flag: "wx" }); renameSync(tmp, path); }
  finally { try { unlinkSync(tmp); } catch {} }
}
export function installOpenCodeIntegration(skill: string, env: NodeJS.ProcessEnv = process.env, home?: string) {
  const pluginPath = openCodePluginPath(env, home), skillPath = openCodeSkillPath(env, home);
  writeAtomic(pluginPath, OPENCODE_PLUGIN_SOURCE);
  writeAtomic(skillPath, skill);
  return { pluginPath, skillPath };
}
export function openCodePluginCurrent(env: NodeJS.ProcessEnv = process.env, home?: string): boolean {
  try { return readFileSync(openCodePluginPath(env, home), "utf8") === OPENCODE_PLUGIN_SOURCE; } catch { return false; }
}
