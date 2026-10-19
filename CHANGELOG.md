# Changelog

## Unreleased

- Discover long-running Codex threads even when more than ten newer rollouts exist; inspect live processes before limiting historical candidates
- Label Codex PIDs as transport processes and always show the project path; shared daemon PIDs do not identify which thread owns a child build process

## 0.9.2

- Show a known update on every user-facing invocation, including help, version and upgrade checks; keep JSON stdout clean and background release checks limited to once a day

## 0.9.1

- Automatically publish patch releases after main passes macOS and Windows CI; synchronize version metadata and publish all four platform assets together after validation

- A Claude desktop title that is not a valid address no longer becomes the message sender: it falls back to the session's `claude-<8hex>` id, so messages are stored and generated replies route back. Adds eight regression tests

## 0.9.0

- Discover and message existing Grok Build shared-leader sessions with full UUID addresses, names, DM, mentions, inbox/replies, and paired LAN routing. Start Grok with `grok --leader` and submit its first prompt; standalone and web/mobile clients are not connected
- Preserve busy turns and existing permissions via native queued prompts. Confirm exact prompt admission before reporting acceptance; missing acknowledgement after a write is unknown and never replayed. Quiet and self messages do not wake Grok
- Verify owned rendezvous files and live Grok leader processes; Windows verifies the pipe owner, server user/PID and executable on the same handle before sending any bytes. Reject dormant, remote-origin and ambiguous local sessions
- Install the OCS skill for Grok alongside Claude, Codex and Pi; add Grok diagnostics and setup documentation
- Verified on macOS with Grok Build 1.0.50: discovery, native queue admission and a reply using Grok's automatic sender identity. Linux/Windows coverage uses protocol/CI fixtures; no real-account acceptance is claimed there

## 0.8.4

- Accept `--as <name>` before or after identity-aware subcommands, including `dm`; sender-identity errors now state that nothing was sent and explain how to add a sender name from a plain shell
- Explain the correct two-hyphen `--as` spelling for `-as` and typographic dashes; keep malformed commands from storing or sending a message
- Correct misleading cmux discovery hints in `who` and `doctor`, and document that Grok has no direct-wake adapter
- Add private, best-effort traffic observations via `ocs stats [channel] --json`: distinguish message and target delivery outcomes, explicit batches and busy Codex coalescing; counts do not imply model turns, reads, tokens or cost
- Add explicit `send/dm --batch <tasks.json>`: retain all related tasks in one message and deliver once per recipient; agy returns one combined result
- Support LAN DM JSON with confirmed remote channel/seq and unknown remote commits (`stored:null`, exit 3), plus authenticated quiet DM using an operation older receivers safely reject without storing
- Add versioned per-entry capabilities to local and remote JSON discovery, and JSON LAN roster support
- Replace obsolete AgentParty hosted/sync architecture plans with the current OCS and Session Flow boundary

## 0.8.3

- Add an opt-in Antigravity CLI receiver on macOS, Linux, and Windows: authenticate in `agy`, then run `ocs agy start --cwd <workspace>`. Delegate with `ocs dm agy` or `@agy`; the final response returns to the original conversation. Paired LAN computers can delegate too
- Tasks enter a durable SQLite queue, run serially, and keep a separate agy conversation per OCS channel. Duplicate wakes reuse the same task; interrupted tasks and replies with unknown delivery outcomes are never replayed automatically
- Windows receivers verify the local named-pipe owner, server user, and registered PID on the connection carrying the task. Authenticated `ocs agy stop` shuts down the receiver; stopping an active task terminates its child process tree. Long Windows replies include a preview and a file containing the full result
- Automatic channel replies normalize the parent author address, so replies to Claude short IDs wake the intended session. Fix the English and Chinese help ordering for `whoami` and `agy`

## 0.8.2

- Local `ocs dm --no-wake` stores a message with its route/inbox history without starting a peer turn (`wake: skipped`, exit 0). It is for records a recipient actively reads, not a requested answer or urgent blocker. LAN DM and idle subscriptions cannot be combined with it
- Agent guidance and wake notes stop unsolicited acknowledgement/thanks loops. Requested answers, decisions, blockers and final results still use normal delivery; complete findings are batched into one message

## 0.8.1

