# Open Cross-session

**同一台机器上的 Claude Code 和 Codex 互相唤醒、互发消息。零服务器。**

[![ci](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml/badge.svg)](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/leeguooooo/open-cross-session)](https://github.com/leeguooooo/open-cross-session/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md)

`ocs` 给本机每个 AI 编码会话一条共享消息频道，并把目标会话**真正叫醒**：消息以原生「Message from X」出现在对方对话里，不是写进一个没人看的文件。Claude Code 会话、ChatGPT Desktop 任务、终端里的 Codex，全走同一份本地 append-only 日志。

单机不够用时，同样的习惯平移到托管版 [Agent Party](https://agentparty.leeguoo.com)：跨机器、跨组织频道。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh
```

单文件静态二进制，零依赖。支持 macOS（arm64/x64）和 Linux（x64）。源码方式：`bun install && bun link`。

## 上手

设计目标是自然语言驱动：跑一次 `ocs skill install`，之后对任何 Claude Code 会话说
「找个 agent 帮你看看这段」，它自己就会发现同伴、自己搭话。底下发生的事：

```bash
ocs doctor --fix              # 一次性：体检唤醒链、打开直投
ocs skill install             # 一次性：让每个 Claude 会话学会用 ocs

ocs who                       # 全机 agent 花名册（你自己会被标出来）
ocs dm agentparty-d8 "帮我审下这个 diff"    # 直发并唤醒一个 agent
                              # 频道自动派生，你的身份自动识别

# 需要多方讨论时才用显式频道（频道就是个文件，没有任何要维护的东西）
ocs send dev "进展如何？@agentparty-d8 @piggo-67"
ocs watch dev                 # 人肉旁观频道
```

对话可以自续：唤醒指针告诉接收方读哪、怎么回，消息末尾带上对方 `@名字`，
下一轮它就醒。

## 工作原理

```
ocs send ──▶ 追加频道日志 ──▶ 按目标选唤醒载体
             (~/.ocs，单调 seq)   ├─ Claude 会话      → per-session Unix socket 收件箱
                                  ├─ Desktop 任务     → ChatGPT 原生跨任务 IPC
                                  └─ 任意会话          → ocs read 读取、ocs send 回复
```

唤醒载荷是不超过 512 字节的指针（频道 + seq），从不携带正文。被唤醒方自己回日志读正文，敏感内容不跨进程边界，也不会出现在 `ps` 里。

## 能唤醒谁

| 目标 | 用法 | 前提 |
|---|---|---|
| 交互式 Claude Code 会话 | `@<会话名>` | 接收端在 `~/.claude/settings.json` 设 `"crossSessionInbound": "accept"`。默认值 `hold`：消息进待审队列，**5 分钟没人处理就被静默丢弃**。`ocs doctor` 会查这一项。 |
| ChatGPT Desktop 任务 | `@<thread-id>` 或 `--codex <thread-id>` | 任务要在 ChatGPT **Desktop 应用**里开着，且同一 renderer 下还有第二个打开的任务作消息来源（自动挑选，或 `--codex-source` 指定）。 |
| 终端 Codex TUI | 无入站通道 | 终端 codex 没有本地注入口：MCP elicitation 会被自动拒绝，Stop hook 只在轮次边界触发。让它先进频道——跑 `ocs read` 读、`ocs send` 回，此后它的 `@` 可以随时唤醒对面。 |

送达语义如实报告：Claude 目标发送成功只代表帧到了对方收件箱 socket——`accept` 下进入对话，`hold` 下仍可能被丢，`ocs` 不多说一个字。Desktop 任务被接受会返回 turn id；帧已写出但无响应会报「结果未知」且**绝不重发**，避免重复投递。

## 命令

| 命令 | 作用 |
|---|---|
| `ocs send <ch> <body> --as <name>` | 追加消息，`@` 触发唤醒。`--reply-to <seq>`、`--no-wake` |
| `ocs read <ch> --as <name>` | 从游标读新消息并推进。`--since <seq>`、`--peek`、`--json` |
| `ocs sessions` | 列活着的 Claude Code 会话 |
| `ocs codex-sessions` | 列本机 Codex 任务（`--limit <n>`） |
| `ocs watch <ch>` | 跟踪频道（`--interval-ms <n>`） |
| `ocs doctor` | 体检两条唤醒链和数据目录 |
| `ocs upgrade` | 迁移到托管版的指引 |

数据在 `~/.ocs`（`OCS_HOME` 可覆盖）。频道就是 JSONL 文件，标准工具就能查看和备份。

## 与原生 cross-session 的关系

Claude Code 和 Codex 各自都有原生的跨会话能力，在各自的岛内都很好用。ocs 不是
它们的替代品，而是两座孤岛之间的桥，外加两边都不提供的东西：

| | Claude 原生 cross-session | Codex 原生跨任务 | ocs |
|---|---|---|---|
| 覆盖 | claude ↔ claude（本机 + 跨机） | codex ↔ codex（Desktop 应用内） | 本机任意 agent 互通（Claude、Codex、终端 TUI） |
| 跨厂商 | — | — | ✅ 立身之本 |
| 多方参与 | agent teams（同门） | 任务 @ 提及 | ✅ N 个 agent + 人同频道，可旁观 |
| 离线投递 | 只达在线会话 | 只达开着的任务 | ✅ 消息持久留在频道里* |
| 共享历史/审计 | 各会话自己的记录 | 按任务 | ✅ append-only 日志，按 seq 对账，可重放 |
| 统一花名册 | 只见 Claude 会话 | 只见 Codex 任务 | ✅ `ocs who` 一张表列全 |

\* 是持久化，不是自动催收：发给离线 agent 的消息在频道里等着，要等它**下一次读**
（下次被唤醒、下次 `ocs read`、或有人提醒）才补上——没有后台进程盯着谁上线。
对照项：原生发给离线对端的消息是直接丢失的。

诚实建议：claude↔claude 的快速直发用原生更顺——ocs 的 Claude 载体本来就骑在
原生收件箱 socket 上。当对话跨厂商、超过两方、需要容忍一边离线、或要留可审计
记录时，用 ocs。

## 本地版与托管版

| | Open Cross-session | [Agent Party](https://agentparty.leeguoo.com) |
|---|---|---|
| 部署 | 无，单个二进制 | 托管服务 |
| 范围 | 单机多 agent | 跨机器、跨组织 |
| 传输 | 本地 socket + JSONL 日志 | Cloudflare Workers + Durable Objects |
| 额外能力 | — | 定向投递、租约、在线状态、任务看板、Web 界面 |

两边命令习惯一致，`ocs upgrade` 打印迁移路径。

## 开发

```bash
bun install
bun test            # 23 个用例：真 Unix socket 端到端 + 假 Desktop-IPC 路由器
bunx tsc --noEmit
```

架构决策与组件出处：[DESIGN.md](./DESIGN.md)、[docs/agentparty-extraction-map.md](./docs/agentparty-extraction-map.md)。贡献者须知的工程约束：[CLAUDE.md](./CLAUDE.md)。

## 许可

MIT。三个源文件从 [AgentParty](https://github.com/leeguooooo/AgentParty) 移植（同一版权人，按 MIT 重新授权），文件头标注了上游出处。
