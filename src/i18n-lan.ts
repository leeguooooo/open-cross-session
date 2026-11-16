// `ocs lan …` 与跨机 DM 的双语文案。独立成文件免得 i18n.ts 再膨胀；规则同 i18n.ts：
// 英文 canonical，两种语言同一个接口，漏一条 tsc 就报错。

import type { Lang } from "./i18n.ts";

const INSTALL_SH = "curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh";
const INSTALL_PS = "irm https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.ps1 | iex";

export interface LanCatalog {
  help: string;
  usage: string;
  upStarted: (name: string, port: number, fp: string, discover: boolean) => string;
  upAlready: (pid: number, port: number) => string;
  upFailed: (detail: string) => string;
  upFirewallHint: string;
  upFirewallAllowed: string;
  downDone: (pid: number) => string;
  downNotRunning: string;
  downNotOurs: (pid: number) => string;
  statusRunning: (s: { pid: number; name: string; bind: string; port: number; discover: boolean; version: string; started: string }) => string;
  statusStopped: string;
  statusIdentity: (fp: string) => string;
  statusPeers: (count: number) => string;
  statusOffers: (count: number) => string;
  peersNone: string;
  peerLine: (label: string, name: string, fp: string, addr: string, lastSeen: string, terms: string) => string;
  peerRenewHint: (label: string) => string;
  peerExpired: (label: string, at: string) => string;
  peerUsedUp: (label: string) => string;
  peerExpiringSoon: (label: string, span: string, at: string) => string;
  rejectedByPeer: (label: string, me: string) => string;
  whoRejected: (label: string, detail: string) => string;
  whoExpired: (label: string, at: string) => string;
  whoUsedUp: (label: string) => string;
  termsForever: string;
  termsExpired: (at: string) => string;
  termsUsedUp: string;
  termsUntil: (span: string, at: string) => string;
  termsUses: (n: number) => string;
  termsJoin: string;
  grantConflict: string;
  badDuration: (value: string) => string;
  trustUsage: string;
  trustUpdated: (label: string, terms: string) => string;
  trustLocalOnly: string;
  pairInvite: (i: { name: string; target: string; addrs: string[]; terms: string; minutes: number }) => string;
  pairTermsLine: (terms: string) => string;
  pairWaitingRequest: string;
  pairRequestShown: (name: string, addr: string, sas: string, fp: string) => string;
  pairAskConfirm: string;
  pairApproveHint: (sas: string) => string;
  pairRequestRejected: string;
  pairRequestWithdrawn: string;
  decideNone: string;
  approveMismatch: (given: string) => string;
  approveDone: (name: string) => string;
  joinBadTarget: (target: string) => string;
  joinDaemonHint: string;
  joinShowSas: (serverName: string, sas: string) => string;
  joinErrorHint: (code: string) => string | null;
  pairNeedsDaemon: string;
  pairIssued: (code: string, minutes: number) => string;
  pairAddrHint: (addrs: string) => string;
  pairWaiting: string;
  pairIssuerDone: (label: string, name: string, fp: string) => string;
  pairExpired: string;
  pairBurned: string;
  pairCancelled: string;
  pairJoined: (label: string, name: string, fp: string, addr: string) => string;
  pairFailed: (code: string, detail: string) => string;
  pairCheckFingerprint: string;
  scanNone: string;
  scanLine: (name: string, fp: string, host: string, port: number, label: string | null) => string;
  unpaired: (label: string) => string;
  peerNotFound: (query: string) => string;
  badLabel: (label: string) => string;
  badPort: (port: string) => string;
  dmAddressInvalid: (target: string) => string;
  dmFlagUnsupported: (flag: string) => string;
  dmSent: (target: string, channel: string, seq: number) => string;
  dmLocalCopy: (channel: string, seq: number) => string;
  dmLocalCopyFailed: (detail: string) => string;
  dmRemoteLine: (peer: string, line: string) => string;
  dmRefused: (target: string, error: string, detail: string) => string;
  dmUnknown: (peer: string, detail: string) => string;
  offline: (peer: string, detail: string) => string;
  keyMismatch: (peer: string, addrs: string) => string;
  whoHeader: (label: string, name: string) => string;
  whoOffline: (label: string, detail: string) => string;
  whoEntry: (address: string, kind: string, status: string, label: string) => string;
  whoEmpty: string;
  whoNoPeers: string;
  whoHint: (count: number) => string;
  dmOnLanPeer: (target: string, addresses: string[]) => string;
  stateError: (detail: string) => string;
  autostartOn: (where: string) => string;
  autostartOff: (removed: boolean) => string;
  autostartUnsupported: string;
  statusAutostart: (state: "on" | "stale" | "off") => string;
  doctorHeader: string;
  doctorOff: string;
  doctorRunning: (name: string, port: number, peers: number) => string;
  doctorNoPeers: string;
  doctorAutostartOff: string;
}