- `ocs send --json` / `ocs dm --json`: stdout is exactly one JSON line `{v:1, command, stored, channel, seq, wake, exit, lines}`; human lines move into `lines`. Exit codes are unchanged (1 not stored, 2 stored + wake failed, 3 stored + wake unknown). `wake` is `accepted | deferred | parked | none | skipped | failed | unknown`; `accepted` is not a read receipt. Argument errors are JSON too. LAN `dm x@peer --json` is refused (exit 1, nothing sent) until remote-store semantics are designed
- `ocs whoami --json` in Codex adds `threadId` (full thread UUID). Codex thread ids are UUIDv7, so the short `codex-<8hex>` id is shared by tasks started within about a minute; tools that need an exact identity should use `threadId`. Other hosts' output is unchanged

## 0.8.0

**Pairing two people is copy, paste, compare six digits — and trust now runs out.**

- `ocs lan pair` prints a ready-to-send block (install lines, `ocs lan up`, `ocs lan join <key> --addr …`). The other person pastes it; both screens show the same 6-digit check code; you answer `y`. Without a terminal (e.g. an agent ran it), approve with `ocs lan approve <code>` or refuse with `ocs lan reject`
- The copied text pins 100 bits of the inviter's key fingerprint, so `join` cannot be steered to an impostor; the check code (derived from that connection's keys) stops someone else slipping in a request. Requests are only accepted while `ocs lan pair` is waiting, one at a time
- Trust periods: pairing grants **8 hours by default**; `--for 30m|2h|7d`, `--once` (a single message, combinable with `--for`), `--forever` (meant for your own devices). Both sides record the same period; expired or used-up peers are refused at the handshake and pruned. A `--once` use is only taken by a DM that is actually stored, so a typo does not burn it
- `ocs lan trust <peer> --once | --for <d> | --forever` changes this machine's period later; `ocs lan peers` shows each peer's remaining time / messages
- Compatibility: peers paired before 0.8 stay permanent. The one-time code flow still works (`ocs lan pair --code` / `ocs lan pair <code>`) and is what 0.6/0.7 machines understand; a 0.8 `join` against a 0.7 daemon reports `old-peer`
- Verified: unit + end-to-end tests (two daemons over real TCP, non-TTY approve), and the interactive `[y/N]` path under a real pty in English and Chinese. Not yet verified across two physical machines

## 0.7.6

- `ocs upgrade --party`（旧入口）补上 Agent Party 的关停日期（2026-10-31）和卸载本机 Agent Party 的指南链接；仍然只指向 `ocs lan`，不引导迁回 Agent Party

## 0.7.5

**Agent Party is no longer maintained; ocs stops pointing to it.** Machines on different networks use the same `ocs lan`: put both on one virtual LAN (Tailscale, WireGuard, ZeroTier or a company VPN) and pair with `ocs lan pair <code> --addr <peer-vpn-ip>:47890`.

- `ocs upgrade` 之后的提示改为指向 `ocs lan`（同一局域网，或经 VPN 跨网络），不再提 `ocs upgrade --party`
- `ocs upgrade --party` 从帮助里去掉；旧脚本仍可调用，只打印上面的跨机器用法，不再给 Agent Party 的安装和建频道步骤
- README 去掉 Agent Party 对比列、「本地版与托管版」一节和跨网络引流，新增「不同网络：虚拟局域网」一节；docs/lan.md 同步
- 已验证：跨网段（`192.168.0.x` ↔ `192.168.1.x`）只按地址、不靠组播的配对与互发（macOS ↔ Windows）。Tailscale / WireGuard 本身尚未真机验证

## 0.7.4

