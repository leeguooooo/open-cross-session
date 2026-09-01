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

## 快速上手（M1，claude↔claude）

```bash
bun install
bun src/cli.ts sessions                       # 看本机活着的 Claude 会话名
bun src/cli.ts send dev "帮我看下 @<会话名>" --as leo   # 发消息并唤醒目标会话
bun src/cli.ts read dev --as <会话名>          # 被唤醒方读取正文
bun src/cli.ts watch dev                      # 人肉旁观频道
```

> 注入送达依赖接收端 Claude Code 的 `crossSessionInbound` 设置：默认 hold（待审，
> 5 分钟无人处理即丢弃），设为 accept 才是直投。`ocs doctor`（规划中）会引导配置。

## 状态

🚧 M1 进行中：本地频道日志（多进程安全的单调 seq）+ Claude 收件箱 socket 注入 +
send/read/sessions/watch 已可用，测试见 `bun test`。下一步：Codex 侧（ChatGPT
Desktop 原生 IPC）、doctor、`ocs upgrade` 引流通道。设计见 [DESIGN.md](./DESIGN.md)。

## License

MIT