const en: LanCatalog = {
  help: `  ocs lan up [--port <n>] [--bind <ip>] [--name <name>] [--no-discover | --discover]
      Start the LAN daemon (off by default). Only paired machines can reach your agents.
  ocs lan pair [--forever | [--once] [--for <30m|8h|7d>]] [--label <name>]
      Print a pairing text to send to the other person and wait for their request;
      you confirm it by comparing a 6-digit code. Trust lasts 8h unless you say otherwise
      (--forever is meant for your own devices and cannot be combined with --once / --for;
      --once and --for can be combined).
  ocs lan join <key> [--addr <host:port>[,…]] [--label <name>]   the command inside that text
  ocs lan approve <6-digit code> | reject       answer a request when \`pair\` has no terminal
  ocs lan trust <peer> --forever | [--once] [--for <d>]   change how long this machine trusts a peer
      (also renews an expired one without pairing again)
  ocs lan pair --code … / ocs lan pair <code>   older one-time-code pairing (works with ocs 0.6/0.7)
  ocs lan status | peers | scan | who [<peer>] | unpair <peer> | down | autostart on|off
      Then: ocs dm <address>@<peer> <text>; ocs who --lan lists remote agents.`,
  usage: "usage: ocs lan up|down|status|pair [<code>]|join <key>|approve <code>|reject|trust <peer>|peers|scan|who [<peer>]|unpair <peer>|autostart on|off",
  upStarted: (name, port, fp, discover) =>
    `lan: daemon up as ${name} on port ${port} (key ${fp})${discover ? "" : " — discovery off"}`,
  upAlready: (pid, port) => `lan: daemon already running (pid ${pid}, port ${port}); \`ocs lan down\` first to change settings`,
  upFailed: (detail) => `lan: daemon did not start: ${detail}`,
  upFirewallHint: "  could not register ocs with the macOS firewall — allow incoming connections for ocs in System Settings › Network › Firewall, or peers cannot reach you.",
  upFirewallAllowed: "  macOS firewall: incoming connections allowed for this ocs binary",
  downDone: (pid) => `lan: daemon stopped (pid ${pid})`,
  downNotRunning: "lan: daemon is not running",
  downNotOurs: (pid) => `lan: pid ${pid} in daemon.json is not an ocs lan daemon; removed the stale state file`,
  statusRunning: (s) =>
    `lan: running — pid ${s.pid}, ${s.name} on ${s.bind}:${s.port}, discovery ${s.discover ? "on" : "off"}, ocs ${s.version}, since ${s.started}`,
  statusStopped: "lan: not running (start with `ocs lan up`)",
  statusIdentity: (fp) => `  this machine's key: ${fp}`,
  statusPeers: (count) => `  paired peers: ${count}`,
  statusOffers: (count) => `  open pairing codes: ${count}`,
  peersNone: "lan: no paired peers — run `ocs lan pair` and send the printed text to the other person",
  peerLine: (label, name, fp, addr, lastSeen, terms) => `  ${label}  (${name})  key ${fp}  ${addr}  last seen ${lastSeen}  trust: ${terms}`,
  peerRenewHint: (label) => `      renew here (no re-pairing needed): ocs lan trust ${label} --for 8h   (or --forever for your own device)`,
  peerExpired: (label, at) =>
    `lan: this machine's trust for ${label} expired at ${at}; nothing was sent. Renew it here, no re-pairing needed: \`ocs lan trust ${label} --for 8h\` (or \`--forever\` for your own device)`,
  peerUsedUp: (label) =>
    `lan: ${label} has used up the messages this machine allowed it; nothing was sent. Renew it here, no re-pairing needed: \`ocs lan trust ${label} --for 8h\``,
  peerExpiringSoon: (label, span, at) =>
    `lan: note: this machine's trust for ${label} ends in ${span} (at ${at}). Extend it: \`ocs lan trust ${label} --for 8h\`. ${label} has its own limit for this machine — if you paired with the default, extend it there too.`,
  rejectedByPeer: (label, me) =>
    `${label} no longer accepts this machine: its trust for this machine expired, was used up, or was removed (the reply does not say which). Nothing was sent. Fix it on ${label}, not here: run \`ocs lan peers\` there; if this machine is listed as expired, renew it there with \`ocs lan trust <its name for this machine, normally ${me}> --for 8h\`; if it is not listed, pair again.`,
  whoRejected: (label, detail) => `LAN ${label}: ${detail}`,
  whoExpired: (label, at) =>
    `LAN ${label}: trust expired at ${at} — not contacted. Renew on this machine, no re-pairing needed: \`ocs lan trust ${label} --for 8h\` (or \`--forever\`)`,
  whoUsedUp: (label) =>
    `LAN ${label}: allowed messages used up — not contacted. Renew on this machine: \`ocs lan trust ${label} --for 8h\``,
  termsForever: "permanent",
  termsExpired: (at) => `expired at ${at}`,
  termsUsedUp: "used up",
  termsUntil: (span, at) => `${span} left (until ${at})`,
  termsUses: (n) => `${n} message${n === 1 ? "" : "s"} left`,
  termsJoin: ", ",
  grantConflict: "lan: --forever cannot be combined with --once or --for",
  badDuration: (value) => `lan: bad duration ${value} (want e.g. 30m, 8h, 7d; at least 1m, at most 366d)`,
  trustUsage: "usage: ocs lan trust <peer> --forever | [--once] [--for <30m|8h|7d>]",
  trustUpdated: (label, terms) => `lan: ${label} is now trusted: ${terms}`,
  trustLocalOnly: "  (this only changes how long this machine accepts it; the other side keeps its own limit)",
  pairInvite: (i) => `Send the text between the lines to the person you are pairing with:

──────── copy from here ────────
Pair with me (${i.name}) in ocs so our agents can message each other. On your computer run:

  # only if ocs is not installed yet — macOS / Linux:
  ${INSTALL_SH}
  # Windows PowerShell:
  ${INSTALL_PS}

  ocs lan up
  ocs lan join ${i.target}${i.addrs.length > 0 ? ` --addr ${i.addrs.join(",")}` : ""}

It prints a 6-digit code. Tell me the code; I will confirm it on my side.
Trust: ${i.terms}. This invitation expires in ${i.minutes} min.
──────── copy to here ────────
`,
  pairTermsLine: (terms) => `  trust: ${terms}`,
  pairWaitingRequest: "waiting for a pairing request… (Ctrl+C cancels)",
  pairRequestShown: (name, addr, sas, fp) =>
    `\npairing request from ${name} (${addr}, key ${fp})\n  check code: ${sas}\n  Confirm only if the other person sees exactly this code on their screen.`,
  pairAskConfirm: "  Same code? Allow pairing [y/N] ",
  pairApproveHint: (sas) => `  To allow: ocs lan approve ${sas}    To refuse: ocs lan reject`,
  pairRequestRejected: "request refused; still waiting for other requests",
  pairRequestWithdrawn: "the request was withdrawn (it timed out or the other side gave up)",
  decideNone: "lan: no pairing request is waiting (is `ocs lan pair` still running?)",
  approveMismatch: (given) => `lan: no waiting request has check code ${given}; nothing was approved. If the codes differ, run \`ocs lan reject\`.`,
  approveDone: (name) => `lan: approved ${name}; \`ocs lan pair\` will report when pairing completes`,
  joinBadTarget: (target) => `lan: ${target} is not a pairing key (copy the \`ocs lan join …\` line from the pairing text as is)`,
  joinDaemonHint: "  note: the LAN daemon is not running here — run `ocs lan up` too, or the other side cannot message you back",
  joinShowSas: (serverName, sas) => `connected to ${serverName}. Check code:\n\n    ${sas}\n\nTell them this code and wait for them to confirm… (up to 75 s)`,
  joinErrorHint: (code) => ({
    "no-offer": "the other side is not waiting for a request — ask them to run `ocs lan pair` again",
    busy: "another request is already waiting there — try again in a minute",
    rejected: "the other side refused (the check codes did not match?)",
    timeout: "nobody confirmed in time — ask them to confirm, then run the same command again",
    cancelled: "the other side cancelled the invitation",
    "old-peer": "the other side runs an older ocs — ask them to upgrade (`ocs upgrade`), or use `ocs lan pair --code` there",
    "not-found": "no machine with that key answered — check the --addr in the text, and that `ocs lan up` runs there",
    self: "that pairing text came from this machine",
  } as Record<string, string>)[code] ?? null,
  pairNeedsDaemon: "lan: the daemon must be running to accept a pairing — run `ocs lan up` first",
  pairIssued: (code, minutes) =>
    `Pairing code (one use, expires in ${minutes} min):\n\n    ${code}\n\nOn the other machine run:\n\n    ocs lan pair ${code}\n\nAnyone who types this code can message your agents. Share it only with the machine you mean to pair.`,
  pairAddrHint: (addrs) => `If discovery is blocked on this network, add: --addr <one of ${addrs}>`,
  pairWaiting: "waiting for the other machine… (Ctrl+C cancels the code)",
  pairIssuerDone: (label, name, fp) => `paired with ${label} (${name}), key ${fp}`,
  pairExpired: "the code expired unused",
  pairBurned: "the code was destroyed after too many wrong attempts — someone may be guessing; issue a new one",
  pairCancelled: "code cancelled",
  pairJoined: (label, name, fp, addr) => `paired with ${label} (${name}) at ${addr}, key ${fp}`,
  pairFailed: (code, detail) => `pairing failed (${code}): ${detail}`,
  pairCheckFingerprint: "Tip: compare the key above with `ocs lan status` on the other machine.",
  scanNone: "lan: no ocs instances answered (discovery may be blocked; pairing still works with --addr)",
  scanLine: (name, fp, host, port, label) =>
    `  ${name}  ${host}:${port}  key ${fp}  ${label === null ? "not paired" : `paired as ${label}`}`,
  unpaired: (label) => `lan: removed ${label}; it can no longer reach this machine (it still lists you until it unpairs too)`,
  peerNotFound: (query) => `lan: no paired peer named ${query} (see \`ocs lan peers\`)`,
  badLabel: (label) => `lan: bad name ${label} (lowercase letters, digits, dashes; ≤32)`,
  badPort: (port) => `lan: bad port ${port}`,
  dmAddressInvalid: (target) => `bad remote address ${target} (want <address>@<peer>)`,
  dmFlagUnsupported: (flag) => `--${flag} is not supported for LAN DMs yet`,
  dmSent: (target, channel, seq) => `dm stored on remote → ${target} (channel ${channel}, seq ${seq})`,
  dmLocalCopy: (channel, seq) => `local copy #${channel} seq ${seq}`,
  dmLocalCopyFailed: (detail) => `warning: delivered, but the local copy could not be written: ${detail}`,
  dmRemoteLine: (peer, line) => `  [${peer}] ${line}`,
  dmRefused: (target, error, detail) => `remote refused dm to ${target}: ${error}${detail === "" ? "" : ` (${detail})`}; nothing was stored`,
  dmUnknown: (peer, detail) =>
    `outcome unknown: the request reached ${peer} but no reply came back (${detail}). It may have been stored and delivered — do NOT resend; ask the peer or check \`ocs lan who ${peer}\`.`,
  offline: (peer, detail) => `lan: ${peer} is not reachable (${detail}); nothing was sent. Is \`ocs lan up\` running there?`,
  keyMismatch: (peer, addrs) =>
    `lan: SECURITY: ${addrs} answered with a different key than ${peer}. Its address changed, it was reinstalled, or someone is impersonating it. Nothing was sent. If it was reinstalled, \`ocs lan unpair ${peer}\` and pair again.`,
  whoHeader: (label, name) => `LAN ${label} (${name}):`,
  whoOffline: (label, detail) => `LAN ${label}: offline (${detail})`,
  whoEntry: (address, kind, status, label) => `  ${address}  ${kind}${status === "" ? "" : `  ${status}`}${label === "" ? "" : `  ${label}`}`,
  whoEmpty: "  (no reachable agents)",
  whoNoPeers: "LAN: no paired peers (see `ocs lan pair`)",
  whoHint: (count) => `LAN: ${count} paired peer${count === 1 ? "" : "s"} — \`ocs who --lan\` lists their agents (address them as <address>@<peer>)`,
  dmOnLanPeer: (target, addresses) =>
    `${target} is not a session on this computer, but a paired LAN peer has it: ${addresses.join(", ")}. Nothing was stored. Send with \`ocs dm ${addresses[0]} "<text>"\`${addresses.length > 1 ? " (pick the right peer)" : ""}.`,
  stateError: (detail) => `lan: refusing to use local LAN state: ${detail}`,
  autostartOn: (where) => `lan: the daemon will start at login (${where}); \`ocs lan up\` starts it now`,
  autostartOff: (removed) => removed ? "lan: login autostart removed (a running daemon keeps running; `ocs lan down` stops it)" : "lan: login autostart was not set",
  autostartUnsupported: "lan: login autostart is not supported on this platform",
  doctorHeader: "LAN (other computers)",
  doctorOff: "LAN mode is off (optional): reach agents on your other computers with `ocs lan up` + `ocs lan pair` — see docs/lan.md",
  doctorRunning: (name, port, peers) => `LAN daemon running as ${name} on port ${port}, ${peers} paired peer${peers === 1 ? "" : "s"}`,
  doctorNoPeers: "no paired computers yet: run `ocs lan pair` here and send the printed text to the other one",
  doctorAutostartOff: "LAN daemon will not come back after a restart: `ocs lan autostart on`",
  statusAutostart: (state) => `  start at login: ${state === "on" ? "on" : state === "stale" ? "stale (points at another ocs install — run `ocs lan autostart on`)" : "off (`ocs lan autostart on`)"}`,
};

