import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { connectGrok, findGrokLeaders, GrokError, grokSessionIdFromTarget, grokTargetName, listGrokSessions, openGrokPipe, selfGrokSessionId, wakeGrokSession, type GrokConnection } from "../src/grok.ts";
import { buildRoster, canonicalWakeAddress, resolveDmTarget, resolveSelfName, selfIdentity, selfNameOwner } from "../src/roster.ts";
import { isReservedOcsName, setOcsName } from "../src/names.ts";
import { OCS_IDENTITY_RE, readMessages } from "../src/store.ts";
import { entryCapabilities } from "../src/capabilities.ts";
import { handleLanDm, lanWhoEntries, LAN_DAEMON_ENV_STRIP } from "../src/lan-daemon.ts";
import type { WindowsPipeApi, WindowsPipeHandle, WindowsPipeServerFacts } from "../src/codex-ipc-win.ts";
import type { LanPeer } from "../src/lan-store.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";
autoCleanupTempDirs();
const ID = "12345678-1234-4567-8123-123456789abc";
const ADDRESS = grokTargetName(ID);
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const row = { sessionId: ID, cwd: "/work/grok", title: "review", resident: true, activity: "idle", origin: { kind: "local" } };
const roster = (rows: unknown[] = [row]) => ({ result: { sessions: rows } });

function fakeServer(options: { prompt?: "queued" | "running" | "drop" | "silent" | "reject" | "internal" | "wrong-id"; version?: number; ready?: boolean; malformed?: boolean } = {}) {
  const dir = tempDir("ocs-grok-wire-");
  const path = join(dir, "leader.sock");
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket); socket.on("close", () => clients.delete(socket)); socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    const send = (v: unknown) => { const body = Buffer.from(JSON.stringify(v)); const h = Buffer.alloc(4); h.writeUInt32BE(body.length); socket.write(h.subarray(0,2)); socket.write(Buffer.concat([h.subarray(2),body])); };
    const rpc = (v: unknown) => send({ type: "acp", payload: JSON.stringify(v) });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer,chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0)+4) {
        const n=buffer.readUInt32BE(0), packet=JSON.parse(buffer.subarray(4,n+4).toString()); buffer=buffer.subarray(n+4);
        if (packet.type === "register") {
          expect(packet.capabilities).toEqual({});
          send({ type: "registered", ready: options.ready !== false, leader_protocol_version: options.version ?? 1 });
          if (options.ready === false) setTimeout(() => send({type:"leader_ready"}),10);
        } else if (packet.type === "acp") {
          const r=JSON.parse(packet.payload); calls.push(r);
          if (r.method === "_x.ai/sessions/list") rpc({ id:r.id, result: options.malformed ? { sessions:[row] } : roster() });
          else if (r.method === "session/prompt") {
            const mode=options.prompt ?? "queued";
            if (mode === "drop") { socket.destroy(); continue; }
            if (mode === "silent") continue;
            if (mode === "reject" || mode === "internal") { rpc({id:r.id,error:{code:mode==="reject"?-32602:-32603,message:"refused"}}); continue; }
            rpc({id:r.id,method:"session/request_permission",params:{sessionId:ID}});
            // A notification for another prompt/session is never evidence of our admission.
            rpc({method:"_x.ai/queue/changed",params:{sessionId:"wrong",runningPromptId:r.params._meta.promptId}});
            rpc({method:"_x.ai/queue/changed",params:{sessionId:ID,entries:[{id:"wrong"}]}});
            if (mode === "wrong-id") continue;
            rpc({method:"_x.ai/queue/changed",params:{sessionId:ID,
              ...(mode==="running"?{runningPromptId:r.params._meta.promptId}:{entries:[{id:r.params._meta.promptId}]})}});
          }
        }
      }
    });
  });
  server.listen(path);
  cleanup.push(() => { for (const s of clients) s.destroy(); server.close(); });
  return {dir,path,calls,leader:{path,pid:process.pid}};
}

