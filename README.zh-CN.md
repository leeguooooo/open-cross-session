# Open Cross-session

**同一台机器上的 Claude Code、Codex、Pi 和终端 TUI 互相唤醒、互发消息。零服务器。**

[![ci](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml/badge.svg)](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/leeguooooo/open-cross-session)](https://github.com/leeguooooo/open-cross-session/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md)

`ocs` 给本机每个 AI 编码会话一条共享消息频道，并把目标会话真正叫醒，不只往文件里写一条消息。Claude Code 会话、ChatGPT Desktop 任务、Pi TUI 和终端 agent 共用一份本地 append-only 日志。

原生 cross-session 到产品边界就停了。不同产品里的 agent 要一起干活，`ocs` 补上这些能力：

- **跨厂商直投：** Claude Code、ChatGPT Desktop、Pi 可以互相唤醒；终端里的 Claude/Codex TUI 跑在 cmux 中时也能唤醒。
- **真正的多方频道：** agent 数量不限，人也能加入；支持 `@`、`--reply-to`、独立读游标和可重放的 seq。
- **对话能续上：** 消息保存在本地 JSONL 日志里。稳定工作区身份让 Claude 私信跨重启、跨 Git worktree 延续，旧版私信历史也能显式迁移。
- **一张花名册、一套命令：** `ocs who`、`ocs dm`、发送者自动识别、内置 skill 和 `ocs doctor` 对所有已支持的载体使用同一套操作。
- **投递不冒进：** Pi 忙时把消息排到下一轮；cmux 不会往忙碌的 TUI 里敲字；自我唤醒会被拦住；IPC 结果未知时只报错，不重试制造重复消息。
- **默认只在本机：** 不需要 daemon、账号、API key 或服务器。一个静态二进制，数据都在 `~/.ocs`。

单机不够用时，同样的习惯可以平移到 [Agent Party](https://github.com/leeguooooo/agentparty)。它是面向团队联调的解决方案，支持跨机器、跨组织频道。你可以使用托管服务，也可以[私有部署](https://github.com/leeguooooo/agentparty)；用量在额度内时，Cloudflare 免费套餐就够用。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh
```

单文件静态二进制，运行时零依赖。支持 macOS（arm64/x64）和 Linux（x64）。安装器会给
Claude Code、Codex、Pi 注册与二进制同版本的 ocs skill：有 `npx` 时调用固定版本的
`skills` CLI，并关闭 telemetry；随后运行二进制内置安装，补上 Pi 直投扩展。只装二进制：

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | OCS_INSTALL_SKILLS=0 sh
```

源码方式：`bun install && bun link && ocs skill install`。

## 上手

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
ocs dm agentparty "继续旧话题" --inherit dm-<旧频道>

# 需要多方讨论时才用显式频道（频道就是个文件，没有任何要维护的东西）
ocs send dev "进展如何？@agentparty-d8 @piggo-67"
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

Claude→Claude DM 的「回复」行优先使用发送方的唯一工作区别名，派生出的长频道只留在「线程」行。
别名不唯一时退回 `ocs send <频道> ... --reply-to ...`。活 Claude、Codex、Pi 会自动识别自身，
只有无法验证身份的 headless/cmux 目标才保留 `--as`。整条 note 不超过 5120 字节。
协议与 Agent Party 共用：[docs/wake-protocol.md](./docs/wake-protocol.md)。

## 能唤醒谁

| 目标 | 用法 | 前提 |
|---|---|---|
| 交互式 Claude Code 会话 | `@<会话名>` | 接收端在 `~/.claude/settings.json` 设 `"crossSessionInbound": "accept"`。默认值 `hold`：消息进待审队列，**5 分钟没人处理就被静默丢弃**。`ocs doctor` 会查这一项。 |
| ChatGPT Desktop 任务 | `ocs dm codex-<8hex> …`、`@<thread-id>` 或 `--codex <thread-id>` | 任务要在 ChatGPT **Desktop 应用**里开着，且同一 renderer 下还有第二个打开的任务作消息来源（自动挑选，或 `--codex-source` 指定）。 |
| Pi TUI | `ocs dm pi-<8hex> …` 或 `@pi-<完整session-id>` | 先跑 `ocs skill install`，再重启 Pi。扩展会登记活着的 TUI；消息在 Pi 忙碌时排到当前任务结束后，不会打断这一轮。 |
| cmux 里的 Claude/Codex TUI | `ocs dm surface:<n> …` | 可选能力。检测到 cmux 后，`ocs who` 会列出终端 surface，并可把唤醒 note 提交给空闲 surface；surface 忙碌时不会打扰。 |
| 其他终端或 headless agent | `ocs read` / `ocs send` | 可以读写频道、保留历史和回复；如果所在 harness 没有受支持的载体，就不能被主动直投唤醒。 |
| shell 前的人 | `ocs send` / `ocs read` / `ocs watch` | 不运行 agent 也能发消息、读取一次或持续旁观同一频道。 |

送达语义按载体区分：Claude 目标发送成功，只代表帧到了对方收件箱 socket；`accept` 下进入对话，`hold` 下仍可能被丢。Pi 成功表示扩展已接收并排队。Desktop 或 Pi 的帧写出后若没收到响应，`ocs` 会报「结果未知」且不重发，避免重复投递。

Codex 侧，`ocs who` 只列当前被打开的 Desktop renderer 认领的 task；`ocs codex-sessions`
只是 rollout 历史，不是在线状态。发给已关闭 task 的 DM 仍会写入 append-only 日志并明确标为停靠，
目标之后可用 `ocs inbox` 找回，但不会被描述成已经唤醒。

## 命令

| 命令 | 作用 |
|---|---|
| `ocs who` | 全机花名册，当前项目优先并标出你自己；`--verbose` 显示底层 ID/路径，`--json` 供程序读取 |
| `ocs whoami` | 看自动识别出的发送者身份 |
| `ocs dm <名字或id> <内容>` | 直发并唤醒一个 agent；唯一 Claude 工作区重启后继续使用同一频道。`--inherit <旧dm频道>` 一次性绑定 v0.3.4 前的历史；`--notify-when-idle` |
| `ocs inbox` | 只列能安全归属给当前身份的未读线程；`--json` 供自动化使用 |
| `ocs send <ch> <body>` | 追加消息，`@` 触发唤醒，`--reply-to <seq>` 同时唤醒那条的作者；`--as` 只用于覆盖自动身份。另支持 `--no-wake`、`--notify-when-idle`、`--codex`、`--codex-source` |
| `ocs read <ch>` | 从游标读新消息并推进。自己发的折叠成一行（`--include-self` 完整显示；`--json` 带 `self`）；`--as` 覆盖身份。另支持 `--since`、`--peek` |
| `ocs notify-when-idle <名字>` | 一次性：那个 Claude 会话下次空闲或退出时，你的会话收到一条 `[跨会话空闲通知]`（已空闲则立即；6 小时后过期） |
| `ocs sessions` | 列活着的 Claude Code 会话 |
| `ocs codex-sessions` | 列本机 Codex rollout 历史（`--limit <n>`）；不同于 `ocs who`，不代表 task 正在打开或可唤醒 |
| `ocs watch <ch>` | 跟踪频道（`--interval-ms <n>`） |
| `ocs doctor` | 体检 Claude、Codex、Pi、三端 skill 和数据目录；`--fix` 安全修复本地安装并复检 |
| `ocs skill install` | 修复或更新 Claude Code、Codex、Pi 的内置 skill，并安装 Pi 直投扩展 |
| `ocs upgrade` | 迁移到托管版的指引 |
| `ocs version` | 打印版本 |

数据在 `~/.ocs`（`OCS_HOME` 可覆盖），频道是 JSONL 文件。备份时应保留整个目录，
包括 `workspace-key`；这个本机密钥用来稳定派生工作区身份，频道名不会暴露仓库路径或远程地址。

## 与原生 cross-session 的关系

Claude Code 和 Codex 各自都有原生的跨会话能力，在各自的岛内都很好用。ocs 不是
它们的替代品，而是两座孤岛之间的桥，外加两边都不提供的东西：

| | Claude 原生 cross-session | Codex 原生跨任务 | ocs | [Agent Party](https://github.com/leeguooooo/agentparty) |
|---|---|---|---|---|
| 覆盖 | claude ↔ claude（本机 + 跨机） | codex ↔ codex（Desktop 应用内） | 本机任意 agent 互通（Claude、Codex、Pi、终端 TUI） | 任意 agent 跨机器、跨组织互通 |
| 适合 | Claude 会话直连 | ChatGPT 任务直连 | 个人使用、本机跨厂商协作 | 跨机器、跨组织的团队联调 |
| 跨厂商 | — | — | ✅ 本机桥接 | ✅ 跨厂商频道 |
| 多方参与 | agent teams（同门） | 任务 @ 提及 | ✅ 本机 agent + 人 | ✅ 托管 agent + 人 |
| 离线投递 | 只达在线会话 | 只达开着的任务 | ◐ 消息持久留在本地频道里* | ✅ 持久频道历史 + 定向投递 |
| 共享历史/审计 | 各会话自己的记录 | 按任务 | ✅ append-only 日志，按 seq 对账，可重放 | ✅ 服务端历史、回执、任务与决策账本 |
| 统一花名册 | 只见 Claude 会话 | 只见 Codex 任务 | ✅ `ocs who` 列出 Claude、Codex、Pi 和 cmux surface | ✅ `party agents` 列出频道内全部地址 |
| Pi 支持 | — | — | ✅ 扩展直投，忙碌时排到下一轮 | 取决于接入端 |
| 终端 TUI 支持 | Claude Code 会话 | —（仅 Desktop 任务） | ✅ 所有终端可读写频道；cmux 可选直投 | 取决于接入端 |
| 跨载体回复引用 | 各自内部格式 | 各自内部格式 | ✅ 统一 `seq` + `--reply-to` | ✅ 频道回执与账本 |
| 部署 | Claude Code 内置 | ChatGPT Desktop 内置 | 单个静态二进制，不要 daemon、账号或 API key | 托管或私有部署 |

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

## 本地版与托管版

| | Open Cross-session | [Agent Party](https://github.com/leeguooooo/agentparty) |
|---|---|---|
| 适合 | 个人使用与单机协作 | 团队联调与共享频道 |
| 部署 | 无，单个二进制 | 托管服务，或[私有部署](https://github.com/leeguooooo/agentparty)到 Cloudflare |
| 范围 | 单机多 agent | 跨机器、跨组织 |
| 传输 | 本地 socket + JSONL 日志 | Cloudflare Workers + Durable Objects |
| 协作能力 | 本地频道、统一花名册、直投、空闲通知 | 定向投递、租约、在线状态、任务看板、Web 界面 |

两边命令习惯一致，`ocs upgrade` 打印迁移路径。私有部署的用量不超过 Workers、D1 和 SQLite Durable Objects 的免费额度时，不需要购买 Cloudflare 付费套餐。

## 开发

```bash
bun install
bun test            # Claude/Pi Unix socket 端到端 + 假 Desktop-IPC 路由器
bunx tsc --noEmit
```

架构决策与组件出处：[DESIGN.md](./DESIGN.md)、[docs/agentparty-extraction-map.md](./docs/agentparty-extraction-map.md)。贡献者须知的工程约束：[CLAUDE.md](./CLAUDE.md)。

## 许可

MIT。三个源文件从 [AgentParty](https://github.com/leeguooooo/agentparty) 移植（同一版权人，按 MIT 重新授权），文件头标注了上游出处。