const zh: LanCatalog = {
  help: `  ocs lan up [--port <n>] [--bind <ip>] [--name <名字>] [--no-discover | --discover]
      启动局域网守护进程（默认关闭）。只有配对过的机器能找到你的 agent
  ocs lan pair [--forever | [--once] [--for <30m|8h|7d>]] [--label <名字>]
      打印一段配对文字发给对方，等对方发来请求；你核对 6 位核对码后确认。
      默认信任 8 小时（--forever 留给自己的设备，不能和 --once / --for 一起用；
      --once 和 --for 可以一起用）
  ocs lan join <公钥> [--addr <host:port>[,…]] [--label <名字>]   配对文字里的那条命令
  ocs lan approve <6 位核对码> | reject        \`pair\` 没有终端可交互时用来确认 / 拒绝
  ocs lan trust <对端> --forever | [--once] [--for <时长>]   改本机对某个对端的信任期限
      （已过期的也能这样续期，不用重新配对）
  ocs lan pair --code … / ocs lan pair <配对码>  旧的一次性配对码方式（兼容 ocs 0.6/0.7）
  ocs lan status | peers | scan | who [<对端>] | unpair <对端> | down | autostart on|off
      之后：ocs dm <地址>@<对端> <内容>；ocs who --lan 列出远端 agent`,
  usage: "用法: ocs lan up|down|status|pair [<配对码>]|join <公钥>|approve <核对码>|reject|trust <对端>|peers|scan|who [<对端>]|unpair <对端>|autostart on|off",
  upStarted: (name, port, fp, discover) =>
    `lan: 守护进程已启动，实例名 ${name}，端口 ${port}（公钥 ${fp}）${discover ? "" : "，局域网发现已关闭"}`,
  upAlready: (pid, port) => `lan: 守护进程已在运行（pid ${pid}，端口 ${port}）；要改设置先 \`ocs lan down\``,
  upFailed: (detail) => `lan: 守护进程没起来：${detail}`,
  upFirewallHint: "  没能在 macOS 防火墙里放行 ocs——请到 系统设置 › 网络 › 防火墙 允许 ocs 的传入连接，否则对端连不进来。",
  upFirewallAllowed: "  macOS 防火墙：已放行这个 ocs 程序的传入连接",
  downDone: (pid) => `lan: 守护进程已停止（pid ${pid}）`,
  downNotRunning: "lan: 守护进程没在运行",
  downNotOurs: (pid) => `lan: daemon.json 里的 pid ${pid} 不是 ocs lan 守护进程；已删掉陈旧状态文件`,
  statusRunning: (s) =>
    `lan: 运行中 — pid ${s.pid}，${s.name} 监听 ${s.bind}:${s.port}，局域网发现${s.discover ? "开" : "关"}，ocs ${s.version}，启动于 ${s.started}`,
  statusStopped: "lan: 未运行（用 `ocs lan up` 启动）",
  statusIdentity: (fp) => `  本机公钥：${fp}`,
  statusPeers: (count) => `  已配对对端：${count}`,
  statusOffers: (count) => `  未兑现的配对码：${count}`,
  peersNone: "lan: 还没有配对的对端——运行 `ocs lan pair`，把打印出来的那段文字发给对方",
  peerLine: (label, name, fp, addr, lastSeen, terms) => `  ${label}（${name}）  公钥 ${fp}  ${addr}  最近互通 ${lastSeen}  信任：${terms}`,
  peerRenewHint: (label) => `      在本机续期（不用重新配对）：ocs lan trust ${label} --for 8h   （自己的设备可用 --forever）`,
  peerExpired: (label, at) =>
    `lan: 本机对 ${label} 的信任已在 ${at} 到期，什么都没发。在本机续期即可，不用重新配对：\`ocs lan trust ${label} --for 8h\`（自己的设备可用 \`--forever\`）`,
  peerUsedUp: (label) =>
    `lan: 本机允许 ${label} 发的消息已经用完，什么都没发。在本机续期即可，不用重新配对：\`ocs lan trust ${label} --for 8h\``,
  peerExpiringSoon: (label, span, at) =>
    `lan: 提醒：本机对 ${label} 的信任还剩 ${span}（到 ${at}）。续期：\`ocs lan trust ${label} --for 8h\`。${label} 对本机的信任期限是它自己的——配对时用的默认期限的话，那边也要续。`,
  rejectedByPeer: (label, me) =>
    `${label} 不再接受本机：它对本机的信任到期了、次数用完了，或者被移除了（应答里分不出是哪种）。什么都没发。要在 ${label} 上处理，不是本机：在那边跑 \`ocs lan peers\`；本机若显示为已到期，就在那边续期 \`ocs lan trust <它给本机起的名字，通常是 ${me}> --for 8h\`；若没列出来，就重新配对。`,
  whoRejected: (label, detail) => `局域网 ${label}：${detail}`,
  whoExpired: (label, at) =>
    `局域网 ${label}：信任已在 ${at} 到期——没有去连。在本机续期即可，不用重新配对：\`ocs lan trust ${label} --for 8h\`（或 \`--forever\`）`,
  whoUsedUp: (label) =>
    `局域网 ${label}：允许的消息次数已用完——没有去连。在本机续期：\`ocs lan trust ${label} --for 8h\``,
  termsForever: "长期",
  termsExpired: (at) => `已在 ${at} 到期`,
  termsUsedUp: "次数已用完",
  termsUntil: (span, at) => `还剩 ${span}（到 ${at}）`,
  termsUses: (n) => `还能收 ${n} 条消息`,
  termsJoin: "，",
  grantConflict: "lan: --forever 不能和 --once / --for 一起用",
  badDuration: (value) => `lan: 时长不合法：${value}（例如 30m、8h、7d；最短 1m，最长 366d）`,
  trustUsage: "用法: ocs lan trust <对端> --forever | [--once] [--for <30m|8h|7d>]",
  trustUpdated: (label, terms) => `lan: 现在对 ${label} 的信任：${terms}`,
  trustLocalOnly: "  （只改本机接受它多久；对方那边的期限由对方自己决定）",
  pairInvite: (i) => `把两条线之间的文字发给要配对的人：

──────── 从这里复制 ────────
和我（${i.name}）配对 ocs，让我们的 agent 能互相发消息。在你的电脑上运行：

  # 还没装 ocs 才需要 — macOS / Linux：
  ${INSTALL_SH}
  # Windows PowerShell：
  ${INSTALL_PS}

  ocs lan up
  ocs lan join ${i.target}${i.addrs.length > 0 ? ` --addr ${i.addrs.join(",")}` : ""}

运行后会显示一个 6 位核对码，把它告诉我，我这边核对一致后确认。
信任期限：${i.terms}。这份邀请 ${i.minutes} 分钟内有效。
──────── 复制到这里 ────────
`,
  pairTermsLine: (terms) => `  信任期限：${terms}`,
  pairWaitingRequest: "等待对方发来配对请求…（Ctrl+C 取消）",
  pairRequestShown: (name, addr, sas, fp) =>
    `\n收到 ${name}（${addr}，公钥 ${fp}）的配对请求\n  核对码：${sas}\n  只有对方屏幕上显示的是同一个核对码才确认。`,
  pairAskConfirm: "  核对码一致？允许配对 [y/N] ",
  pairApproveHint: (sas) => `  允许：ocs lan approve ${sas}    拒绝：ocs lan reject`,
  pairRequestRejected: "已拒绝这个请求；继续等待其他请求",
  pairRequestWithdrawn: "请求已撤回（超时，或对方放弃了）",
  decideNone: "lan: 没有等待确认的配对请求（`ocs lan pair` 还在跑吗？）",
  approveMismatch: (given) => `lan: 没有核对码为 ${given} 的请求，什么都没确认。核对码对不上的话请 \`ocs lan reject\`。`,
  approveDone: (name) => `lan: 已允许 ${name}；配对完成时 \`ocs lan pair\` 那边会显示`,
  joinBadTarget: (target) => `lan: ${target} 不是配对公钥（把配对文字里的 \`ocs lan join …\` 整行原样复制）`,
  joinDaemonHint: "  提示：本机没跑局域网守护进程——也运行一下 `ocs lan up`，否则对方没法给你回消息",
  joinShowSas: (serverName, sas) => `已连上 ${serverName}。核对码：\n\n    ${sas}\n\n把这 6 位数字告诉对方，等对方确认…（最多 75 秒）`,
  joinErrorHint: (code) => ({
    "no-offer": "对方没在等配对请求——请对方重新运行 `ocs lan pair`",
    busy: "对方那边已经有一个请求在等确认——过一分钟再试",
    rejected: "对方拒绝了（核对码对不上？）",
    timeout: "对方没有及时确认——让对方确认后，再跑一次同一条命令",
    cancelled: "对方取消了邀请",
    "old-peer": "对方的 ocs 版本太旧——请对方升级（`ocs upgrade`），或在对方那边用 `ocs lan pair --code`",
    "not-found": "没有找到这个公钥的机器——检查文字里的 --addr，以及对方是否在跑 `ocs lan up`",
    self: "这段配对文字就是本机发出的",
  } as Record<string, string>)[code] ?? null,
  pairNeedsDaemon: "lan: 接受配对需要守护进程在运行——先 `ocs lan up`",
  pairIssued: (code, minutes) =>
    `配对码（一次性，${minutes} 分钟内有效）：\n\n    ${code}\n\n在另一台机器上执行：\n\n    ocs lan pair ${code}\n\n拿到这个码的人就能给你的 agent 发消息。只发给你要配对的那台机器。`,
  pairAddrHint: (addrs) => `这个网络屏蔽了局域网发现的话，加上：--addr <${addrs} 之一>`,
  pairWaiting: "等待对方兑现…（Ctrl+C 作废这个码）",
  pairIssuerDone: (label, name, fp) => `已与 ${label}（${name}）配对，公钥 ${fp}`,
  pairExpired: "配对码过期，没人兑现",
  pairBurned: "错码次数太多，配对码已作废——可能有人在猜；重新出一个",
  pairCancelled: "配对码已作废",
  pairJoined: (label, name, fp, addr) => `已与 ${label}（${name}）配对，地址 ${addr}，公钥 ${fp}`,
  pairFailed: (code, detail) => `配对失败（${code}）：${detail}`,
  pairCheckFingerprint: "提示：可以和对方机器上 `ocs lan status` 显示的公钥核对一下。",
  scanNone: "lan: 没有 ocs 实例应答（可能网络屏蔽了发现；配对仍可用 --addr）",
  scanLine: (name, fp, host, port, label) =>
    `  ${name}  ${host}:${port}  公钥 ${fp}  ${label === null ? "未配对" : `已配对为 ${label}`}`,
  unpaired: (label) => `lan: 已移除 ${label}，它再也连不进本机（对方那边在它也 unpair 之前仍会列出你）`,
  peerNotFound: (query) => `lan: 没有叫 ${query} 的已配对对端（见 \`ocs lan peers\`）`,
  badLabel: (label) => `lan: 名字不合法：${label}（小写字母、数字、短横线，≤32）`,
  badPort: (port) => `lan: 端口不合法：${port}`,
  dmAddressInvalid: (target) => `远端地址不合法：${target}（格式 <地址>@<对端>）`,
  dmFlagUnsupported: (flag) => `局域网 DM 暂不支持 --${flag}`,
  dmSent: (target, channel, seq) => `dm 已在远端落盘 → ${target}（频道 ${channel}，seq ${seq}）`,
  dmLocalCopy: (channel, seq) => `本机副本 #${channel} seq ${seq}`,
  dmLocalCopyFailed: (detail) => `警告：已送达，但本机副本没写成：${detail}`,
  dmRemoteLine: (peer, line) => `  [${peer}] ${line}`,
  dmRefused: (target, error, detail) => `远端拒收发给 ${target} 的 dm：${error}${detail === "" ? "" : `（${detail}）`}；两边都没有落盘`,
  dmUnknown: (peer, detail) =>
    `结果未知：请求已到达 ${peer} 但没收到应答（${detail}）。可能已经落盘并唤醒——不要重发；问对方或查 \`ocs lan who ${peer}\`。`,
  offline: (peer, detail) => `lan: 连不上 ${peer}（${detail}），什么都没发。对方跑着 \`ocs lan up\` 吗？`,
  keyMismatch: (peer, addrs) =>
    `lan: 安全警告：${addrs} 应答的公钥和 ${peer} 的不一致。可能是地址换了、对方重装了，或者有人冒充。什么都没发。确认是重装的话：\`ocs lan unpair ${peer}\` 后重新配对。`,
  whoHeader: (label, name) => `局域网 ${label}（${name}）：`,
  whoOffline: (label, detail) => `局域网 ${label}：离线（${detail}）`,
  whoEntry: (address, kind, status, label) => `  ${address}  ${kind}${status === "" ? "" : `  ${status}`}${label === "" ? "" : `  ${label}`}`,
  whoEmpty: "  （没有可达的 agent）",
  whoNoPeers: "局域网：没有已配对的对端（见 `ocs lan pair`）",
  whoHint: (count) => `局域网：${count} 个已配对对端——\`ocs who --lan\` 列出它们的 agent（地址写成 <地址>@<对端>）`,
  dmOnLanPeer: (target, addresses) =>
    `${target} 不是本机的会话，但已配对的局域网对端上有：${addresses.join("、")}。这条消息没有存。请改用 \`ocs dm ${addresses[0]} "<内容>"\`${addresses.length > 1 ? "（选对那台）" : ""}。`,
  stateError: (detail) => `lan: 本机局域网状态不可信，拒绝使用：${detail}`,
  autostartOn: (where) => `lan: 登录后会自动启动守护进程（${where}）；现在就要用请跑 \`ocs lan up\``,
  autostartOff: (removed) => removed ? "lan: 已取消登录自启（正在跑的守护进程不受影响，停它用 `ocs lan down`）" : "lan: 本来就没设登录自启",
  autostartUnsupported: "lan: 这个平台不支持登录自启",
  doctorHeader: "局域网（其他电脑）",
  doctorOff: "局域网模式未开启（可选）：`ocs lan up` + `ocs lan pair` 就能找到你其他电脑上的 agent，见 docs/lan.md",
  doctorRunning: (name, port, peers) => `局域网守护进程运行中：${name}，端口 ${port}，已配对 ${peers} 台电脑`,
  doctorNoPeers: "还没有配对的电脑：这台跑 `ocs lan pair`，把打印出来的文字发给另一台",
  doctorAutostartOff: "重启后局域网守护进程不会自动回来：`ocs lan autostart on`",
  statusAutostart: (state) => `  登录自启：${state === "on" ? "开" : state === "stale" ? "失效（指向别处的 ocs，重跑 `ocs lan autostart on`）" : "关（`ocs lan autostart on`）"}`,
};

export function lanMessages(lang: Lang): LanCatalog {
  return lang === "zh" ? zh : en;
}