describe.skipIf(process.platform === "win32")("Grok leader native transport", () => {
  test("fragmented frames, readiness, resident roster and exact queue admission", async () => {
    const s=fakeServer({ready:false});
    const deps={leaders:()=>[s.leader], connect:(l:typeof s.leader)=>connectGrok(l,process.platform,300)};
    expect((await listGrokSessions(deps)).sessions).toEqual([{id:ID,cwd:row.cwd,title:row.title,status:"idle"}]);
    expect(await wakeGrokSession(ID,"hello",deps)).toEqual({ok:true,delivery:"queued"});
    const prompt=s.calls.find(c=>c.method==="session/prompt")!;
    expect(prompt.params).toMatchObject({sessionId:ID,prompt:[{type:"text",text:"hello"}],_meta:{clientIdentifier:"ocs",sendNow:false}});
    expect(s.calls.every(c=>!["session/load","session/new","session/cancel","session/set_mode"].includes(c.method))).toBe(true);
  });
  test("running acknowledgement is admission, never completion", async () => {
    const s=fakeServer({prompt:"running"});
    expect(await wakeGrokSession(ID,"hello",{leaders:()=>[s.leader],connect:l=>connectGrok(l,process.platform,200)})).toEqual({ok:true,delivery:"started"});
  });
  for (const mode of ["drop","silent","wrong-id","internal"] as const) test(`${mode} after write is unknown and never replayed`,async()=>{
    const s=fakeServer({prompt:mode});
    const result=await wakeGrokSession(ID,"one task",{leaders:()=>[s.leader],connect:l=>connectGrok(l,process.platform,80)});
    expect(result).toMatchObject({ok:false,reason:"unknown-outcome"});
    expect(s.calls.filter(c=>c.method==="session/prompt")).toHaveLength(1);
  });
  test("explicit invalid-target rejection is failed; incompatible protocol fails before prompt",async()=>{
    const s=fakeServer({prompt:"reject"});
    expect(await wakeGrokSession(ID,"hello",{leaders:()=>[s.leader]})).toMatchObject({ok:false,reason:"failed"});
    const old=fakeServer({version:2});
    expect(await wakeGrokSession(ID,"hello",{leaders:()=>[old.leader]})).toMatchObject({ok:false,reason:"unavailable"});
    expect(old.calls).toHaveLength(0);
  });
  test("nonresident/remote/dead sessions, unsupported schemas and duplicate leaders cannot receive",async()=>{
    let prompts=0;
    const mock=(rows:unknown[]):GrokConnection=>({call:async()=>roster(rows),prompt:async()=>{prompts++;return "queued";},close(){}});
    const leader={path:"unused",pid:process.pid};
    const invalid=[{...row,resident:false},{...row,origin:{kind:"remote"}},{...row,activity:"dead"},{...row,sessionId:"../../escape"}];
    expect((await listGrokSessions({leaders:()=>[leader],connect:async()=>mock(invalid)})).sessions).toEqual([]);
    expect(await wakeGrokSession(ID,"hello",{leaders:()=>[leader],connect:async()=>mock(invalid)})).toEqual({ok:false,reason:"not-open"});
    expect(await wakeGrokSession(ID,"hello",{leaders:()=>[leader,leader],connect:async()=>mock([row])})).toEqual({ok:false,reason:"ambiguous"});
    expect((await listGrokSessions({leaders:()=>[leader,leader],connect:async()=>mock([row])})).sessions).toEqual([]);
    expect(prompts).toBe(0);
    const bad=fakeServer({malformed:true});
    expect(await wakeGrokSession(ID,"hello",{leaders:()=>[bad.leader]})).toMatchObject({ok:false,reason:"unavailable"});
  });
});

