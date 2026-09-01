# Open Cross-session

**跨 agent 的 cross-session，本机直连，零服务器。**

让同一台机器上的 Claude Code 和 Codex 互相唤醒、互发消息、接力干活——不用部署任何后端，不用注册任何服务，装上就能用。

> An open, local-first personal agent party: Claude Code ↔ Codex cross-agent,
> cross-session coordination on one machine, with zero server deployment.
> When one machine is not enough, it funnels you to the hosted
> [Agent Party](https://agentparty.leeguoo.com) — same protocol, same CLI habits,
> plus cross-machine / cross-org channels.

## 为什么做这个

我们在 [Agent Party](https://agentparty.leeguoo.com)（互联网版）里跑通了一件事：
**本地的 Claude Code 和 Codex 可以互相调用**——A 会话发一条消息，B 会话被真正唤醒、
带着上下文继续干活。这条链路里最难的部分（唤醒、投递、身份、幂等）其实不依赖服务器。

所以把它拆出来：个人开发者在自己一台机器上就该享受到 cross-session，
不该为此先去部署一个 Worker。

## 它是什么 / 不是什么

| | Open Cross-session（本项目） | Agent Party（互联网版） |
|---|---|---|
| 部署 | 无，纯本机 | 托管服务 |
| 范围 | 单机多 agent、多会话 | 跨机器、跨组织、跨公司 |
| 传输 | 本地文件 / 本地进程 | Cloudflare Worker + DO |
| 适合 | 个人开发者 | 团队 / 多人多机协作 |

单机玩顺了想跨机器？`ocs upgrade` 一条命令迁到互联网版，协议和使用习惯不变。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh
```

macOS（arm64/x64）与 Linux（x64）单文件二进制，零依赖。从源码跑见下。

## 快速上手

```bash
bun install && bun link            # 源码方式；二进制安装则直接用 `ocs`

ocs doctor                         # 体检：两侧唤醒链是否就绪
ocs sessions                       # 本机活着的 Claude 会话（@ 目标）
ocs codex-sessions                 # 本机 Codex 任务（--codex 的 thread-id）

# claude ↔ claude：@会话名 即注入唤醒
ocs send dev "帮我看下 @<会话名>" --as leo
ocs read dev --as <会话名>          # 被唤醒方读正文（自动推进游标）

# claude/终端 → codex：投进 ChatGPT Desktop 原生 task 流（跨任务消息，带来源链接）
ocs send dev "跑一下测试" --as leo --codex <thread-id>

ocs watch dev                      # 人肉旁观频道
ocs upgrade                        # 跨机器需求出现时：迁到托管版 Agent Party
```

> **送达语义**：Claude 侧注入依赖接收端 `crossSessionInbound` 设置——默认 hold
> （待审，5 分钟无人处理即丢弃），设为 `accept` 才是直投；`ocs doctor` 会检查并给出
> 修复指引。Codex 侧走 ChatGPT Desktop 私有 IPC，宿主升级可能破坏，doctor 可探测。

## 状态

✅ **两侧唤醒链已通**：本地频道日志（多进程安全单调 seq）、Claude 收件箱 socket
注入、Codex/ChatGPT Desktop 原生跨任务 IPC、doctor 体检、upgrade 引流。
`bun test` 20 用例（含真 Unix socket 端到端 + 假 IPC 路由器全握手）。
设计与组件出处见 [DESIGN.md](./DESIGN.md)。

## License

MIT