**A busy Codex session no longer gets one extra turn per message after it finishes (#41).** When a Codex task was mid-turn, every wake went into the host's pending queue, and after the turn ended Codex started a separate turn for each one, replaying old messages the agent had already read (12 → 129 in the report). ocs now checks whether the target is mid-turn before sending anything.

- 终端里的 Codex（TUI，托管在 Codex app-server 守护进程里）：消息直接**插进正在跑的这一轮**（守护进程 `turn/steer`，和你在 TUI 里边跑边打字是同一个入口），agent 当场就看得到，结束后不会再补一轮。输出 `wake(codex): inserted into the running turn …`
- 插不进时（ChatGPT Desktop 托管的 task、没有守护进程、宿主拒绝）：消息照常落盘，唤醒先攒着，这一轮结束后只发**一条**，正文是最新那条，首行写明前面还有几条未读、从哪个 seq 起，以及消息是多久之前发的；对方在这一轮里已经 `ocs read` 读过的不再提醒。输出 `wake(codex): task … is mid-turn — message stored, wake deferred …`
- 目标空闲时行为不变。帧发出后没应答仍然是「结果未知」，不重发
- 真机验证（macOS，codex-cli 0.160 守护进程 + TUI）：连发 3 条 DM，第 1 条开了一轮，第 2、3 条插进同一轮，agent 一次引用了三条，之后没有多余回合；同样时机用 0.7.3 的 `codex queue`，消息排在 `thread/queue/list` 里、回合结束后另起一轮
- 未真机验证：Desktop 托管 task 的积压合并路径（只有单元测试）

## 0.7.3

**Hermes Desktop sessions can be messaged, locally and from paired machines (#40).** `ocs who` lists the sessions open in Hermes Desktop (or `hermes serve`) as `hermes-<id>`, `ocs dm hermes-<id>` / `@hermes-<id>` puts the message into that same conversation, and inside Hermes `ocs whoami` knows which session it is, so the agent replies with the `Reply:` line as-is.

- 走 Hermes 宿主自己的本地 WebSocket（Desktop 窗口用的同一条），不装插件、不改 Hermes 配置。认证材料是 Hermes 发布给同一用户的 0600 token 文件；每次连接重读，核对指纹，只连 loopback
- 投递一律带排队标记：空闲会话开始新一轮（`wake(hermes): started a turn`），忙的会话排在当前这一轮之后（`queued behind the running turn`），不打断正在跑的工具。宿主没开、会话没打开 → 仅落盘（退出码 2）；帧发出后没应答 → 结果未知（退出码 3），不重发
- Hermes 里消息显示为用户气泡（宿主不允许外部客户端改作者），靠唤醒包装文字标明来源，正文照旧当数据处理
- 地址：Hermes 会话 id 里的 `_` 写成 `.`（`hermes-20261006.124023.6626fe`），因为 ocs 名字和 @ 提及不含 `_`
- 局域网：`ocs who --lan` 列出对端打开的 Hermes 会话（对端和本机都要 0.7.3，旧版本会跳过这类条目）；远端 DM 只投此刻打开的会话，否则 `not-found` 不落盘
- `ocs doctor` 新增 Hermes 一节：宿主连不连得上、几个打开的会话、当前进程是不是在某个 Hermes 会话里、那个会话能不能收消息
- 真机验证（macOS，Hermes Agent 0.21.5 + Hermes Desktop）：另一台 Mac 上的 Claude Code 经局域网发 DM → 同一个 Hermes 对话收到并开始新一轮 → Hermes 用 `ocs` 回复送回发送方 → 第二轮仍进同一个对话；对方忙时第三条报 `queued`
- 只覆盖 Hermes Desktop / `hermes serve` 托管的会话；终端里单独跑的 `hermes` / `--tui` 不在宿主里，暂不支持

## 0.7.2

**Windows: native Pi TUI sessions can receive messages (#39).** The Pi extension listened on a `.sock` file under `~/.ocs/pi-inbox`, which native Windows Node refuses with `EACCES`, so Windows Pi sessions never showed up in `ocs who` and could not be messaged locally or from a paired machine.

- Windows 上 Pi 扩展改为监听命名管道 `\\.\pipe\ocs-pi-<会话 hash>-<pid>-<128 位随机>`；读注册时只认这个形状、会话 hash 和 pid 都要对上，`\\主机\pipe\…` 一律拒绝。每帧仍校验运行期 token。macOS / Linux 不变
- Windows 上不再按 mode 位拒收 Pi 注册文件（NTFS 没有这些位，权限靠用户目录 ACL，同 Claude 那边的规则）
- 升级后跑一次 `ocs skill install`（或 `ocs doctor --fix`）更新 Pi 扩展，再重开 Pi 会话

**Windows: background processes no longer hold the files you redirected `ocs` output to (#38).** libuv creates child processes with handle inheritance on, so `ocs lan up *> out.txt` left the LAN daemon holding `out.txt` until it restarted. ocs now clears the inherit flag on its own stdin/stdout/stderr before starting the LAN daemon, idle watchers, wake helpers and the update check.

## 0.7.1

**Windows: ocs now checks who is serving ChatGPT Desktop's Codex pipe before sending anything (#37).** 0.6.2–0.7.0 trusted `\\.\pipe\codex-ipc` because a pipe with that name existed. Any local process that created the name first received the wake prompts and thread ids and could answer as the task owner. macOS and Linux were not affected (the socket's owner and mode were already checked).

- 在即将发帧的那条连接上核对管道服务端：管道属主 SID 是当前用户；服务端进程以当前用户运行；该进程带 ChatGPT Desktop 的包身份（`OpenAI.Codex_2p2nqsd0c76g0`）且映像在包安装目录内。不满足 → 不发任何字节，按 Desktop IPC 不可用处理（消息留在收件箱，退出码 2），原因写进 `wake(codex): stored-only (unavailable): …`
- `ocs doctor` 在 Windows 上报告管道是否通过身份校验，通过时列出服务端 pid 和映像路径，不通过时写明原因
- `OCS_CODEX_IPC_PIPE` 指向的管道走同一套校验；只接受 `\\.\pipe\…` 形式的本机管道名
- 会被拒的正常情形：不是 Store 包安装的 ChatGPT Desktop、以管理员身份运行的 ChatGPT Desktop
- start-turn 帧写到一半失败按结果未知处理（退出码 3，不重发）
- 真机验证（Windows 11，OpenAI.Codex 26.924）：真 Desktop 通过；同一用户、另一用户各起一个抢注管道，均被拒且抢注方收到 0 字节（0.6.5 对同一个抢注管道发出了 194 字节的握手帧）

## 0.7.0

**Claude wakes now say whether the message was held.** `ocs dm` / `ocs send` to a Claude Code session used to print `delivered to inbox` even when the receiver's `crossSessionInbound` gate (default `hold`) parked the message and dropped it 5 minutes later. ocs now subscribes to Claude Code's native delivery receipts and reports what happened. macOS and Linux; Windows behaves as before.

- 发给 Claude 会话的唤醒带上回执地址，接收端把归宿写回来（docs/wake-protocol.md §6）：没有扣留/拒绝回执 → `wake: accepted by inbox`（退出码 0，不是已读回执）；被闸门扣下 → `wake: HELD, not delivered yet`（退出码 2）；`refused` / `dropped` / `denied` / `expired` → `wake: NOT delivered`（退出码 2）。消息都已落盘，别重发
- 被扣下的消息最终没送达（过期、被拒、到点没有终态）时，发送方会话收到一条 `[ocs delivery notice]`，写明 seq、对象、原因和接收端该怎么改（`ocs doctor --fix`；仓库级设置仍可强制 hold）。只发一次；后来被批准了就不打扰
- 回执写进频道日志（`type:"receipt"` 旁车帧，旧版本跳过这一行照常读消息）；`ocs read` 在自己发的消息下显示 `[wake → <目标>: <状态>]`，`--json` 多一个 `delivery` 数组
- 局域网：接收端守护进程走同一条唤醒，`ocs dm x@peer` 也会报 accepted / HELD / NOT delivered（线上格式不变）；被扣消息的终态只记在接收端，不跨机通知
- 每次 Claude 唤醒由一个脱离终端的 helper 完成（内部命令 `_claude-wake`）：接收端只把回执发给写帧的那个进程。它在 Claude 的 socket 目录里建一个 0600 的临时 socket，退出前删除；被扣的消息最多等 6 分钟
- `OCS_NO_RECEIPTS=1` 关掉回执，回到 0.6 的行为和措辞；回执建不起来时自动回落
- 唤醒 note 的正文伪造不了 `[ocs delivery notice]` / `[ocs 投递通知]` 行（同 0.6.0 的中和规则）

## 0.6.6

- `ocs inbox` 新增 `--session <claude-session-id>`：与 `ocs whoami --json --session` 同一语义，不靠进程祖先链推断，直接按指定 Claude 会话解析身份（会话身份、稳定工作区身份、ocs 名字），`--json` 仍输出原来的数组。给状态栏这类不在 Claude 进程树里的调用方显示本会话未读数用；会话不存在或与 `--as` 同用时报错退出 1
- README 新增常见问题（中英），按大家实际搜索的问法回答：Claude Code 与 Codex 互通、两个 Claude 会话对话、跨电脑、Windows、与 subagent/MCP 的区别

## 0.6.5

- 让局域网能力看得见：README（中英）开头改成「同一台机器上 + 局域网里的几台电脑之间」，新增「0.6 新增」一节和两台机器上手示例；`ocs help`、`ocs upgrade` 的提示、skill 标题不再只说「本机」，跨网络/跨组织才指向托管版
- `ocs doctor` 新增「局域网（其他电脑）」一节：没开时给入口，开着时报已配对电脑数和登录自启
- GitHub Release 说明取自 CHANGELOG 对应一节并附安装命令（此前所有 release 页面都是空的）；CHANGELOG 缺这一节时发版直接失败

## 0.6.4

- 局域网：远端 `who --lan` 和远端 DM 判断 Codex 任务可达时，也认「被 ChatGPT Desktop 认领」（和本机 `ocs who` 同一判据）。此前只认 lsof 找到的活进程，Windows 上开着的 Desktop 任务对远端整个隐身、DM 被拒 not-found

## 0.6.3

- Windows：`ocs doctor` 把 `codex queue` 标成「Windows 上不走」而不是警告（没有 lsof 证明任务活着，Desktop 任务走 IPC）；`ocs upgrade` 打印实际运行的 `install.ps1` 命令
- 真机确认：Windows 上 `ocs who` 能列出 ChatGPT Desktop 认领的 Codex 任务（`\\.\pipe\codex-ipc`）

## 0.6.2

- 加入 use-family 家族（leeguooooo/plugins）：`ocs upgrade --check` 输出统一成 `ocs <当前> -> <最新>` / `ocs <当前> is up to date`，新增 `--json`，查不到最新版退出码 2；升级后刷新 Claude 插件 / git 检出里的 skill；每天最多一次在 stderr 提示新版本（缓存过期时后台查，不拖慢 send/dm；`CI`、`OCS_NO_UPDATE_CHECK`、`USE_NO_UPDATE_CHECK` 关闭）
- skill 按家族约定补上 Upgrade 一节，描述里加上局域网配对的机器
- macOS 发行版改用 Developer ID 签名 + Apple 公证（hardened runtime，`scripts/entitlements.plist` 给 bun 的 JIT 放行）：Gatekeeper 显示 `Notarized Developer ID`，防火墙「自动允许已签名软件」开着时不再每个版本重新放行；没有签名 secrets 的 fork 构建退回 ad-hoc
- Windows：ChatGPT Desktop 的 IPC 是命名管道 `\\.\pipe\codex-ipc`（此前找的是 `~/.codex/ipc/ipc.sock`，Windows 上的 Codex 任务一律报不可达）；`ocs doctor` 不再在 Windows 上误报数据目录权限 666

## 0.6.1

- macOS 防火墙开着时 `ocs lan up` 自动放行 ocs 自己：此前换到正式安装路径或升级后，局域网连接被静默拦截，对端只看到「连不上」、本机日志一行都没有（Mac ↔ Windows 真机发现）

## 0.6.0

**Agents across your LAN.** Pair two computers once (`ocs lan up`, `ocs lan pair`), then `ocs dm <address>@<peer>` wakes a Claude Code, Codex or Pi session on the other machine; `ocs who --lan` lists them. Mutually authenticated and encrypted, off by default. Windows supported. See docs/lan.md.


- 局域网模式（默认关闭）：`ocs lan up` 启动守护进程，`ocs lan pair` 出一次性配对码、另一台 `ocs lan pair <码>` 兑现；之后 `ocs dm <地址>@<对端>` 跨机发消息并唤醒、`ocs who --lan` 看远端 agent。Ed25519 身份 + 签名 X25519 握手 + AES-256-GCM，未配对机器只能兑现有效配对码；协议与威胁模型见 docs/lan.md
- 唤醒 note 里的正文不再能冒充包装和骨架：`<cross-session-message` 被中和，行首形似 `Reply:` / `Thread:` / 唤醒首行的加 `> `（本地 DM 同样受益；wake-protocol §1 已更新，AgentParty 侧需同步）
- 修复：0.5.1 起会话级 DM 写 `claude:<sessionId>` 身份，但身份校验没收这个命名空间，没有稳定工作区身份的 Claude 会话 `ocs dm` 直接报 `invalid sender identity`
- Windows 可用（Win11 + Claude 2.1.284 真机验证）：命名管道收件箱、peer token 按小写管道路径取、管道名里没有 pid 时的自身识别、编译后的 exe 自启动子进程（`notify-when-idle` 的 watcher 和 lan 守护进程此前都起不来）、NTFS 下不查 mode 位
- `ocs lan autostart on|off`：登录后自动起守护进程（macOS LaunchAgent、Windows HKCU Run、Linux systemd user unit）
- Windows 发行：Release 附 `ocs-windows-x64.zip`，`irm …/install.ps1 | iex` 安装，`ocs upgrade` 在 Windows 上走 install.ps1；两个安装器都会用新版重启正在跑的 lan 守护进程
- 局域网发现同时发子网定向广播：家用路由器 / VPN tun 吞掉组播时照样能找到
- 唤醒失败时带上具体原因（此前只有 `write-failed`）
- 投递阶梯从 cli.ts 抽到 `src/deliver.ts`，本地 dm 与远端 dm 共用

## 0.5.1

- 会话级 DM（同一工作目录多会话、workspace continuity 退回时）改按 Claude sessionId 派生频道和 route 身份（`claude:<uuid>`），重启/自动改名后同一对会话仍在同一频道；此前按会话名，改名后老频道静默失联（#36）
- `ocs send` 一个人都没唤醒时明说 stored-only；在 `dm-*` 频道里退出码 2（#36）
- `@` 点名的边界放宽：前一个字符不是地址/邮箱字符就算，`。@x`、`，@x` 等中文写法不再被吞（#36）

## 0.4.3

- `ocs upgrade` 真的升级二进制：查 GitHub 最新 Release，落后时复用 install.sh（sha256 校验 + 冒烟 + 原子替换）；`--check` 只报告；原来的托管版迁移指南移到 `--party`。此前该命令只打印迁移文案，装了旧版的用户无从得知有新版
- `ocs doctor` 新增版本检查：二进制落后于最新 Release 时给出警告并指向 `ocs upgrade`；离线/CI 可用 `OCS_UPGRADE_CHECK=0` 跳过
- Codex IPC 建连预算独立于 owner 探测 deadline：此前 500ms 的探测 deadline 也套在 socket 建连上，机器繁忙时「未认领」会被误报成可重试的传输故障 `failed`，而非应停靠 inbox 的 `not-open`（#28）
- skill 文档补上安装/升级入口，agent 缺二进制时能自愈
- Codex Desktop 明确不可投递时，自动降级唤醒唯一匹配的空闲 cmux Codex surface；匹配会验证标题 task 短 ID 与活 Codex 进程，陈旧 shell、多匹配和 IPC `unknown-outcome` 均 fail closed（#30）

## v0.4.2

- 发送输出明确区分 `stored` 与 wake 结果；唤醒失败返回退出码 2、结果未知返回退出码 3，并提醒消息已落盘、不可重发
- `send --codex` 与 `--codex-source` 直接接受 `ocs who` 展示的 `codex-<8hex>` 短地址；无效或歧义地址在消息落盘前失败
- CLI help、README 与安装 skill 补齐 ChatGPT Desktop 的第二个同 renderer source task 前置条件
- 明确跨机器边界：托管协作用 Agent Party；已有免密 SSH 时由控制端直接调用 workbox 上的本地 OCS/Herdr，不在 OCS 增加远程 runtime
- 测试临时目录统一按用例清理，删除失败会保留路径重试并使测试可见地失败；全量测试不再净增 `ocs-*` 残留

## v0.4.1

- Codex roster 只展示被 ChatGPT Desktop renderer 实际认领的 open task，不再把本地 rollout 历史误报成可达
- Codex target/source owner 改为并发短探测；未打开任务约 1 秒内明确报告消息已存储、可用 `ocs inbox`，不再串行等待 10 秒超时
- `ocs doctor` 分开报告 IPC router socket、当前 task renderer ownership 与 rollout 历史，避免 socket 存在被误解为端到端可唤醒

## v0.4.0

- `ocs who` 默认把当前项目放前面，用 `codex-<8hex>` / `pi-<8hex>` 短地址隐藏完整 UUID；`--verbose` 和 `--json` 按需展开
- Codex 通过宿主 thread id 自动识别发送者，Claude/Codex/Pi 日常发送都不再要求 `--as`
- 新增 `ocs inbox`：只列能由 route sidecar 或既有 cursor 证明归属的未读线程；稳定身份 cursor 支持 Claude 重启改名后续读，不猜测、不枚举其他私信
- 活 Claude/Codex/Pi 的 `Reply:` / `Thread:` 命令不再携带多余 `--as`；`send --reply-to` 会在回复者身份匹配时安全反转父消息 route，让回复进入原发送者 inbox
- `ocs doctor --fix` 同步修复三端 skill、Pi 扩展和数据目录权限；原子替换旧 skill，不沿符号链接改写共享缓存
- 支持常见的 `ocs --help`；修复 macOS 测试临时路径过长导致 Pi UDS 用例失败
- Release workflow 对 macOS 二进制重新做 ad-hoc codesign，并在打包前运行真实二进制 smoke test，避免无效签名被系统以 SIGKILL 拒绝执行

## v0.3.6

- 支持 Pi TUI：`ocs skill install` 同时安装 Pi skill 与直投扩展；`ocs who` 列出活会话，`ocs dm pi-<session-id>`、`@pi-<session-id>` 和 `--reply-to` 可直接唤醒
- Pi 忙碌时把跨会话消息排成 `followUp`，不打断当前工具调用；每个会话使用 0600 UDS、随机令牌和独立 `pi:` 身份命名空间
- `ocs doctor` 增加 Pi 扩展版本与活会话检查
- curl 安装完成后自动用 `skills` CLI 给 Claude Code、Codex、Pi 注册同版本 skill；关闭 telemetry，失败时改用二进制内置安装

## v0.2.0

- **`ocs who`**：全机 agent 花名册——Claude 会话、Codex 任务、cmux 终端一张表，自动标出你自己
- **`ocs dm <目标> <内容>`**：直发一个 agent，频道自动派生、载体自动选（UDS / Desktop IPC / cmux）
- **身份自动识别**：在 Claude 会话里 `--as` 可省略（进程祖先链推断；`OCS_NAME` 可覆盖）；`ocs whoami` 查看
- **cmux 第三载体**：探测到 cmux 时可唤醒终端里的 codex/claude TUI（按 surface 寻址；忙碌不打扰）；仍是可选加速器，绝不必装
- **`ocs skill install`**：给 Claude Code 装 ocs 技能，对任何会话说「找个 agent 商量」即可触发

## v0.1.2

- `@<codex-thread-id>` 自动路由到 ChatGPT Desktop IPC，不再要求记 `--codex` 语法
- codex 唤醒归因修复：target/source 分开探测、报错各自点名；自动选 source 逐候选跳过未打开的 rollout
- 自我唤醒防回环改为沿进程祖先链定位本会话（`process.ppid` 在 Bash 工具链路下失效）
- CLI 输出国际化：英文 canonical，`OCS_LANG`/locale 选中文；唤醒指针双语
- `ocs doctor --fix` 一键设 `crossSessionInbound=accept`（写前备份）；doctor 增加 cmux 可选加速器探测
- 对抗式审查修复 12 条（codex-ping 全仓审查，均有回归测试）：
  - 非法 `--reply-to` 写出永久不可读行；崩溃半行吞掉下一条消息
  - 空内容陈锁永久死锁；stale-break inode 校验 + 写后自校验堵双持锁竞态
  - 日志 EACCES 被伪装成空频道；游标并发回退（锁内比较 + 原子写）
  - owner 探测把传输故障误报成「任务未打开」；source 候选上限 10→50
  - 命令级参数 schema：缺值/未知 flag/多余参数必须报错（`--codex` 缺值曾静默吞掉）
  - install.sh 校验 fail-closed + sha256sum 兼容；冒烟通过前不覆盖旧二进制
- `ocs version`；双语 README（[English](./README.md) / [中文](./README.zh-CN.md)）

## v0.1.1

- `@<codex-thread-id>` 分流与祖先链防回环首版（详见 v0.1.2 收尾）

## v0.1.0

- 首个公开版本：本地频道日志（多进程安全单调 seq）、Claude 收件箱 socket 注入、
  ChatGPT Desktop 原生跨任务 IPC、`doctor` 体检、`upgrade` 迁移指引
- 三平台二进制（macOS arm64/x64、Linux x64）+ `install.sh`
