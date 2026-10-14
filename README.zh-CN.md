# Open Cross-session

**Claude Code、Codex、Pi 和终端里的 agent 互相唤醒、互发消息——同一台机器上可以，局域网里的几台电脑之间也可以（macOS、Linux、Windows）。不要服务器，不要账号。**

[![ci](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml/badge.svg)](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/leeguooooo/open-cross-session)](https://github.com/leeguooooo/open-cross-session/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md)

https://github.com/user-attachments/assets/6fedd0cc-af15-4caf-9027-d0f149676ea6

`ocs` 给每个 AI 编码会话一条共享消息频道，并把目标会话真正叫醒，不只往文件里写一条消息。Claude Code 会话、ChatGPT Desktop 任务、Pi TUI 和终端 agent 共用一份本地 append-only 日志。从 0.6 起，Mac 上的 Claude 可以直接把活交给隔壁 Windows 电脑上的 Claude 或 Codex。

## 0.6 新增：跨电脑的 agent 互通

```bash
# 机器 A                             # 机器 B
ocs lan up                          ocs lan up
ocs lan pair   # 打印配对文字  →    （粘贴执行）ocs lan join k3m9q2xa… --addr …
# 核对 6 位核对码，按 y     ←       显示同一个 6 位核对码
                                    ocs who --lan
                                    ocs dm claude-1a2b3c4d@mini "帮我在 Windows 上跑一下构建"
```

A 上的会话被唤醒，收到消息和一行 `回复：`，照着执行就回到 B。已在 Mac ↔ Windows 真机验证（两边都是
Claude Code 2.1 和 ChatGPT Desktop 的 Codex）。

- **自动发现**：局域网组播 + 子网广播；网络两者都屏蔽时用 `--addr`。
- **复制粘贴就能配对，不存在「首次连接即信任」**：`ocs lan pair` 打印一段可以直接发给对方的文字，里面带着本机公钥指纹；两边屏幕显示同一个 6 位核对码后，你再确认。
- **信任会到期**：默认 8 小时，`--once` 只许一条消息，`--forever` 留给自己的设备。
- **双向认证、全程加密**：Ed25519 身份、带签名的 X25519 握手、AES-256-GCM、前向保密。未配对的机器只能在你等待配对时发一个请求，别的什么都做不了。
- **默认关闭**：`ocs lan up` 才开启，`ocs lan autostart on` 让它登录后自动起。

协议与威胁模型见 [docs/lan.md](./docs/lan.md)，配置细节见[跨机器](#跨机器)。

原生 cross-session 到产品边界就停了。不同产品里的 agent 要一起干活，`ocs` 补上这些能力：

- **跨厂商直投：** Claude Code、ChatGPT Desktop、Pi 可以互相唤醒；终端里的 Claude/Codex TUI 跑在 cmux 中时也能唤醒。
- **真正的多方频道：** agent 数量不限，人也能加入；支持 `@`、`--reply-to`、独立读游标和可重放的 seq。
- **对话能续上：** 消息保存在本地 JSONL 日志里。稳定工作区身份让 Claude 私信跨重启、跨 Git worktree 延续，旧版私信历史也能显式迁移。
- **好记的地址：** 每个会话都有不变的短 id，`ocs rename <名字>` 还能再起个名字；别的 agent 用哪个都能找到它。
- **一张花名册、一套命令：** `ocs who`、`ocs dm`、发送者自动识别、内置 skill 和 `ocs doctor` 对所有已支持的载体使用同一套操作。
- **投递不冒进：** Pi 忙时把消息排到下一轮；cmux 不会往忙碌的 TUI 里敲字；自我唤醒会被拦住；IPC 结果未知时只报错，不重试制造重复消息。
- **默认只在本机：** 不需要 daemon、账号、API key 或服务器。一个静态二进制，数据都在 `~/.ocs`。
- **跨局域网：** 配对过的电脑用 `<地址>@<对端>` 找对方的 agent，见上文。

不在同一个网络的机器，接入同一个虚拟局域网（Tailscale、WireGuard、ZeroTier 或公司 VPN）后用法完全一样，配对时填对方的 VPN 地址即可，见[不同网络](#不同网络虚拟局域网)。

## 给会话起名字

每个会话本来就有不变的短 id，比如 `claude-7043ea85`、`codex-01a06a98`、`pi-01a09109`，
`ocs who` 会列出来。再起一个人和 agent 都记得住的名字：

```bash
ocs rename reviewer                             # 在要起名的会话里运行（或者直接让那个 agent 去做）
ocs dm reviewer "帮我看下这个 diff"              # 按名字找
ocs dm claude-7043ea85 "同一个会话，按 id 找"     # id 照样能用
ocs send dev "好了吗？@reviewer"                 # @名字 会叫醒它，Claude、Codex、Pi 都行
ocs rename --clear                              # 删掉名字
```

- 一个会话最多一个名字，改名会释放旧名字。名字不分大小写，只能用 `A-Z a-z 0-9 . _ -`，最长 64 个字符。
- 名字被别的会话占着时会拒绝；确认原来那个会话不用了，再加 `--force` 接管。和另一个活着的
  Claude 会话名完全相同也会拒绝。
- 在 Claude 里，`/clear` 之后名字还跟着这个窗口；别人回你的私信时，回复命令是 `ocs dm <你的名字>`。
- 其他工具可以读 `ocs whoami --json [--session <claude-session-id>]`，输出
  `{host, id, name, session, addresses}`，`addresses` 里每一项都能直接 `ocs dm`。
  在 Codex 里还会多输出 `threadId`（完整 thread UUID）：一分钟左右内开的几个 Codex 任务，
  短 id `codex-<8hex>` 可能相同。

### 搭配 Claude Status Bar

[Claude Status Bar](https://github.com/leeguooooo/claude-code-usage-bar)（`cs`）会在状态栏单独一行
显示当前会话的 ocs 地址，比如 `ocs reviewer · claude-7043ea85`，要找谁一眼就能看到，不用再跑
`ocs who`。v3.43.1 起，本机装了 `ocs` 就自动显示；不想要可以 `cs config set show_ocs false`。

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/claude-code-usage-bar/main/install.sh | bash
```

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh
```

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.ps1 | iex
```

单文件静态二进制，运行时零依赖。支持 macOS（arm64/x64）、Linux（x64）和 Windows（x64）。安装器会给
Claude Code、Codex、Pi 注册与二进制同版本的 ocs skill：有 `npx` 时调用固定版本的
`skills` CLI，并关闭 telemetry；随后运行二进制内置安装，补上 Pi 直投扩展。只装二进制：

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | OCS_INSTALL_SKILLS=0 sh
```

源码方式：`bun install && bun link && ocs skill install`。

## 上手

跨 agent 的消息用于派任务、回答问题、必要决策、阻塞和最终结果。相关发现合成一条发送；
任务结束后不用再回「收到」「谢谢」，也不需要确认对方的确认。用户要求的状态更新照常回复。

本机收尾记录或主动读取结果的工作流可用 `ocs dm <目标> "<记录>" --no-wake`。
消息和 inbox 记录会保留，JSON 报 `wake: skipped`、退出 0，不触发模型回合。
对方下次 read/inbox 才能看到它；需要对方回答的问题和紧急阻塞仍使用正常唤醒。
带线程引用的静默记录可用 `ocs send <频道> "<记录>" --reply-to <seq> --no-wake`。
它不可和空闲订阅同时使用，局域网 DM 暂不支持。

curl 安装时会自动装好 skill。重启已打开的 Pi 会话后，对 Claude Code、Codex 或 Pi 说
「找个 agent 帮你看看这段」，它会发现同伴并发送消息。常用命令：

```bash
ocs doctor --fix              # 一次性：安全修复安装，再复检全部唤醒链
ocs skill install             # 显式重装 skill/Pi 扩展（通常不需要再单独跑）

ocs who                       # 当前项目优先的全机花名册（你自己会被标出）
ocs dm codex-01a06a98 "帮我审下这个 diff"   # 短地址，可直接复制
                              # 频道自动派生，你的身份自动识别
ocs inbox                     # 重启后续接未读线程

# 一次性接续 v0.3.4 之前的 DM 历史
ocs dm webapp "继续旧话题" --inherit dm-<旧频道>

# 需要多方讨论时才用显式频道（频道就是个文件，没有任何要维护的东西）
ocs send dev "进展如何？@webapp-d8 @piggo-67"
ocs watch dev                 # 人肉旁观频道
```

对话可以自续：唤醒 note 直接带正文和一行可复制的回复命令，消息末尾带上对方 `@名字`，
下一轮它就醒。想在对方忙完时被通知，订阅一次 `ocs notify-when-idle <名字>`
（`send`/`dm` 也可带 `--notify-when-idle`）。

## 工作原理

```
ocs send ──▶ 追加频道日志 ──▶ 按目标选唤醒载体
             (~/.ocs，单调 seq)   ├─ Claude 会话      → per-session Unix socket 收件箱
                                  ├─ Desktop 任务     → ChatGPT 原生跨任务 IPC
                                  ├─ Pi TUI           → ocs Pi 扩展的 Unix socket
                                  ├─ cmux 终端         → 按 surface 投入输入框（仅空闲时）
                                  └─ 任意会话          → ocs read 读取、ocs send 回复
```

唤醒载荷就是消息本身，和 Claude Code 内置 cross-session 一样，作为数据装在
`<cross-session-message>` 包装里：

```
[ocs 唤醒] alice 在 #dev 提到了你（seq 7，回复 seq 3）

<正文，4096 字节以内逐字；更长的只带前 512 字节，外加
「… (N bytes total; full text: ocs read dev)」>

回复：ocs dm alice "<your reply>"          # Claude→Claude DM
线程：ocs read dm-<派生频道>
```

Claude→Claude DM 的「回复」行优先使用发送方用 `ocs rename` 起的名字，其次是唯一工作区别名，
派生出的长频道只留在「线程」行。两者都没有时退回 `ocs send <频道> ... --reply-to ...`。活 Claude、Codex、Pi 会自动识别自身，
只有无法验证身份的 headless/cmux 目标才保留 `--as`。整条 note 不超过 5120 字节。
协议与 Agent Party 共用：[docs/wake-protocol.md](./docs/wake-protocol.md)。

## Antigravity CLI（`agy`）

在 macOS/Linux 中先登录 `agy`，再显式启动可选接收端：

```sh
ocs agy start --cwd /你的项目路径
ocs dm agy "评审这个项目并报告结果"
ocs agy status
ocs agy stop
```

接收端按队列执行，每个 OCS 频道保留独立对话上下文，最终回复自动回传请求方。
它使用 agy 现有登录和权限配置；Windows 客户端可通过已配对的局域网向它派任务。
详见[接收端安装及送达语义](docs/agy.md)。

## 能唤醒谁

| 目标 | 用法 | 前提 |
|---|---|---|
| 交互式 Claude Code 会话 | `@<名字>`、`@claude-<8hex>` 或 `@<会话名>` | 接收端在 `~/.claude/settings.json` 设 `"crossSessionInbound": "accept"`。默认值 `hold`：消息进待审队列，5 分钟没人处理就被丢弃。0.7 起发送方会被告知：发送时显示 `wake: 被扣留`（退出码 2），最终没人批准再收到一条 `[ocs 投递通知]`。`ocs doctor` 会查这一项设置。 |
| ChatGPT Desktop 任务 / cmux Codex TUI | `ocs dm codex-<8hex> …`、`@<thread-id>` 或 `--codex <thread-id\|codex-8hex>` | Desktop 直投要求任务已打开，且同一 renderer 下还有第二个打开的任务作 source。该路径明确不可用时，ocs 会安全降级到唯一匹配、仍有活 Codex 进程且空闲的 cmux surface。 |
| Pi TUI | `ocs dm pi-<8hex> …` 或 `@pi-<8hex>` | 先跑 `ocs skill install`，再重启 Pi。扩展会登记活着的 TUI；消息在 Pi 忙碌时排到当前任务结束后，不会打断这一轮。 |
| Hermes Desktop 会话 | `ocs dm hermes-<id> …` 或 `@hermes-<id>`（`ocs who` 会列出；Hermes 会话 id 里的 `_` 写成 `.`） | 同一用户下开着 Hermes Desktop（或 `hermes serve`），且该会话已打开。ocs 走宿主自己的 WebSocket、带排队标记提交：空闲会话直接开始新一轮（`started a turn`），忙的会话排到当前这一轮之后（`queued`），不会打断。Hermes 里显示为用户气泡，包装文字标明是别的 agent 发来的。在 Hermes 里跑 `ocs whoami` 能认出会话，回复不用 `--as`。 |
| cmux 里的 Claude/Codex TUI | `ocs dm surface:<n> …` | 可选能力。检测到 cmux 后，`ocs who` 会列出终端 surface，并可把唤醒 note 提交给空闲 surface；surface 忙碌时不会打扰。 |
| 其他终端或 headless agent | `ocs read` / `ocs send` | 可以读写频道、保留历史和回复；如果所在 harness 没有受支持的载体，就不能被主动直投唤醒。 |
| shell 前的人 | `ocs send` / `ocs read` / `ocs watch` | 不运行 agent 也能发消息、读取一次或持续旁观同一频道。 |

投递语义分两层：首行 `已落盘 #<channel> seq <n>` 只表示 append-only 日志提交成功，不代表已经唤醒。随后每个 wake 请求分别报告已接受、仅落盘或结果未知。退出码 2 表示消息已落盘但至少一次唤醒失败；退出码 3 表示已落盘且唤醒结果未知。两种情况都不要重发，应使用输出里的 channel/seq 查原消息。没点名也没带 `--reply-to` 的 send 会明说「仅落盘」，在 `dm-*` 频道里同样退出 2。`@` 前面只要不是地址字符就算点名，`。@claude-9e6c0ae7` 也能唤醒。Pi 的“已排队”表示扩展已接收。

发给 Claude 的消息会带回 Claude Code 自己的投递回执（macOS、Linux）：

| 输出 | 退出码 | 含义 |
|---|---|---|
| `wake: 收件箱已接收 → X` | 0 | 帧进了 X 的收件箱，没有收到扣留或拒绝回执。接收端是 `accept` 时，这就是进了对话。它**不是**已读回执。 |
| `wake: 被扣留，尚未送达 → X` | 2 | X 的 `crossSessionInbound` 把它放进了待审队列，5 分钟内没人批准就丢。ocs 会继续盯着，最终没送达时给你的会话发一条 `[ocs 投递通知]`。 |
| `wake: 未送达 → X: refused`（或 `dropped`、`denied`、`expired`） | 2 | 接收端拒收。 |
| `wake: 已投递收件箱 → X` | 0 | 拿不到回执（Windows，或设了 `OCS_NO_RECEIPTS=1`）：只知道帧到了收件箱 socket，和 0.6 一样。 |

不管哪一种，消息都已经在频道日志里，对方跑 `ocs inbox` 能看到，不要重发。

### 脚本调用 send/dm

`ocs send … --json`、`ocs dm … --json` 在 stdout 只输出一行 JSON（人读行收进 `lines`），退出码不变：

```json
{"v":1,"command":"send","stored":true,"channel":"chat","seq":7,"wake":"accepted","exit":0,"lines":["stored #chat seq 7","…"]}
{"v":1,"command":"dm","stored":false,"error":"…","exit":1,"lines":[]}
```

| `wake` | 退出码 | 含义 |
|---|---|---|
| `accepted` | 0 | 每个唤醒都交给了载体，没报告失败。**不证明对方已读。** |
| `deferred` | 0 | Codex 目标正在跑回合，唤醒并入积压，回合结束后发出。 |
| `parked` | 0 | DM 目标没有活会话，消息留在频道里等对方读。 |
| `none` | 0 | 没有要唤醒的人（非 DM 频道、没 `@`）。 |
| `skipped` | 0 | `--no-wake`。 |
| `failed` | 2 | 已落盘，但唤醒失败或被扣留 / 拒绝。 |
| `unknown` | 3 | 已落盘，唤醒结果未知。 |

多个目标时取最差的（`unknown` > `failed` > `parked` > `deferred` > `accepted`）。`stored:false`（退出码 1）表示什么都没写，改好参数重跑即可。只要 `stored:true` 就不能重发，要确认就用 `ocs read --json` 按 `channel`/`seq` 去查。`ocs dm <地址>@<对端> --json` 暂不支持，退出码 1，不发送。`ocs read` 会在自己发的消息下面显示 `[唤醒 → X: <状态>]`（`--json` 里是 `delivery`）。消息被扣留要在接收端解决：`ocs doctor --fix`；仓库级的 Claude 设置仍然可以强制 `hold`。

Codex 侧，`ocs who` 只列当前被打开的 Desktop renderer 认领的 task；`ocs codex-sessions`
只是 rollout 历史，不是在线状态。当 Desktop 明确返回 `unavailable`、`not-open` 或 `no-source`
时，ocs 可以复用同一条已落盘消息的 channel/seq，唤醒唯一匹配且空闲的 cmux Codex surface。
降级必须同时满足标题尾部 task 短 ID 精确匹配和前台 Codex 进程仍存活；陈旧 shell、多重匹配一律
fail closed，IPC 结果未知时绝不降级。没有安全载体时，消息继续留在日志中供 `ocs inbox` 找回。

## 命令

| 命令 | 作用 |
|---|---|
| `ocs who` | 全机花名册，当前项目优先并标出你自己；`--verbose` 显示底层 ID/路径，`--json` 供程序读取 |
| `ocs whoami` | 看自动识别出的发送者身份；`--json [--session <id>]` 描述宿主会话（`{host, id, name, session, addresses}`） |
| `ocs rename <名字>` | 给当前会话起个好记的地址，短 id 照样能用。`--force` 接管别的会话占着的名字；`--clear` 删掉 |
| `ocs dm <名字或id> <内容>` | 直发并唤醒一个 agent；唯一 Claude 工作区重启后继续使用同一频道。`--inherit <旧dm频道>` 一次性绑定 v0.3.4 前的历史；`--notify-when-idle` |
| `ocs inbox` | 只列能安全归属给当前身份的未读线程；`--json` 供自动化使用，`--session <claude-session-id>` 按 id 解析指定 Claude 会话（给不在 Claude 进程树里的状态栏用） |
| `ocs send <ch> <body>` | 追加消息，`@` 触发唤醒，`--reply-to <seq>` 同时唤醒那条的作者；`--as` 只用于覆盖自动身份。`--codex` 与 `--codex-source` 接受完整 thread ID，也接受 `ocs who` 给出的唯一 `codex-<8hex>` 短地址。另支持 `--no-wake`、`--notify-when-idle`。`send`/`dm` 支持 `--json`，见[脚本调用 send/dm](#脚本调用-senddm) |
| `ocs read <ch>` | 从游标读新消息并推进。自己发的折叠成一行（`--include-self` 完整显示；`--json` 带 `self`）；`--as` 覆盖身份。另支持 `--since`、`--peek` |
| `ocs notify-when-idle <名字>` | 一次性：那个 Claude 会话下次空闲或退出时，你的会话收到一条 `[跨会话空闲通知]`（已空闲则立即；6 小时后过期） |
| `ocs sessions` | 列活着的 Claude Code 会话 |
| `ocs codex-sessions` | 列本机 Codex rollout 历史（`--limit <n>`）；不同于 `ocs who`，不代表 task 正在打开或可唤醒 |
| `ocs watch <ch>` | 跟踪频道（`--interval-ms <n>`） |
| `ocs doctor` | 体检 Claude、Codex、Pi、三端 skill 和数据目录；`--fix` 安全修复本地安装并复检 |
| `ocs skill install` | 修复或更新 Claude Code、Codex、Pi 的内置 skill，并安装 Pi 直投扩展 |
| `ocs upgrade` | 下载并安装最新的 GitHub Release 二进制（`--check` 只报告） |
| `ocs lan up \| pair \| who \| status \| peers \| scan \| unpair \| down` | 局域网模式（默认关闭）：配对机器后 `ocs dm <地址>@<对端>`、`ocs who --lan`（见[跨机器](#跨机器)） |
| `ocs version` | 打印版本 |

数据在 `~/.ocs`（`OCS_HOME` 可覆盖），频道是 JSONL 文件。备份时应保留整个目录，
包括 `workspace-key`；这个本机密钥用来稳定派生工作区身份，频道名不会暴露仓库路径或远程地址。

## 与原生 cross-session 的关系

Claude Code 和 Codex 各自都有原生的跨会话能力，在各自的岛内都很好用。ocs 不是
它们的替代品，而是两座孤岛之间的桥，外加两边都不提供的东西：

| | Claude 原生 cross-session | Codex 原生跨任务 | ocs |
|---|---|---|---|
| 覆盖 | claude ↔ claude（本机 + 跨机） | codex ↔ codex（Desktop 应用内） | 本机及局域网内配对电脑上的任意 agent 互通（Claude、Codex、Pi、终端 TUI） |
| 适合 | Claude 会话直连 | ChatGPT 任务直连 | 个人使用：本机或局域网内的跨厂商协作 |
| 跨厂商 | — | — | ✅ 本机桥接 |
| 多方参与 | agent teams（同门） | 任务 @ 提及 | ✅ 本机 agent + 人 |
| 离线投递 | 只达在线会话 | 只达开着的任务 | ◐ 消息持久留在本地频道里* |
| 共享历史/审计 | 各会话自己的记录 | 按任务 | ✅ append-only 日志，按 seq 对账，可重放 |
| 统一花名册 | 只见 Claude 会话 | 只见 Codex 任务 | ✅ `ocs who` 列出 Claude、Codex、Pi 和 cmux surface |
| Pi 支持 | — | — | ✅ 扩展直投，忙碌时排到下一轮 |
| 终端 TUI 支持 | Claude Code 会话 | —（仅 Desktop 任务） | ✅ 所有终端可读写频道；cmux 可选直投 |
| 跨载体回复引用 | 各自内部格式 | 各自内部格式 | ✅ 统一 `seq` + `--reply-to` |
| 部署 | Claude Code 内置 | ChatGPT Desktop 内置 | 单个静态二进制，不要 daemon、账号或 API key |

\* 持久化不包含自动催收：没有进程盯着谁上线，对方要等下次 `ocs inbox`、`ocs read`、被唤醒或有人提醒时才会读到积压。
Claude 的生成会话名重启后仍会变，但唯一工作区别名会对应一个加盐的本机身份。Git 仓库使用规范化远程地址，
因此不同 worktree 能落到同一 DM 历史；非 Git 工作区使用启动目录。该身份记在本机索引里，对方离线时也能续写原频道。
同一仓库多会话时会退回精确会话名，不共用私信。需要显式角色身份时使用 `OCS_NAME` / `--as`。
v0.3.4 之前的历史可用 `--inherit` 绑定一次；工作区不唯一、旧频道只有单方发言、或出现第三个参与者时会拒绝。
旧频道和稳定频道都已有消息时，ocs 会按「旧历史在前、稳定历史在后」生成确定性合并频道，两个原频道保留不动。
发起方的游标会直接推到合并频道末尾，对方首次读取时仍可查看全部继承历史。
新的 DM 会在同一日志追加不透明的命名空间 route sidecar，让 `ocs inbox` 无需反推私信频道哈希即可认领未读；
旧客户端会忽略 sidecar，但仍能读取保持原样的消息帧。
旧 DM 若没有这项元数据，只有已有 cursor 能证明曾参与时才会列出；ocs 不猜测，也不暴露无关私信。

诚实建议：claude↔claude 的快速直发用原生更顺——ocs 的 Claude 载体本来就骑在
原生收件箱 socket 上。当对话跨厂商、超过两方、需要消息在一边离线时不丢、或要留
可审计记录时，用 ocs。

## 跨机器

### 同一局域网：`ocs lan`（默认关闭）

两台机器配对一次，之后用 `<地址>@<对端>` 找远端 agent：

```bash
# 机器 A（mini）
ocs lan up                  # 启动局域网守护进程（不跑这句就没有任何监听）
ocs lan pair                # 打印一段发给 B 的文字，最多等 10 分钟

# 机器 B —— 执行那段文字里的命令
ocs lan up
ocs lan join k3m9q2xa7bfw4ndcuy2e --addr 192.168.1.20:47890
                            # 显示 6 位核对码；A 那边看到同一个码，按 y 确认
ocs who --lan               # A 上的 agent：claude-1a2b3c4d@mini  claude  idle  …
ocs dm claude-1a2b3c4d@mini "帮我看下 CI 为什么挂了"
```

信任默认是临时的：`ocs lan pair` 给 8 小时，`--for 30m|2h|7d` 换个时长，`--once` 只许一条消息，
`--forever` 留给自己的设备。两边按同一个期限互信，到期的对端会被拒绝并清掉；之后可以用
`ocs lan trust <对端> --for 8h | --forever` 改本机这边的期限。没有终端可交互时（比如 agent 跑的 `ocs lan pair`），
用 `ocs lan approve <核对码>` 确认。对方还是 ocs 0.6/0.7 的话，仍可用旧的一次性配对码：`ocs lan pair --code`。

A 上被唤醒的会话看到发送者是 `claude-9f8e7d6c@<label>`，`Reply:` 行直接回到 B。
`ocs lan status | peers | scan | who | unpair <对端> | down` 管理配对和守护进程，
`ocs lan autostart on` 让守护进程登录后自动启动。想让两边 agent 自动互回、不用每条都有人点「投递」，
接收方 Claude 要设 `crossSessionInbound: accept`（`ocs doctor --fix`），否则被扣住的消息 5 分钟后就丢了。
Windows 的注意事项（命名管道收件箱、防火墙规则）见 [docs/lan.md](./docs/lan.md#windows)。

安全要点：每台机器一把 Ed25519 身份密钥；配对文字钉死发起方的公钥指纹，发起方要等两边屏幕显示
同一个由这次连接密钥算出的 6 位核对码才确认，不存在「首次连接即信任」；
每次连接都是带签名的 X25519 握手（前向保密）+ AES-256-GCM；未配对的机器只能在有人等待配对时发一个请求，
别的什么都做不了。**配对等于允许那台机器给你的 agent 下提示**，和本机另一个会话的权限一样。
局域网发现的应答只包含实例名、端口和公钥指纹。完整协议与威胁模型见 [docs/lan.md](./docs/lan.md)。

### 不同网络：虚拟局域网

`ocs lan` 只要求两台机器能连上对方的 TCP 47890 端口。不在同一个网络的机器，接入同一个虚拟局域网（Tailscale、WireGuard、ZeroTier 或公司 VPN）就满足了，ocs 不用做任何改动。这类网络一般不转发组播，局域网发现找不到对方，所以按地址配对：

```bash
# 机器 B，A 已经跑了 `ocs lan pair`——公钥取自 A 发来的文字，地址用 A 的 VPN 地址
ocs lan join k3m9q2xa7bfw4ndcuy2e --addr 100.64.0.7:47890
```

信任库会记住地址，之后重连不再依赖发现。跨网段、只按地址（不靠组播）配对已在 macOS 和 Windows 之间实测；Tailscale、WireGuard 本身还不在测试矩阵里。建议走 VPN，不要把 47890 端口直接开到公网：协议本身双向认证加密，但走 VPN 端口根本不暴露在公网上。

### 其他情况：SSH

不开局域网守护进程时 OCS 没有任何监听。两台个人机器已有免密 SSH 时，继续由用户的 SSH config 负责认证与 host key 校验，控制端直接调用目标机器上的本地工具：

```bash
ssh workbox ocs who --verbose
ssh workbox ocs dm codex-<8hex> "检查当前失败"

# 远端 agent/runtime 管理属于 Herdr，不在 OCS 重造。
ssh workbox herdr agent list
ssh workbox herdr agent prompt reviewer "跑测试并总结失败" --wait --timeout 120000
```

SSH 免密方向决定角色。如果只有机器 B 能连接机器 A，那么 B 就是控制端，A 就是 `workbox`；不需要反向登录或新增 OCS adapter。面向人的指令应给远端 agent 带上 SSH 主机命名空间（例如 `workbox/reviewer`），避免与本机同名 agent 混淆。

## 常见问题

为什么做 ocs、以及它绕开的那几个「看似成功、其实丢了」的坑：[Claude Code 和 Codex 怎么一起用？](https://blog.leeguoo.com/zh/posts/ocs-cross-agent-wake/)

### Claude Code 和 Codex 能互相通信吗？

能。机器上装好 ocs，在 Claude Code 里跑 `ocs dm codex-<id> "帮我审下这个 diff"`，或者直接对 Claude 说「找个 agent 帮你看看」。Codex 任务会被叫醒，收到消息和一行可以直接执行的回复命令，两个 agent 就能来回对话，不用你在窗口之间复制粘贴。反过来 Codex 找 Claude 也一样，Pi 和终端里的 agent 同样可以加入。

### 怎么让两个 Claude Code 会话互相对话？

Claude Code 自带的 cross-session 已经能让 Claude 和 Claude 互发消息，ocs 也是走同一个收件箱。对话里还有 Codex 或 Pi、需要两个以上参与者、要在会话重启后接着聊，或者跨两台电脑时，用 ocs。接收端要在 `~/.claude/settings.json` 里设 `"crossSessionInbound": "accept"`（`ocs doctor --fix` 会设）。默认的 `hold` 下，消息要等人手动批准，5 分钟没人处理就丢；这时 ocs 不会报成已送达：发送时显示 `wake: 被扣留` 并以退出码 2 结束，最终没人批准再给发送方发一条投递通知。

### 不同电脑上的 AI agent 能互发消息吗？

同一个局域网里可以。两台机器都跑 `ocs lan up`，用 `ocs lan pair` 配对一次，之后用 `<名字>@<对端>` 找远端的 agent。连接双向认证并加密（Ed25519 身份、带签名的 X25519 握手、AES-256-GCM），已在 macOS 和 Windows 之间实测。不在同一个网络时，让两台机器接入同一个虚拟局域网（Tailscale、WireGuard、ZeroTier 或公司 VPN），配对时加 `--addr <对方VPN地址>:47890`，见[不同网络](#不同网络虚拟局域网)。

### 支持 Windows 吗？

支持。有 Windows x64 二进制（`irm https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.ps1 | iex`），通过命名管道收件箱唤醒 Claude Code，通过本地 IPC 管道唤醒 ChatGPT Desktop 里的 Codex，也能加入局域网模式。

Codex 的管道名（`\\.\pipe\codex-ipc`）是固定的，本机任何进程都可以抢先建出来。0.7.1 起 ocs 在即将使用的那条连接上核对管道的服务端：管道属主必须是你，服务端进程必须以你的身份运行，并且是 ChatGPT Desktop（Store 包 `OpenAI.Codex`，映像在包的安装目录里）。不满足就什么都不发，消息留在收件箱，`ocs doctor` 会写出原因。不是 Store 包的 Desktop、以管理员身份运行的 Desktop 也会被拒。

### 需要服务器、账号或 API key 吗？

都不需要。ocs 是一个静态二进制，消息是 `~/.ocs` 里的 JSONL 文件。不开局域网模式时什么都不出本机；开了也只发给你配对过的电脑。

### 和 subagent、agent teams、用 MCP 调 Codex 有什么区别？

subagent 和 agent teams 由一个 Claude 会话创建、归它管；MCP 桥是把 Codex 变成 Claude 调用的一个工具。ocs 连接的是彼此独立、长期运行的会话：每个会话保留自己的上下文、工具和操作它的人，任何一方都可以先开口。

## 开发

```bash
bun install
bun test            # Claude/Pi Unix socket 端到端 + 假 Desktop-IPC 路由器
bunx tsc --noEmit
```

架构决策与组件出处：[DESIGN.md](./DESIGN.md)、[docs/agentparty-extraction-map.md](./docs/agentparty-extraction-map.md)。贡献者须知的工程约束：[CLAUDE.md](./CLAUDE.md)。

## 许可

MIT。三个源文件从 [AgentParty](https://github.com/leeguooooo/agentparty) 移植（同一版权人，按 MIT 重新授权），文件头标注了上游出处。

## 作者

**郭立（Guo Li / leeguoo）** 开发 —— [leeguoo.com](https://leeguoo.com/about) · [GitHub](https://github.com/leeguooooo) · [X](https://x.com/leeguooooo) · 更多工具见 [*-use 家族](https://github.com/leeguooooo/plugins)。