test.skipIf(process.platform === "win32")("real CLI discovers, renames, routes DM/@/quiet/replies and LAN without exposing local paths", async () => {
  const dir=tempDir("ocs-grok-cli-");
  const binary=join(dir,"grok");
  const build=Bun.spawn([process.execPath,"build","--compile",join(import.meta.dir,"fixtures/grok-leader.ts"),"--outfile",binary],{stdout:"ignore",stderr:"pipe"});
  expect(await build.exited).toBe(0);
  const socket=join(dir,"leader.sock"),log=join(dir,"prompts.jsonl");
  const server=Bun.spawn([binary,socket,ID,log],{stdout:"pipe",stderr:"pipe"});
  const env={...process.env,OCS_HOME:join(dir,"ocs"),CODEX_HOME:join(dir,"codex"),OCS_CLAUDE_NATIVE_SESSIONS_DIR:join(dir,"claude"),GROK_HOME:dir,GROK_LEADER_SOCKET:socket,
    CODEX_THREAD_ID:"",GROK_SESSION_ID:"",OCS_NAME:"",OCS_PI_SESSION_ID:"",HERMES_SESSION_ID:"",OCS_UPGRADE_CHECK:"0",OCS_LANG:"en"};
  const run=async(args:string[],self=false)=>{
    const p=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli.ts"),...args],{env:{...env,...(self?{GROK_SESSION_ID:ID}:{})},stdout:"pipe",stderr:"pipe"});
    const [out,err]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);
    return {code:await p.exited,out,err};
  };
  try {
    await server.stdout.getReader().read();
    expect(findGrokLeaders(env)).toEqual([{path:socket,pid:server.pid}]);
    const who=await run(["who","--json"]);
    expect(who.code).toBe(0);
    const entries=JSON.parse(who.out).entries.filter((e:{kind:string})=>e.kind==="grok");
    expect(entries).toMatchObject([{target:ADDRESS,sessionId:ID,capabilities:{busyDelivery:"queued"}}]);
    const dm=JSON.parse((await run(["dm",ADDRESS,"review this","--as","tester","--json"])).out);
    expect(dm).toMatchObject({stored:true,wake:"accepted",exit:0});
    const quiet=await run(["dm",ADDRESS,"quiet record","--as","tester","--no-wake","--json"]);
    expect(JSON.parse(quiet.out)).toMatchObject({wake:"skipped"});
    const identity=JSON.parse((await run(["whoami","--json"],true)).out);
    expect(identity).toMatchObject({host:"grok",id:ADDRESS,addresses:[ADDRESS]});
    expect((await run(["rename","grok-reviewer"],true)).code).toBe(0);
    const mention=await run(["send","dev","review @grok-reviewer","--as","tester","--json"]);
    expect(JSON.parse(mention.out)).toMatchObject({wake:"accepted",exit:0});
    expect((await run(["inbox","--json"],true)).out).toContain(dm.channel);
    const reply=await run(["send",dm.channel,"reviewed","--reply-to",String(dm.seq),"--no-wake","--json"],true);
    expect(JSON.parse(reply.out)).toMatchObject({stored:true,wake:"skipped"});
    expect(readMessages(dm.channel,{env}).at(-1)).toMatchObject({from:ADDRESS,body:"reviewed"});
    const self=await run(["dm",ADDRESS,"self record","--json"],true);
    expect(JSON.parse(self.out).lines.join(" ")).toContain("self-wake skipped");
    const peer={fingerprint:"a".repeat(52),label:"other"} as LanPeer;
    const remote=await handleLanDm({op:"dm",from:"reviewer",from_key:"reviewer",to:ADDRESS,body:"LAN task"},peer,"en",env);
    expect(remote).toMatchObject({ok:true});
    const roster=await lanWhoEntries(env);
    const grok=roster.find(e=>e.kind==="grok")!;
    expect(grok).toMatchObject({address:"grok-reviewer",capabilities:{busyDelivery:"queued"}});
    expect(JSON.stringify(grok)).not.toContain(dir);
    expect(JSON.stringify(grok)).not.toContain("pid");
    const channelsBefore=readdirSync(join(env.OCS_HOME,"channels")).filter(n=>n.endsWith(".jsonl"));
    const offline=await handleLanDm({op:"dm",from:"reviewer",from_key:"reviewer",to:grokTargetName("99999999-1234-4567-8123-123456789abc"),body:"must not store"},peer,"en",env);
    expect(offline).toMatchObject({ok:false,error:"not-found"});
    const calls=readFileSync(log,"utf8").trim().split("\n").map(l=>JSON.parse(l));
    expect(calls).toHaveLength(3); // ordinary DM, @mention, LAN; no quiet/self wake.
    expect(calls.every(c=>c._meta.sendNow===false)).toBe(true);
    const channels=readdirSync(join(env.OCS_HOME,"channels"));
    expect(channels.filter(n=>n.endsWith(".jsonl"))).toEqual(channelsBefore);
    chmodSync(socket,0o777);
    expect(findGrokLeaders(env)).toEqual([]);
    chmodSync(socket,0o700);
    const lock=socket.replace(/\.sock$/,".lock");
    writeFileSync(lock,"not-a-pid");
    expect(findGrokLeaders(env)).toEqual([]);
    writeFileSync(lock,String(server.pid));
    const alternate=join(dir,"alternate.lock");
    writeFileSync(alternate,String(server.pid),{mode:0o600});
    unlinkSync(lock);symlinkSync(alternate,lock);
    expect(findGrokLeaders(env)).toEqual([]);
  } finally { server.kill(); await server.exited; }
},60_000);

