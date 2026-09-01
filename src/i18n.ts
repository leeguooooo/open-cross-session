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
  sent: (channel: string, seq: number) => string;
  wakeNoMatch: (names: string) => string;
  wakeSelfSkipped: string;
  wakeDelivered: (target: string) => string;
  wakeFailed: (target: string, reason: string) => string;
  codexAccepted: (thread: string, turnId: string) => string;
  codexUnknownOutcome: (detail: string) => string;
  codexFailed: (reason: string, detail: string) => string;
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
  doctorCodex: string;
  doctorIpcOk: (path: string) => string;
  doctorIpcMissing: (path: string) => string;
  doctorRollouts: (n: number) => string;
  doctorOneRollout: string;
  doctorNoRollouts: string;
  doctorAccel: string;
  doctorCmuxOk: string;
  doctorCmuxMissing: string;
  doctorData: string;
  doctorDataExists: (path: string) => string;
  doctorDataAuto: (path: string) => string;
  upgrade: string;
  failSendUsage: string;
  failReadUsage: string;
  failWatchUsage: string;
  failReplyTo: string;
  failSince: string;
  failInterval: string;
  failLimit: string;
  failName: (name: string) => string;
  failFlagRequired: (flag: string) => string;
  failMissingValue: (flag: string) => string;
  failUnknownFlag: (flag: string) => string;
  failExtraArgs: (args: string) => string;
  unknownCommand: (command: string) => string;
}

const en: Catalog = {
  help: `ocs — cross-agent, cross-session coordination on one machine. No server.

Usage:
  ocs send <channel> <body> --as <name> [--reply-to <seq>] [--no-wake]
           [--codex <thread-id>] [--codex-source <thread-id>]
      Append to the local channel log. @<session-name> wakes a live Claude
      session; @<thread-id> or --codex targets an open ChatGPT Desktop task.
  ocs read <channel> --as <name> [--since <seq>] [--json] [--peek]
      Read new messages since your cursor, then advance it (--peek: don't).
  ocs sessions
      List live Claude Code sessions (their names are @ targets).
  ocs codex-sessions [--limit <n>]
      List local Codex tasks (thread ids for --codex).
  ocs watch <channel> [--interval-ms <n>]
      Tail a channel (Ctrl+C to stop).
  ocs doctor [--fix]
      Health-check both wake paths; --fix sets crossSessionInbound=accept
      (backs up the file first).
  ocs upgrade
      Migration guide to hosted Agent Party (cross-machine channels).
  ocs version | help

Data directory: ~/.ocs (override with OCS_HOME). Language: OCS_LANG=en|zh.`,
  sent: (channel, seq) => `sent #${channel} seq ${seq}`,
  wakeNoMatch: (names) => `wake: no live Claude session matches @${names}`,
  wakeSelfSkipped: " (you mentioned yourself; skipped)",
  wakeDelivered: (target) => `wake: delivered to inbox → ${target}`,
  wakeFailed: (target, reason) => `wake: failed → ${target}: ${reason}`,
  codexAccepted: (thread, turnId) => `wake(codex): turn accepted → task ${thread} (turnId ${turnId})`,
  codexUnknownOutcome: (detail) => `wake(codex): outcome unknown (frame was written — do NOT resend): ${detail}`,
  codexFailed: (reason, detail) => `wake(codex): failed (${reason})${detail ? `: ${detail}` : ""}`,
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
  doctorCodex: "Codex / ChatGPT Desktop side",
  doctorIpcOk: (path) => `Desktop IPC available (${path})`,
  doctorIpcMissing: (path) => `Desktop IPC unavailable (${path} missing or wrong perms) — is ChatGPT Desktop running?`,
  doctorRollouts: (n) => `${n}+ Codex rollouts (IPC wake needs a pair of open tasks; satisfied)`,
  doctorOneRollout: "only 1 Codex rollout — native IPC wake needs a second task under the same renderer as source",
  doctorNoRollouts: "no Codex rollouts (have you run codex?)",
  doctorAccel: "Optional accelerators",
  doctorCmuxOk: "cmux is running — terminal codex/claude TUIs can be woken too (surface-addressed)",
  doctorCmuxMissing: "cmux not detected (optional; terminal TUIs must join channels themselves)",
  doctorData: "Data directory",
  doctorDataExists: (path) => `${path} exists`,
  doctorDataAuto: (path) => `${path} will be created on first send`,
  upgrade: `From local to hosted Agent Party (cross-machine, cross-org channels, same habits):

  1. Install:   curl -fsSL https://agentparty.leeguoo.com/install.sh | sh
  2. Channel:   create one at https://agentparty.leeguoo.com and grab the party join snippet
  3. History:   optionally export with \`ocs read <channel> --as migrator --peek --json\` and replay via party send

Local ocs and hosted party coexist fine: same-machine work stays on ocs, cross-machine goes party.`,
  failSendUsage: "usage: ocs send <channel> <body> --as <name>",
  failReadUsage: "usage: ocs read <channel> --as <name>",
  failWatchUsage: "usage: ocs watch <channel>",
  failReplyTo: "--reply-to must be a positive integer seq",
  failSince: "--since must be a non-negative integer",
  failInterval: "--interval-ms must be >= 50",
  failLimit: "--limit must be a positive integer",
  failName: (name) => `invalid name: ${name}`,
  failFlagRequired: (flag) => `--${flag} <value> is required`,
  failMissingValue: (flag) => `--${flag} requires a value`,
  failUnknownFlag: (flag) => `unknown flag: --${flag}`,
  failExtraArgs: (args) => `unexpected extra arguments: ${args}`,
  unknownCommand: (command) => `unknown command: ${command}`,
};

