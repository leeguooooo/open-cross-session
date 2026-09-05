// CLI 输出的双语目录。英文是 canonical；zh 由 locale/OCS_LANG 选中。
// 规则：新增用户可见字符串必须两种语言同时补齐（TypeScript 结构保证漏一即报错）。

export type Lang = "en" | "zh";

export const OCS_LANG_ENV = "OCS_LANG";

export function detectLang(env: NodeJS.ProcessEnv = process.env): Lang {
  const explicit = env[OCS_LANG_ENV];
  if (explicit === "zh" || explicit === "en") return explicit;
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

interface Catalog {
  help: string;
  stored: (channel: string, seq: number) => string;
  wakeNoMatch: (names: string) => string;
  wakeSelfSkipped: string;
  wakeDelivered: (target: string) => string;
  wakeFailed: (target: string, reason: string) => string;
  /** 唤醒 note 首行（docs/wake-protocol.md §1）。sender=null 是骨架超预算时的降级档。 */
  wakeNoteHeader: (h: { sender: string | null; channel: string; seq: number; replyTo?: number; ago?: string }) => string;
  wakeNoteReply: (command: string) => string;
  wakeNoteThread: (command: string) => string;
  /** 空闲通知三条文案（docs/wake-protocol.md §2，逐字）。 */
  idleNoticeIdle: (target: string, duration: string) => string;
  idleNoticeExited: (target: string) => string;
  idleNoticeExpired: (target: string) => string;
  idleSubscribed: (target: string, id: string) => string;
  idleAlreadySubscribed: (target: string, id: string) => string;
  idleTargetAlreadyIdle: (target: string) => string;
  idleNoTarget: string;
  idleTargetNotLive: (target: string) => string;
  failNotInClaudeSession: string;
  whoIdleSubsHeader: string;
  whoIdleSubLine: (target: string, subscriber: string, expiresIn: string, id: string) => string;
  codexAccepted: (thread: string, turnId: string) => string;
  codexUnknownOutcome: (detail: string) => string;
  codexFailed: (reason: string, detail: string) => string;
  codexCmuxFallback: (thread: string, reason: string, ref: string) => string;
  piWakeAccepted: (target: string) => string;
  piWakeUnknownOutcome: (target: string, detail: string) => string;
  piWakeFailed: (target: string, reason: string, detail: string) => string;
  piWakeUnavailable: (target: string) => string;
  piWakeSelfSkipped: (target: string) => string;
  piWakeAmbiguous: (target: string, matches: string[]) => string;
  dmCodexAmbiguous: (target: string, matches: string[]) => string;
  inboxEmpty: string;
  inboxHeader: (threads: number) => string;
  inboxLine: (unread: number, lastFrom: string, lastAt: string) => string;
  noNewMessages: (channel: string, since: number) => string;
  noClaudeSessions: string;
  noCodexRollouts: string;
  watching: (channel: string, seq: number) => string;
  doctorClaude: string;
  doctorClaudeSessions: (n: number) => string;
  doctorNoClaudeSessions: string;
  doctorInboundAccept: string;
  doctorInboundFixed: (backup: string | null) => string;
  doctorInboundFixFailed: (error: string) => string;
  doctorInboundBad: (value: string) => string;
  doctorSkills: string;
  doctorSkillsOk: string;
  doctorSkillsMissing: (n: number) => string;
  doctorSkillsFixed: string;
  doctorSkillsFixFailed: (detail: string) => string;
  doctorCodex: string;
  doctorIpcOk: (path: string) => string;
  doctorIpcMissing: (path: string) => string;
  doctorIpcRouteOk: string;
  doctorIpcRouteMissing: (thread: string) => string;
  doctorIpcRouteProbeFailed: (detail: string) => string;
  doctorIpcRouteUnverified: string;
  doctorRollouts: (n: number) => string;
  doctorOneRollout: string;
  doctorNoRollouts: string;
  doctorPi: string;
  doctorPiExtensionOk: (path: string) => string;
  doctorPiExtensionFixed: (path: string) => string;
  doctorPiExtensionMissing: (path: string) => string;
  doctorPiSessions: (n: number) => string;
  doctorNoPiSessions: string;
  doctorAccel: string;
  doctorCmuxOk: string;
  doctorCmuxMissing: string;
  doctorData: string;
  doctorDataExists: (path: string) => string;
  doctorDataAuto: (path: string) => string;
  doctorDataFixed: (path: string) => string;
  doctorDataUnsafe: (path: string, mode: string) => string;
  doctorDataNotDirectory: (path: string) => string;
  upgrade: string;
  failSendUsage: string;
  failDmUsage: string;
  failReadUsage: string;
  failNotifyUsage: string;
  failWatchUsage: string;
  failReplyTo: string;
  failSince: string;
  failInterval: string;
  failLimit: string;
  whoClaudeHeader: string;
  whoCodexHeader: (ipc: boolean) => string;
  whoCodexNone: (ipc: boolean) => string;
  whoPiHeader: string;
  whoCmuxHeader: string;
  whoSelfTag: string;
  whoDataHome: (path: string) => string;
  whoCurrentProject: string;
  whoEmpty: string;
  whoCmuxHint: string;
  dmSent: (target: string, channel: string, seq: number) => string;
  dmWorkspaceResolved: (requested: string, current: string, alias: string) => string;
  dmWorkspaceAmbiguous: (target: string, names: string[]) => string;
  dmWorkspaceWarning: (detail: string) => string;
  dmInherited: (requested: string, channel: string) => string;
  dmConversationFailed: (detail: string) => string;
  dmCursorWarning: (detail: string) => string;
  dmParked: (target: string, channel: string) => string;
  dmParkedNew: (target: string, channel: string) => string;
  dmParkedStable: (target: string, channel: string) => string;
  dmPiParked: (target: string, channel: string) => string;
  dmTargetNotFound: (target: string) => string;
  dmCmuxBusy: (ref: string) => string;
  dmCmuxWoken: (ref: string) => string;
  dmCmuxFailed: (ref: string, detail: string) => string;
  whoamiUnknown: string;
  skillInstalled: (path: string) => string;
  piExtensionInstalled: (path: string) => string;
  failNoSelfName: string;
  failName: (name: string) => string;
  failFlagRequired: (flag: string) => string;
  failCodexAddress: (flag: string, value: string) => string;
  failMissingValue: (flag: string) => string;
  failUnknownFlag: (flag: string) => string;
  failExtraArgs: (args: string) => string;
  unknownCommand: (command: string) => string;
}

const en: Catalog = {
  help: `ocs — cross-agent, cross-session coordination on one machine. No server.

Usage:
  ocs who [--verbose | --json]
      Roster of every reachable agent: Claude sessions, Codex tasks, Pi sessions, terminals,
      plus pending idle notifications. Same-project peers come first; --verbose shows raw IDs/paths.
  ocs dm <name-or-id> <text> [--as <name>] [--inherit <old-dm-channel>] [--notify-when-idle]
      Message + wake one agent. Channel is auto-derived; nothing to set up.
      --inherit binds one pre-v0.3.4 DM history channel; both Claude workspaces must be live and unique.
  ocs inbox [--as <name>] [--json]
      List unread threads attributable to this identity; reading still uses the existing ocs read command.
  ocs send <channel> <body> [--as <name>] [--reply-to <seq>] [--no-wake]
           [--notify-when-idle] [--codex <thread-id|codex-8hex>]
           [--codex-source <thread-id|codex-8hex>]
      Append to a channel. @<session-name> wakes a live Claude session;
      @pi-<session-id> wakes Pi; @<thread-id> or --codex targets ChatGPT Desktop.
      --reply-to <seq> also wakes the author of that seq.
      The wake note carries the body (≤4096 bytes) and a copy-paste Reply: line.
      Codex wake needs the target open plus a second open task owned by the same Desktop renderer.
      Exit 2 = stored but wake failed; exit 3 = stored and outcome unknown. Do not resend either:
      the stored #channel/seq is the correlation key.
  ocs read <channel> [--as <name>] [--since <seq>] [--json] [--peek] [--include-self]
      Read new messages since your cursor, then advance it (--peek: don't).
      Your own messages fold to one line unless --include-self.
  ocs notify-when-idle <session-name>
      One-shot: get a notice in this session when that Claude session next goes
      idle or exits (fires at once if already idle; expires after 6h).
      Also available as --notify-when-idle on send/dm (send first, then subscribe).
  ocs whoami
      Print the auto-detected sender identity.
  ocs sessions | codex-sessions [--limit <n>]
      Live Claude sessions or local Codex rollout history; ocs who shows renderer-open Codex tasks.
  ocs watch <channel> [--interval-ms <n>]
      Tail a channel (Ctrl+C to stop).
  ocs doctor [--fix]
      Health-check all wake paths; --fix safely repairs agent skills, the Pi extension,
      data-directory permissions, and crossSessionInbound (backing up settings first).
  ocs skill install
      Install the ocs skill for Claude, Codex, and Pi, plus Pi's direct-wake extension.
  ocs upgrade
      Migration guide to hosted Agent Party (cross-machine channels).
  ocs version | help

--as is optional inside Claude, Codex, and Pi sessions (auto-detected; OCS_NAME also works).
Data directory: ~/.ocs (override with OCS_HOME). Language: OCS_LANG=en|zh.`,
  stored: (channel, seq) => `stored #${channel} seq ${seq}`,
  wakeNoMatch: (names) => `wake: no live Claude session matches @${names}`,
  wakeSelfSkipped: " (you mentioned yourself; skipped)",
  wakeDelivered: (target) => `wake: delivered to inbox → ${target}`,
  wakeFailed: (target, reason) =>
    `wake: stored-only → ${target}: ${reason} (message is already stored; do not resend)`,
  wakeNoteHeader: ({ sender, channel, seq, replyTo, ago }) => {
    const parts = [`seq ${seq}`];
    if (replyTo !== undefined) parts.push(`reply to seq ${replyTo}`);
    if (ago !== undefined) parts.push(ago);
    return sender === null
      ? `[ocs wake] New mention in #${channel} (${parts.join(", ")})`
      : `[ocs wake] ${sender} mentioned you in #${channel} (${parts.join(", ")})`;
  },
  wakeNoteReply: (command) => `Reply: ${command}`,
  wakeNoteThread: (command) => `Thread: ${command}`,
  idleNoticeIdle: (target, duration) =>
    `[Cross-session idle notice] ${target} is now idle. (busy for ${duration})`,
  idleNoticeExited: (target) => `[Cross-session idle notice] ${target} exited before going idle.`,
  idleNoticeExpired: (target) =>
    `[Cross-session idle notice] ${target} did not go idle within 6h; subscription expired.`,
  idleSubscribed: (target, id) =>
    `notify-when-idle: subscribed → ${target} (one-shot, expires in 6h; id ${id})`,
  idleAlreadySubscribed: (target, id) =>
    `notify-when-idle: already subscribed → ${target} (id ${id}); not duplicated`,
  idleTargetAlreadyIdle: (target) => `notify-when-idle: ${target} is already idle — notice is being delivered now`,
  idleNoTarget: "notify-when-idle: no live Claude session to subscribe to (nothing was woken)",
  idleTargetNotLive: (target) => `notify-when-idle: ${target} is not a live Claude session — run \`ocs who\``,
  failNotInClaudeSession:
    "notify-when-idle needs a session to notify: run this from inside a Claude Code session (no Claude ancestor found)",
  whoIdleSubsHeader: "Pending idle notifications (one-shot; ocs notify-when-idle <name>)",
  whoIdleSubLine: (target, subscriber, expiresIn, id) =>
    `  ${target} → notify ${subscriber} when idle  (expires in ${expiresIn}, id ${id})`,
  codexAccepted: (thread, turnId) => `wake(codex): turn accepted → task ${thread} (turnId ${turnId})`,
  codexUnknownOutcome: (detail) => `wake(codex): outcome unknown (frame was written — do NOT resend): ${detail}`,
  codexFailed: (reason, detail) =>
    `wake(codex): stored-only (${reason})${detail ? `: ${detail}` : ""} (message is already stored; do not resend)`,
  codexCmuxFallback: (thread, reason, ref) =>
    `wake(codex): Desktop ${reason} for ${thread}; woke terminal ${ref} via cmux fallback`,
  piWakeAccepted: (target) => `wake(pi): queued → ${target}`,
  piWakeUnknownOutcome: (target, detail) =>
    `wake(pi): outcome unknown for ${target} (frame was written — do NOT resend)${detail ? `: ${detail}` : ""}`,
  piWakeFailed: (target, reason, detail) =>
    `wake(pi): stored-only → ${target} (${reason})${detail ? `: ${detail}` : ""} (message is already stored; do not resend)`,
  piWakeUnavailable: (target) =>
    `wake(pi): ${target} is not a live registered Pi TUI — run \`ocs skill install\`, then restart Pi`,
  piWakeSelfSkipped: (target) => `wake(pi): ${target} is this Pi session; skipped`,
  piWakeAmbiguous: (target, matches) =>
    `wake(pi): ${target} is open in multiple Pi processes: ${matches.join(", ")} — close the duplicate session`,
  dmCodexAmbiguous: (target, matches) =>
    `Codex address ${target} is ambiguous: ${matches.join(", ")} — use the full thread id from \`ocs who --verbose\``,
  inboxEmpty: "inbox: no unread threads for this identity",
  inboxHeader: (threads) => `Inbox: ${threads} unread thread(s)`,
  inboxLine: (unread, lastFrom, lastAt) =>
    `  ${unread} unread · last from ${lastFrom} at ${lastAt}`,
  noNewMessages: (channel, since) => `#${channel}: no messages with seq > ${since}`,
  noClaudeSessions: "no live Claude sessions (or ~/.claude/sessions unreadable)",
  noCodexRollouts: "no Codex rollouts found (~/.codex/sessions empty or unreadable)",
  watching: (channel, seq) => `watching #${channel} from seq ${seq} (Ctrl+C to stop)`,
  doctorClaude: "Claude side",
  doctorClaudeSessions: (n) => `${n} live Claude session(s) available as wake targets`,
  doctorNoClaudeSessions: "no live Claude sessions (open an interactive Claude Code and retry)",
  doctorInboundAccept: "crossSessionInbound = accept (direct delivery)",
  doctorInboundFixed: (backup) =>
    `crossSessionInbound set to accept${backup ? ` (backup: ${backup})` : ""}; restart open Claude sessions to apply`,
  doctorInboundFixFailed: (error) => `crossSessionInbound fix failed: ${error}`,
  doctorInboundBad: (value) =>
    `crossSessionInbound = ${value} — injected messages queue for manual approval and are silently dropped after 5 minutes. ` +
    'Run `ocs doctor --fix` to set "accept" (backs up the file), or edit ~/.claude/settings.json yourself',
  doctorSkills: "Agent skills",
  doctorSkillsOk: "version-matched ocs skill installed for Claude, Codex, and Pi",
  doctorSkillsMissing: (n) =>
    `${n} agent skill installation(s) missing or outdated — run \`ocs doctor --fix\``,
  doctorSkillsFixed: "updated the ocs skill for Claude, Codex, and Pi",
  doctorSkillsFixFailed: (detail) => `integration repair failed: ${detail}`,
  doctorCodex: "Codex / ChatGPT Desktop side",
  doctorIpcOk: (path) => `Desktop IPC router socket available (${path})`,
  doctorIpcMissing: (path) => `Desktop IPC unavailable (${path} missing or wrong perms) — is ChatGPT Desktop running?`,
  doctorIpcRouteOk: "this Codex task is claimed by an open Desktop renderer (wakeable)",
  doctorIpcRouteMissing: (thread) =>
    `this Codex task (${thread.slice(0, 8)}) is not claimed by an open Desktop renderer; stored messages still appear in \`ocs inbox\`, but wake needs its task view open/selected`,
  doctorIpcRouteProbeFailed: (detail) => `could not verify Desktop renderer routing: ${detail}`,
  doctorIpcRouteUnverified: "renderer routing not verified (run doctor from inside a Codex task)",
  doctorRollouts: (n) => `${n}+ local Codex rollout record(s) found (history only; \`ocs who\` verifies open tasks)`,
  doctorOneRollout: "1 local Codex rollout record found (history only; an open renderer is required for wake)",
  doctorNoRollouts: "no Codex rollouts (have you run codex?)",
  doctorPi: "Pi side",
  doctorPiExtensionOk: (path) => `direct-wake extension installed (${path})`,
  doctorPiExtensionFixed: (path) => `direct-wake extension repaired (${path}); restart open Pi sessions`,
  doctorPiExtensionMissing: (path) =>
    `direct-wake extension missing or outdated (${path}) — run \`ocs skill install\``,
  doctorPiSessions: (n) => `${n} live Pi TUI session(s) registered`,
  doctorNoPiSessions: "no live Pi TUI sessions (restart Pi after installing the extension)",
  doctorAccel: "Optional accelerators",
  doctorCmuxOk: "cmux is running — terminal codex/claude TUIs can be woken too (surface-addressed)",
  doctorCmuxMissing: "cmux not detected (optional; terminal TUIs must join channels themselves)",
  doctorData: "Data directory",
  doctorDataExists: (path) => `${path} exists`,
  doctorDataAuto: (path) => `${path} will be created on first send`,
  doctorDataFixed: (path) => `${path} exists with owner-only permissions`,
  doctorDataUnsafe: (path, mode) =>
    `${path} permissions are ${mode}; other local users may access ocs state — run \`ocs doctor --fix\``,
  doctorDataNotDirectory: (path) => `${path} is not a usable data directory`,
  upgrade: `From local to hosted Agent Party (cross-machine, cross-org channels, same habits):

  1. Install:   curl -fsSL https://agentparty.leeguoo.com/install.sh | sh
  2. Channel:   create one at https://agentparty.leeguoo.com and grab the party join snippet
  3. History:   optionally export with \`ocs read <channel> --as migrator --peek --json\` and replay via party send

Local ocs and hosted party coexist fine: same-machine work stays on ocs, cross-machine goes party.`,
  failSendUsage: "usage: ocs send <channel> <body> [--as <name>]",
  failDmUsage: "usage: ocs dm <name-or-id> <body> [--as <name>]",
  failReadUsage: "usage: ocs read <channel> [--as <name>]",
  failNotifyUsage: "usage: ocs notify-when-idle <session-name>",
  failWatchUsage: "usage: ocs watch <channel>",
  failReplyTo: "--reply-to must be a positive integer seq",
  failSince: "--since must be a non-negative integer",
  failInterval: "--interval-ms must be >= 50",
  failLimit: "--limit must be a positive integer",
  whoClaudeHeader: "Claude Code sessions (wake: @name / ocs dm <name>)",
  whoCodexHeader: (_ipc) =>
    "Open Codex tasks (wake: ocs dm codex-<short-id>; renderer ownership verified)",
  whoCodexNone: (ipc) => ipc
    ? "Codex: no recent rollout is currently claimed by an open Desktop renderer (\`ocs codex-sessions\` shows history)"
    : "Codex: Desktop IPC socket unavailable — open ChatGPT Desktop",
  whoPiHeader: "Pi sessions (wake: ocs dm pi-<short-id>; @ mentions use the full session id)",
  whoCmuxHeader: "cmux terminal surfaces (wake: ocs dm surface:N)",
  whoSelfTag: "  ← you",
  whoDataHome: (path) => `OCS data home: ${path} (sessions must share this directory for DM continuity)`,
  whoCurrentProject: "  [this project]",
  whoEmpty: "no reachable agents found — open a Claude Code, Codex, or Pi session",
  whoCmuxHint: "cmux not detected: terminal TUIs are not listed (they can still join channels themselves)",
  dmSent: (target, channel, seq) => `dm stored → ${target} (channel ${channel}, seq ${seq})`,
  dmWorkspaceResolved: (requested, current, alias) =>
    `resolved ${requested} → ${current} via unique workspace alias ${alias}`,
  dmWorkspaceAmbiguous: (target, names) =>
    `workspace address ${target} is ambiguous: ${names.join(", ")} — use an exact live name from \`ocs who\``,
  dmWorkspaceWarning: (detail) => `workspace continuity disabled: ${detail}`,
  dmInherited: (requested, channel) => `DM history inherited: ${requested} → ${channel}`,
  dmConversationFailed: (detail) => `cannot resolve DM conversation: ${detail}`,
  dmCursorWarning: (detail) =>
    `warning: message is stored, but the sender cursor could not be advanced (${detail}); delivery will continue`,
  dmParked: (target, channel) =>
    `${target} has no live session right now — NOT woken. The message is in ${channel}, but only that exact name can read it; a restarted session with a new name will not discover it. Run \`ocs who\` to find a live workspace alias, or pin OCS_NAME/--as.`,
  dmParkedNew: (target, channel) =>
    `${target} has no live session — NOT woken. This created a new DM channel ${channel}; a restarted session with a different name will not discover or read it. Run \`ocs who\` and send to its live workspace alias instead.`,
  dmParkedStable: (target, channel) =>
    `${target} has no live session — NOT woken. The message was appended to stable workspace DM ${channel}; the peer can read it after restart by using the same workspace alias, but ocs does not auto-nudge offline sessions.`,
  dmPiParked: (target, channel) =>
    `${target} is not a live registered Pi TUI — NOT woken. The message is in ${channel}; run \`ocs skill install\` and restart Pi before retrying.`,
  dmTargetNotFound: (target) =>
    `target not found: ${target} — run \`ocs who\` to see reachable agents`,
  dmCmuxBusy: (ref) =>
    `${ref} is mid-turn; not interrupting. The message is in the channel — it will be read on the next turn, or retry later`,
  dmCmuxWoken: (ref) => `woke terminal ${ref} via cmux`,
  dmCmuxFailed: (ref, detail) => `cmux wake failed for ${ref}: ${detail}`,
  whoamiUnknown:
    "cannot tell who you are: not inside a registered Claude/Codex/Pi session, and OCS_NAME is unset. Pass --as <name> or export OCS_NAME",
  skillInstalled: (path) => `skill installed: ${path}`,
  piExtensionInstalled: (path) => `Pi direct-wake extension installed: ${path} — restart open Pi sessions`,
  failNoSelfName:
    "cannot infer sender name (not inside a registered Claude/Codex/Pi session). Pass --as <name> or export OCS_NAME",
  failName: (name) => `invalid name: ${name}`,
  failFlagRequired: (flag) => `--${flag} <value> is required`,
  failCodexAddress: (flag, value) =>
    `--${flag} must be a full thread id or an unambiguous codex-<8hex> address from \`ocs who\`: ${value}`,
  failMissingValue: (flag) => `--${flag} requires a value`,
  failUnknownFlag: (flag) => `unknown flag: --${flag}`,
  failExtraArgs: (args) => `unexpected extra arguments: ${args}`,
  unknownCommand: (command) => `unknown command: ${command}`,
};

const zh: Catalog = {
  help: `ocs — 跨 agent 的 cross-session，本机直连，零服务器

用法:
  ocs who [--verbose | --json]
      全机 agent 花名册：Claude 会话、Codex 任务、Pi 会话、终端，都在一张表里，
      外加待触发的空闲通知；当前项目优先，--verbose 显示底层 ID/路径
  ocs dm <名字或id> <内容> [--as <name>] [--inherit <旧dm频道>] [--notify-when-idle]
      给一个 agent 发消息并唤醒；频道自动派生，什么都不用建
      --inherit 一次性绑定 v0.3.4 之前的 DM 历史；双方 Claude 工作区必须在线且唯一
  ocs inbox [--as <name>] [--json]
      列出能可靠归属给当前身份的未读线程；读取仍复用现有 ocs read 命令
  ocs send <channel> <body> [--as <name>] [--reply-to <seq>] [--no-wake]
           [--notify-when-idle] [--codex <thread-id|codex-8hex>]
           [--codex-source <thread-id|codex-8hex>]
      往频道追加消息；@<会话名> 唤醒活 Claude 会话，@pi-<session-id>
      唤醒 Pi；@<thread-id> 或 --codex 投给 ChatGPT Desktop 任务
      --reply-to <seq> 同时唤醒那条消息的作者
      唤醒 note 直接带正文（≤4096 字节）和一行可直接复制的回复命令
      Codex 唤醒要求目标 task 已打开，并且同一 Desktop renderer 下另有一个已打开的 source task
      退出码 2 = 消息已落盘但唤醒失败；退出码 3 = 已落盘且结果未知。两者都不要重发：
      已落盘的 #channel/seq 就是追查键
  ocs read <channel> [--as <name>] [--since <seq>] [--json] [--peek] [--include-self]
      从上次游标读新消息并推进游标；--peek 只读不推进
      自己发的消息默认折叠成一行，--include-self 完整显示
  ocs notify-when-idle <会话名>
      一次性订阅：那个 Claude 会话下次空闲或退出时通知本会话
      （订阅时已空闲则立即通知；6 小时后过期）
      send/dm 也可带 --notify-when-idle（先发消息再订阅）
  ocs whoami
      看自动识别出的发送者身份
  ocs sessions | codex-sessions [--limit <n>]
      活 Claude 会话或本地 Codex rollout 历史；ocs who 才显示 renderer 已打开的 Codex task
  ocs watch <channel> [--interval-ms <n>]
      跟踪频道新消息（Ctrl+C 退出）
  ocs doctor [--fix]
      体检全部唤醒链；--fix 安全修复三端 skill、Pi 扩展、数据目录权限，
      并在备份后把 crossSessionInbound 设为 accept
  ocs skill install
      给 Claude、Codex、Pi 安装 ocs skill，并安装 Pi 直投扩展
  ocs upgrade
      迁移到托管版 Agent Party（跨机器、跨组织频道）
  ocs version | help

在 Claude、Codex、Pi 会话里 --as 可省略（自动识别；OCS_NAME 也行）。
数据目录: ~/.ocs（OCS_HOME 可覆盖）。语言: OCS_LANG=en|zh。`,
  stored: (channel, seq) => `已落盘 #${channel} seq ${seq}`,
  wakeNoMatch: (names) => `wake: 没有匹配 @${names} 的活 Claude 会话`,
  wakeSelfSkipped: "（@ 到了自己，已跳过）",
  wakeDelivered: (target) => `wake: 已投递收件箱 → ${target}`,
  wakeFailed: (target, reason) => `wake: 仅落盘 → ${target}: ${reason}（消息已经落盘，请勿重发）`,
  wakeNoteHeader: ({ sender, channel, seq, replyTo, ago }) => {
    const parts = [`seq ${seq}`];
    if (replyTo !== undefined) parts.push(`回复 seq ${replyTo}`);
    if (ago !== undefined) parts.push(ago);
    return sender === null
      ? `[ocs 唤醒] #${channel} 提到了你（${parts.join("，")}）`
      : `[ocs 唤醒] ${sender} 在 #${channel} 提到了你（${parts.join("，")}）`;
  },
  wakeNoteReply: (command) => `回复：${command}`,
  wakeNoteThread: (command) => `线程：${command}`,
  idleNoticeIdle: (target, duration) => `[跨会话空闲通知] ${target} 现在空闲了（忙了 ${duration}）。`,
  idleNoticeExited: (target) => `[跨会话空闲通知] ${target} 在空闲前已退出。`,
  idleNoticeExpired: (target) => `[跨会话空闲通知] ${target} 6 小时内没有空闲，订阅已过期。`,
  idleSubscribed: (target, id) => `notify-when-idle: 已订阅 → ${target}（一次性，6 小时后过期；id ${id}）`,
  idleAlreadySubscribed: (target, id) => `notify-when-idle: 已经订阅过 → ${target}（id ${id}），不重复`,
  idleTargetAlreadyIdle: (target) => `notify-when-idle: ${target} 现在就是空闲的——通知正在投递`,
  idleNoTarget: "notify-when-idle: 没有可订阅的活 Claude 会话（没有唤醒任何人）",
  idleTargetNotLive: (target) => `notify-when-idle: ${target} 不是活着的 Claude 会话——跑 \`ocs who\` 看看`,
  failNotInClaudeSession: "notify-when-idle 需要一个收通知的会话：请在 Claude Code 会话里运行（祖先进程里没找到 Claude）",
  whoIdleSubsHeader: "待触发的空闲通知（一次性；ocs notify-when-idle <名字>）",
  whoIdleSubLine: (target, subscriber, expiresIn, id) =>
    `  ${target} 空闲时通知 ${subscriber}  （${expiresIn} 后过期，id ${id}）`,
  codexAccepted: (thread, turnId) => `wake(codex): turn 已接受 → task ${thread}（turnId ${turnId}）`,
  codexUnknownOutcome: (detail) => `wake(codex): 结果未知（帧已写出，勿重发）: ${detail}`,
  codexFailed: (reason, detail) =>
    `wake(codex): 仅落盘（${reason}）${detail ? `: ${detail}` : ""}（消息已经落盘，请勿重发）`,
  codexCmuxFallback: (thread, reason, ref) =>
    `wake(codex): Desktop 对 ${thread} 返回 ${reason}；已自动降级由 cmux 唤醒终端 ${ref}`,
  piWakeAccepted: (target) => `wake(pi): 已排队 → ${target}`,
  piWakeUnknownOutcome: (target, detail) =>
    `wake(pi): ${target} 结果未知（帧已写出，勿重发）${detail ? `: ${detail}` : ""}`,
  piWakeFailed: (target, reason, detail) =>
    `wake(pi): 仅落盘 → ${target}（${reason}）${detail ? `: ${detail}` : ""}（消息已经落盘，请勿重发）`,
  piWakeUnavailable: (target) =>
    `wake(pi): ${target} 不是已登记的活 Pi TUI——先跑 \`ocs skill install\`，再重启 Pi`,
  piWakeSelfSkipped: (target) => `wake(pi): ${target} 是当前 Pi 会话，已跳过`,
  piWakeAmbiguous: (target, matches) =>
    `wake(pi): ${target} 同时被多个 Pi 进程打开：${matches.join("、")}——请关闭重复会话`,
  dmCodexAmbiguous: (target, matches) =>
    `Codex 地址 ${target} 不唯一：${matches.join("、")}——请从 \`ocs who --verbose\` 复制完整 thread id`,
  inboxEmpty: "inbox：当前身份没有未读线程",
  inboxHeader: (threads) => `收件箱：${threads} 个未读线程`,
  inboxLine: (unread, lastFrom, lastAt) =>
    `  ${unread} 条未读 · 最后一条来自 ${lastFrom}（${lastAt}）`,
  noNewMessages: (channel, since) => `#${channel}: 没有 seq > ${since} 的新消息`,
  noClaudeSessions: "没有活着的 Claude 会话（或 ~/.claude/sessions 不可读）",
  noCodexRollouts: "没有找到 Codex rollout（~/.codex/sessions 为空或不可读）",
  watching: (channel, seq) => `watching #${channel} from seq ${seq}（Ctrl+C 退出）`,
  doctorClaude: "Claude 侧",
  doctorClaudeSessions: (n) => `${n} 个活着的 Claude 会话可作唤醒目标`,
  doctorNoClaudeSessions: "没有活着的 Claude 会话（开一个交互式 Claude Code 再试）",
  doctorInboundAccept: "crossSessionInbound = accept（注入直投，真送达）",
  doctorInboundFixed: (backup) =>
    `crossSessionInbound 已设为 accept${backup ? `（原文件备份在 ${backup}）` : ""}；已开着的 Claude 会话要重启后生效`,
  doctorInboundFixFailed: (error) => `crossSessionInbound 修复失败：${error}`,
  doctorInboundBad: (value) =>
    `crossSessionInbound = ${value} — 注入会进待审队列，5 分钟无人处理即静默丢弃。` +
    "跑 `ocs doctor --fix` 一键设为 accept（写前自动备份），或手动改 ~/.claude/settings.json",
  doctorSkills: "Agent 技能",
  doctorSkillsOk: "Claude、Codex、Pi 都已安装版本匹配的 ocs skill",
  doctorSkillsMissing: (n) => `${n} 处 agent skill 缺失或版本过旧——运行 \`ocs doctor --fix\``,
  doctorSkillsFixed: "已更新 Claude、Codex、Pi 的 ocs skill",
  doctorSkillsFixFailed: (detail) => `集成修复失败：${detail}`,
  doctorCodex: "Codex / ChatGPT Desktop 侧",
  doctorIpcOk: (path) => `Desktop IPC 路由 socket 存在（${path}）`,
  doctorIpcMissing: (path) => `Desktop IPC 不可用（${path} 缺失或权限不对）——ChatGPT Desktop 开着吗？`,
  doctorIpcRouteOk: "当前 Codex task 已被打开的 Desktop renderer 认领（可唤醒）",
  doctorIpcRouteMissing: (thread) =>
    `当前 Codex task（${thread.slice(0, 8)}）未被打开的 Desktop renderer 认领；持久消息仍会进入 \`ocs inbox\`，但主动唤醒需要打开或选中该 task 页面`,
  doctorIpcRouteProbeFailed: (detail) => `无法验证 Desktop renderer 路由：${detail}`,
  doctorIpcRouteUnverified: "尚未验证 renderer 路由（请从 Codex task 内运行 doctor）",
  doctorRollouts: (n) => `找到 ${n}+ 条本地 Codex rollout 记录（只是历史；\`ocs who\` 才验证打开的 task）`,
  doctorOneRollout: "找到 1 条本地 Codex rollout 记录（只是历史；唤醒仍需要打开的 renderer）",
  doctorNoRollouts: "没有 Codex rollout（跑过 codex 吗？）",
  doctorPi: "Pi 侧",
  doctorPiExtensionOk: (path) => `直投扩展已安装（${path}）`,
  doctorPiExtensionFixed: (path) => `直投扩展已修复（${path}）；已打开的 Pi 会话需要重启`,
  doctorPiExtensionMissing: (path) => `直投扩展缺失或过期（${path}）——跑 \`ocs skill install\``,
  doctorPiSessions: (n) => `${n} 个活着的 Pi TUI 会话已登记`,
  doctorNoPiSessions: "没有活着的 Pi TUI 会话（安装扩展后重启 Pi）",
  doctorAccel: "可选加速器",
  doctorCmuxOk: "cmux 在运行——终端里的 codex/claude TUI 也能被唤醒（按 surface 寻址）",
  doctorCmuxMissing: "cmux 未检测到（可选，不影响核心功能；终端 TUI 需自己先进频道）",
  doctorData: "数据目录",
  doctorDataExists: (path) => `${path} 存在`,
  doctorDataAuto: (path) => `${path} 首次 send 时自动创建`,
  doctorDataFixed: (path) => `${path} 已存在且仅当前用户可访问`,
  doctorDataUnsafe: (path, mode) => `${path} 权限是 ${mode}，其他本机用户可能访问 ocs 状态——运行 \`ocs doctor --fix\``,
  doctorDataNotDirectory: (path) => `${path} 不是可用的数据目录`,
  upgrade: `单机版到托管版 Agent Party（跨机器、跨组织频道，同一套使用习惯）：

  1. 安装:  curl -fsSL https://agentparty.leeguoo.com/install.sh | sh
  2. 建频道: 打开 https://agentparty.leeguoo.com 创建频道，拿到 party join 片段
  3. 迁历史: ocs read <channel> --as migrator --peek --json 导出后用 party send 回放（可选）

本地 ocs 与托管 party 可以并存：本机小事走 ocs，跨机协作走 party。`,
  failSendUsage: "用法: ocs send <channel> <body> [--as <name>]",
  failDmUsage: "用法: ocs dm <名字或id> <内容> [--as <name>]",
  failReadUsage: "用法: ocs read <channel> [--as <name>]",
  failNotifyUsage: "用法: ocs notify-when-idle <会话名>",
  failWatchUsage: "用法: ocs watch <channel>",
  failReplyTo: "--reply-to 必须是正整数 seq",
  failSince: "--since 必须是非负整数",
  failInterval: "--interval-ms 必须 >= 50",
  failLimit: "--limit 必须是正整数",
  whoClaudeHeader: "Claude Code 会话（唤醒: @名字 / ocs dm <名字>）",
  whoCodexHeader: (_ipc) =>
    "已打开的 Codex task（唤醒: ocs dm codex-<短id>；renderer ownership 已验证）",
  whoCodexNone: (ipc) => ipc
    ? "Codex：近期 rollout 当前都没有被打开的 Desktop renderer 认领（\`ocs codex-sessions\` 可看历史）"
    : "Codex：Desktop IPC socket 不可用——请打开 ChatGPT Desktop",
  whoPiHeader: "Pi 会话（唤醒: ocs dm pi-<短id>；@ 提及仍使用完整 session id）",
  whoCmuxHeader: "cmux 终端 surface（唤醒: ocs dm surface:N）",
  whoSelfTag: "  ← 你自己",
  whoDataHome: (path) => `OCS 数据目录：${path}（要继续同一 DM 历史，各会话必须共用此目录）`,
  whoCurrentProject: "  [当前项目]",
  whoEmpty: "没发现可达的 agent——开一个 Claude Code、Codex 或 Pi 会话",
  whoCmuxHint: "cmux 未检测到：终端 TUI 不在列表里（它们仍可自己进频道）",
  dmSent: (target, channel, seq) => `dm 已落盘 → ${target}（频道 ${channel}，seq ${seq}）`,
  dmWorkspaceResolved: (requested, current, alias) =>
    `通过唯一工作区别名 ${alias} 解析 ${requested} → ${current}`,
  dmWorkspaceAmbiguous: (target, names) =>
    `工作区地址 ${target} 不唯一：${names.join("、")}——请从 \`ocs who\` 里选精确的实时名字`,
  dmWorkspaceWarning: (detail) => `工作区历史延续已停用：${detail}`,
  dmInherited: (requested, channel) => `已继承 DM 历史：${requested} → ${channel}`,
  dmConversationFailed: (detail) => `无法解析 DM 会话：${detail}`,
  dmCursorWarning: (detail) => `警告：消息已写入，但发送方 cursor 推进失败（${detail}）；仍继续投递`,
  dmParked: (target, channel) =>
    `${target} 当前没有活会话——**没有被唤醒**。消息在 ${channel}，但只有这个精确名字能读；重启后换了名字的会话不会发现它。请运行 \`ocs who\` 查找实时工作区别名，或用 OCS_NAME/--as 固定名字。`,
  dmParkedNew: (target, channel) =>
    `${target} 当前没有活会话——**没有被唤醒**。这次发送新建了 DM 频道 ${channel}；对方若已重启并更名，将不会发现或读到它。请运行 \`ocs who\`，改发到实时工作区别名。`,
  dmParkedStable: (target, channel) =>
    `${target} 当前没有活会话——**没有被唤醒**。消息已追加到稳定工作区 DM ${channel}；对方重启后使用同一工作区别名即可读取，但 ocs 不会自动催收离线会话。`,
  dmPiParked: (target, channel) =>
    `${target} 不是已登记的活 Pi TUI——**没有被唤醒**。消息已写入 ${channel}；先跑 \`ocs skill install\` 并重启 Pi，再重试。`,
  dmTargetNotFound: (target) => `找不到目标: ${target}——跑 \`ocs who\` 看可达的 agent`,
  dmCmuxBusy: (ref) => `${ref} 正在跑一轮，不打断。消息已在频道里，它下轮会读到；也可稍后重试`,
  dmCmuxWoken: (ref) => `已经由 cmux 唤醒终端 ${ref}`,
  dmCmuxFailed: (ref, detail) => `cmux 唤醒 ${ref} 失败: ${detail}`,
  whoamiUnknown: "认不出你是谁：不在已登记的 Claude/Codex/Pi 会话里，OCS_NAME 也没设。用 --as <name> 或 export OCS_NAME",
  skillInstalled: (path) => `技能已安装: ${path}`,
  piExtensionInstalled: (path) => `Pi 直投扩展已安装: ${path}——已打开的 Pi 会话需要重启`,
  failNoSelfName: "推断不出发送者名字（不在已登记的 Claude/Codex/Pi 会话里）。用 --as <name> 或 export OCS_NAME",
  failName: (name) => `名字不合法: ${name}`,
  failFlagRequired: (flag) => `--${flag} <value> 是必填项`,
  failCodexAddress: (flag, value) =>
    `--${flag} 必须是完整 thread id，或 \`ocs who\` 给出的唯一 codex-<8hex> 短地址：${value}`,
  failMissingValue: (flag) => `--${flag} 后面必须带值`,
  failUnknownFlag: (flag) => `未知参数: --${flag}`,
  failExtraArgs: (args) => `多余的参数: ${args}`,
  unknownCommand: (command) => `未知命令: ${command}`,
};

const catalogs: Record<Lang, Catalog> = { en, zh };

export function messages(lang: Lang = detectLang()): Catalog {
  return catalogs[lang];
}
