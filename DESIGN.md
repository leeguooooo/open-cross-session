# Open Cross-session — 设计文档

状态：草案 v0.1（2026-09-01）

## 一、定位

**跨 agent（Claude Code ↔ Codex）、跨 session 的本地协作层，零服务器。**
多方频道语义（N 个 agent + 人同频道），真唤醒（不是文件轮询），
与托管版 Agent Party 共享协议——单机玩顺后一条命令升级到跨机器/跨组织。

## 二、竞争格局（2026-09-01 实查）

### 直接同赛道

| 项目 | star | 机制 | 弱点 |
|---|---|---|---|
| [agent-bridge](https://github.com/raysonmeng/agent-bridge) | 316 | MCP bridge + daemon 代理 codex app-server，本地 WS，push 唤醒 | **1:1 管道**，无频道/多方语义，默认 `--dangerously-skip-permissions`，无托管路径 |
| [codex-claude-bridge](https://github.com/abhishekgahlot2/codex-claude-bridge) | 54 | 基于 Claude Code Channels（需开发通道 flag） | 依赖 preview flag，小众 |
| bohdanpodvirnyi/agent-session-bridge | 103 | — | 2026-04 起停更 |

「第一个做」的窗口已关（agent-bridge 占了），但最强者才 316 star，
**「做得完整」的窗口开着**，细分赛道认知度还很低。

### 平台层（最大风险）

- **Anthropic 官方**：Agent Teams + 跨 session messaging（ListAgents/SendMessage，
  本机+跨机）+ Claude Code Channels。**claude↔claude 官方已内置**，
  这半边随时被吃干净——但官方永远不会替用户管 Codex。
- **OpenAI 官方**：Codex app 已支持多 task 并行 + task 间 @ 提及，
  即 codex↔codex 官方已成型（这正是我们 #1012 接入的 IPC）。官方没做跨厂商。

→ 结论：**卖点必须压在「跨厂商 + 频道 + 托管引流」上**，
不能建在任一官方下个版本就能覆盖的功能上。

### 邻近赛道（不同物种）

- **multica**（48.4k star，周更）：Go server + daemon 的单组织 Managed Agents 平台，重部署。
- **Gas Town**（17.9k）：tmux + beads 工单队列驱动 20-30 个 agent，Claude 为主，工单语义非对话唤醒。
- **claude-squad**（8.4k）：tmux + worktree 并行管理器，agent 间不互通。
- **conductor.build**：闭源 Mac app，人管多 agent，agent 不互通。
- **happy**（23.6k）：人远程遥控自己会话的加密 relay，非 agent↔agent。
- **vibe-kanban**（28k）：4 个月停更。terragon：2026-01 已关停——
  纯远程包壳赛道在死，**「本地优先 + 可选托管」是被验证的活路**。
- **A2A 协议**（v1.0，Linux Foundation）：Claude Code / Codex 均无原生实现，暂无实质威胁；
  谁先原生 A2A 谁占互操作叙事，留意。

### 差异化窗口（无人在做）

1. **多方频道**：N agent + 人同频道；本地竞品全是 1:1 或 hub-spoke。
2. **Codex 原生跨任务通信**：#1012 直接进官方 ChatGPT task 流（IPC + linked reply），
   无竞品做到——README 头牌卖点。
3. **托管升级通道**：同一协议从本机零服务器平滑升到跨机跨组织，独此一家。
4. **权限与身份做正**：对比 agent-bridge 的权限裸奔，安全叙事差异点。
5. **双侧真唤醒**：Claude Stop hook + Codex 原生 IPC，比文件轮询/tmux 注入可靠。

## 三、可抽取组件地图（来自 agentparty 主仓盘点）

> 完整盘点（带 file:line 引用与三档标注）见
> [docs/agentparty-extraction-map.md](./docs/agentparty-extraction-map.md)。以下是结论。

**主仓已存在两条纯本地零网络传输**，本地版不需要发明传输：

1. **Claude 侧**：`claude-inbox-inject.ts` — cc-socks Unix socket
   （`/tmp/cc-socks/<pid>.sock`）按 PID 寻址注入活会话，JSONL 帧，
   ≤512B channel+seq 指针载荷（正文永远回频道重读）。
2. **Codex 侧**：`codex-desktop-ipc.ts`（#1012）— ChatGPT Desktop 自己的
   `~/.codex/ipc/ipc.sock`，用 `thread-follower-start-turn` + `codex_app`
   toolOutput 注入原生跨任务消息，UI 里保留原生来源链接。
3. **补充**：Codex Stop hook 的 `{"decision":"block","reason":…}` —
   `reason` 即注入 prompt（≤512B），机制全本地，只有「有没有新消息」一问走服务端。

**可几乎原样复用**（零服务端依赖）：两个 session registry、
`serve-wake-proxy` 全套、`codex-sessions` / `codex-session-kind` /
`codex-stop-wake`（决策纯函数）、`codex-turn-arbiter`（transport 本来就是注入的）、
hook 信任闸修复器、`runtime-topology`（本地 locality 判定的隐藏宝石，只需换盐）、
`join-binding` / `instance-lock` / cursor+stuck / `continuation` /
`atomic-json` / `mention-wake-claim`、`MsgFrame` 数据形状及其两条铁律
（只按 seq 定序绝不按 ts；`isMessageFrame` 校验必须逐字镜像字段表，#622）。

**只需重写两个收敛点**：`rest.ts`（全部 HTTP 汇聚于单个 fetch——保签名、
换成本地存储实现）和 `client.ts` 的 `connect()`（唯一 WS 收敛点——换成本地日志 tail）。
**25 个 MCP handler 一行不用改。**

**服务端绑死可直接删**：OIDC/token、lease epoch/token 的分布式 CAS 协议、
presence 心跳（本地读 registry 即可）、`worker_upgrade_required` 等纯服务端 blocker。

## 四、架构

```
┌─ Claude 会话 ─┐   ┌─ Codex/ChatGPT task ─┐   ┌─ headless ─┐
│ cc-socks UDS  │   │ Desktop IPC          │   │ claude -p  │
│ 注入          │   │ thread-follower      │   │ --resume / │
└──────┬────────┘   └────────┬─────────────┘   │ codex resume│
       │                     │                 └─────┬──────┘
       └───────── 按目标 harness 选载体 ─────────────┘
                         ▲
              本机 append-only 消息日志
        （SQLite/JSONL，per-channel 单调 seq）
              + UDS/文件 watch 新消息通知
```

- 投递 = 写日志 → 通知 → 选载体注入；正文永远由被唤醒方回日志重读（指针模式）。
- 身份：沿用「每身份一进程 MCP，绝不共享 daemon」硬约束（权限放大教训 #865/#862）；
  身份 key 从 `server+name` 换成本地 config path。
- 验收：直接抄 `verify-agentparty-claude-cross-session.ts` 的 21 条证据链，
  删掉 worker/runtime_peer 两类纯服务端 blocker。

**两个必须正面解决的坑**（都静默失败、不回错）：

1. Claude 跨会话收件箱默认 **hold**，5 分钟无人 Deliver 即丢弃——本地版要么改默认
   放行策略，要么设计带确认的回路，不能沿用「发了就不管」。
2. Codex ≥0.149 的 **hook 信任闸**——`hooks.json` 里的 hook 未在 `config.toml`
   批准就静默跳过。修复器可复用；绝不用 `--dangerously-bypass-hook-trust`。

**风险**：Desktop IPC 依赖 ChatGPT.app 私有协议，宿主升级会破——需要版本探测 + 降级路径
（headless spawn 兜底）。

## 五、共享维护策略（两个项目一处维护）

目标（owner 拍板方向）：跑通之后抽公共组件，**canonical 只有一处**，两个项目都从它维护。

分两阶段：

**阶段 1（MVP 期，现在）**：open-cross-session 独立仓开发，需要的模块从主仓
vendor 副本进来，先跑通再谈抽象。过早抽包会拖慢验证。

**阶段 2（跑通之后）**：采用主仓已被验证的「单向 sync 镜像」模式
（先例：`skills/` → `plugins/` 由 `sync-agentparty-plugin.ts` 生成镜像）：

- 在 AgentParty monorepo 新增 workspace 包 `packages/cross-session-core`（MIT 许可，
  与主仓 BUSL-1.1 并存——公共层单独授权，即经典 open-core 结构），
  沉淀：协议数据结构、claude-inbox-inject、codex-desktop-ipc、唤醒适配器、总线接口。
- open-cross-session 仓成为**发行镜像**：主仓 CI 单向 sync 代码 + 随 v* tag
  发 GitHub Release 二进制（沿用 install.sh 模式，不进 npm registry）。
- 开源仓 CONTRIBUTING 注明 PR 路由：镜像仓收 issue 和讨论，代码 PR 引导到主仓
  （或收下后由维护者 backport），避免双头改动。

两个注意点：
1. **许可**：主仓是 BUSL-1.1，抽出的公共层要改 MIT。代码基本是 owner 主导产出、
   版权归属清晰，但抽取时逐文件过一遍是否含外部贡献者的实质提交。
2. **镜像不是 canonical**：主仓 skills/plugins 镜像已有「手改镜像无效」绊倒人的教训，
   开源仓 README 顶部要放显眼的 sync 说明。

## 六、里程碑（草案）

- M0 脚手架 + 设计定稿（本文档）
- M1 本地总线 + claude↔claude 双会话互发（吃透默认 hold 问题）
- M2 codex 接入（原生 IPC 路径）
- M3 频道语义（N 方 + 人）、`upgrade` 引流通道
- M4 开源发布（README 头牌：Codex 原生 task 流接入）