describe("Grok identity and Windows transport",()=>{
  test("names, DM/inbox route identity, self markers and queued capabilities",()=>{
    const home=tempDir("ocs-grok-identity-");
    const env={OCS_HOME:home,CODEX_HOME:join(home,"codex"),OCS_CLAUDE_NATIVE_SESSIONS_DIR:join(home,"claude"),GROK_SESSION_ID:ID};
    expect(selfGrokSessionId(env)).toBe(ID);
    expect(resolveSelfName(env)).toBe(ADDRESS);
    expect(selfNameOwner(env)).toEqual({kind:"grok",id:ID});
    expect(selfIdentity(ADDRESS)).toBe(`grok:${ID}`);
    expect(OCS_IDENTITY_RE.test(selfIdentity(ADDRESS))).toBe(true);
    expect(grokSessionIdFromTarget(ADDRESS.toUpperCase())).toBe(ID);
    expect(isReservedOcsName(ADDRESS)).toBe(true);
    expect(setOcsName("reviewer",{kind:"grok",id:ID},{env})).toMatchObject({ok:true});
    expect(resolveDmTarget("reviewer",env)).toMatchObject({kind:"grok",identity:`grok:${ID}`,grokSessionId:ID});
    expect(canonicalWakeAddress("reviewer",env)).toBe(ADDRESS);
    const r=buildRoster(env,[],[{id:ID,cwd:"/test",title:null,status:"working"}]);
    const entry=r.entries.find(e=>e.kind==="grok")!;
    expect(entry).toMatchObject({target:ADDRESS,self:true,ocsName:"reviewer"});
    expect(entryCapabilities(entry,r)).toMatchObject({busyDelivery:"queued",noWake:true,batch:true});
    expect(LAN_DAEMON_ENV_STRIP).toContain("GROK_SESSION_ID");
  });
  test("Windows verifies exact server/user/image on the frame-carrying handle; rejected peers get zero bytes",()=>{
    const good:WindowsPipeServerFacts={pipeOwnerSid:"S-1-5-21-1",serverUserSid:"S-1-5-21-1",serverPid:42,serverImagePath:"C:\\Users\\test\\.grok\\bin\\grok.exe",serverPackageFamily:null,serverPackageInstallPath:null};
    const name="grok-leader-0123456789abcdef";
    for(const changes of [{serverPid:43},{serverUserSid:"S-1-5-21-2"},{pipeOwnerSid:"S-1-5-21-2"},{serverImagePath:"C:\\malware.exe"}]) {
      let closed=false,writes=0;
      const handle:WindowsPipeHandle={facts:()=>({...good,...changes}),close:()=>{closed=true;},available:()=>0,read:()=>Buffer.alloc(0),write:()=>{writes++;return 0;}};
      const api:WindowsPipeApi={currentUserSid:()=>good.serverUserSid,open:()=>handle,pipeExists:()=>true};
      expect(()=>openGrokPipe({path:"leader.sock",pid:42},api,[name])).toThrow();
      expect(closed).toBe(true);expect(writes).toBe(0);
    }
    const handle:WindowsPipeHandle={facts:()=>good,close(){},available:()=>0,read:()=>Buffer.alloc(0),write:b=>b.length};
    expect(openGrokPipe({path:"leader.sock",pid:42},{currentUserSid:()=>good.serverUserSid,open:()=>handle,pipeExists:()=>true},[name])).toBe(handle);
  });
});
