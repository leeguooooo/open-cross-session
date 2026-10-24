// Protocol fixture compiled as `grok` for process-identity discovery tests.
import { createServer } from "node:net";
import { writeFileSync, unlinkSync } from "node:fs";
const path = process.argv[2]!;
const session = process.argv[3]!;
const log = process.argv[4]!;
writeFileSync(path.replace(/\.sock$/, ".lock"), String(process.pid), { mode: 0o600 });
const frame = (value: unknown) => { const b = Buffer.from(JSON.stringify(value)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h,b]); };
const server = createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on("error", () => {});
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
      const n = buffer.readUInt32BE(0);
      const packet = JSON.parse(buffer.subarray(4,n+4).toString()); buffer = buffer.subarray(n+4);
      if (packet.type === "register") socket.write(frame({ type: "registered", ready: true, leader_protocol_version: 1 }));
      if (packet.type !== "acp") continue;
      const rpc = JSON.parse(packet.payload);
      if (rpc.method === "_x.ai/sessions/list") socket.write(frame({ type: "acp", payload: JSON.stringify({ jsonrpc: "2.0", id: rpc.id,
        result: { result: { sessions: [{ sessionId: session, cwd: "/test/grok", title: "grok fixture", resident: true, activity: "idle", origin: { kind: "local" } }] } } }) }));
      else if (rpc.method === "session/prompt") {
        writeFileSync(log, JSON.stringify(rpc.params) + "\n", { flag: "a", mode: 0o600 });
        socket.write(frame({ type: "acp", payload: JSON.stringify({ jsonrpc: "2.0", method: "_x.ai/queue/changed",
          params: { sessionId: session, entries: [{ id: rpc.params._meta.promptId }] } }) }));
      }
    }
  });
});
server.listen(path, () => console.log("ready"));
process.once("SIGTERM", () => { try { unlinkSync(path.replace(/\.sock$/, ".lock")); } catch {} server.close(() => process.exit()); });