const zh: Catalog = {
  help: `ocs — 跨 agent 的 cross-session，本机直连，零服务器

用法:
  ocs send <channel> <body> --as <name> [--reply-to <seq>] [--no-wake]
           [--codex <thread-id>] [--codex-source <thread-id>]
      追加消息到本机频道日志；@<会话名> 唤醒活 Claude 会话，@<thread-id>
      或 --codex 投给 ChatGPT Desktop 里开着的任务
  ocs read <channel> --as <name> [--since <seq>] [--json] [--peek]
      从上次游标读新消息并推进游标；--peek 只读不推进
  ocs sessions
      列出本机活着的 Claude 会话（@ 目标就是这里的 name）
  ocs codex-sessions [--limit <n>]
      列出本机 Codex 任务（--codex 的 thread-id 从这里拿）
  ocs watch <channel> [--interval-ms <n>]
      跟踪频道新消息（Ctrl+C 退出）
  ocs doctor [--fix]
      体检两条唤醒链；--fix 一键把 crossSessionInbound 设为 accept（写前备份）
  ocs upgrade
      迁移到托管版 Agent Party（跨机器、跨组织频道）
  ocs version | help

数据目录: ~/.ocs（OCS_HOME 可覆盖）。语言: OCS_LANG=en|zh。`,
  sent: (channel, seq) => `已发送 #${channel} seq ${seq}`,
  wakeNoMatch: (names) => `wake: 没有匹配 @${names} 的活 Claude 会话`,
  wakeSelfSkipped: "（@ 到了自己，已跳过）",
  wakeDelivered: (target) => `wake: 已投递收件箱 → ${target}`,
  wakeFailed: (target, reason) => `wake: 失败 → ${target}: ${reason}`,
  codexAccepted: (thread, turnId) => `wake(codex): turn 已接受 → task ${thread}（turnId ${turnId}）`,
  codexUnknownOutcome: (detail) => `wake(codex): 结果未知（帧已写出，勿重发）: ${detail}`,
  codexFailed: (reason, detail) => `wake(codex): 失败（${reason}）${detail ? `: ${detail}` : ""}`,
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
  doctorCodex: "Codex / ChatGPT Desktop 侧",
  doctorIpcOk: (path) => `Desktop IPC 可用（${path}）`,
  doctorIpcMissing: (path) => `Desktop IPC 不可用（${path} 缺失或权限不对）——ChatGPT Desktop 开着吗？`,
  doctorRollouts: (n) => `${n}+ 个 Codex rollout（IPC 唤醒需要成对任务，满足）`,
  doctorOneRollout: "只有 1 个 Codex rollout——原生 IPC 唤醒需要同 renderer 下的第二个任务作 source",
  doctorNoRollouts: "没有 Codex rollout（跑过 codex 吗？）",
  doctorAccel: "可选加速器",
  doctorCmuxOk: "cmux 在运行——终端里的 codex/claude TUI 也能被唤醒（按 surface 寻址）",
  doctorCmuxMissing: "cmux 未检测到（可选，不影响核心功能；终端 TUI 需自己先进频道）",
  doctorData: "数据目录",
  doctorDataExists: (path) => `${path} 存在`,
  doctorDataAuto: (path) => `${path} 首次 send 时自动创建`,
  upgrade: `单机版到托管版 Agent Party（跨机器、跨组织频道，同一套使用习惯）：

  1. 安装:  curl -fsSL https://agentparty.leeguoo.com/install.sh | sh
  2. 建频道: 打开 https://agentparty.leeguoo.com 创建频道，拿到 party join 片段
  3. 迁历史: ocs read <channel> --as migrator --peek --json 导出后用 party send 回放（可选）

本地 ocs 与托管 party 可以并存：本机小事走 ocs，跨机协作走 party。`,
  failSendUsage: "用法: ocs send <channel> <body> --as <name>",
  failReadUsage: "用法: ocs read <channel> --as <name>",
  failWatchUsage: "用法: ocs watch <channel>",
  failReplyTo: "--reply-to 必须是正整数 seq",
  failSince: "--since 必须是非负整数",
  failInterval: "--interval-ms 必须 >= 50",
  failLimit: "--limit 必须是正整数",
  failName: (name) => `名字不合法: ${name}`,
  failFlagRequired: (flag) => `--${flag} <value> 是必填项`,
  failMissingValue: (flag) => `--${flag} 后面必须带值`,
  failUnknownFlag: (flag) => `未知参数: --${flag}`,
  failExtraArgs: (args) => `多余的参数: ${args}`,
  unknownCommand: (command) => `未知命令: ${command}`,
};

const catalogs: Record<Lang, Catalog> = { en, zh };

export function messages(lang: Lang = detectLang()): Catalog {
  return catalogs[lang];
}
