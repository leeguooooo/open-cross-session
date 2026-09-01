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

> ⏳ 盘点进行中，本节待补全。已确认的关键事实：

- 主仓已存在**两条纯本地零网络传输**：
  - Claude 侧：`cli/src/claude-inbox-inject.ts` — Unix socket
    （`/tmp/cc-socks/<pid>.sock`）按 PID 寻址注入活会话，JSONL 帧，
    ≤512B channel+seq 指针载荷。
  - Codex 侧：`cli/src/codex-desktop-ipc.ts`（#1012）— ChatGPT Desktop 私有 IPC
    注入活 task。
- 云端仅承担：消息总线、在线状态、回复欠账。
  → **本地版唯一要自研的核心 = 本地消息总线**，两端唤醒/注入代码可复用。
- ⚠️ 已知坑：Claude 收件箱注入 `ok:true` ≠ 已入对话；接收端默认 hold 进审核队列，
  5 分钟无人 Deliver 即静默丢弃且不回错。本地版必须正面解决默认 hold 策略。

## 四、架构（草案，待盘点补全后细化）

- 本地总线：替代云端三职责（消息、在线、欠账）的单机实现。
- 唤醒适配器：Claude（socket 注入 / `--resume` runner）、Codex（原生 IPC）。
- CLI 与 MCP 面：沿用 party 的使用习惯，命令集对齐，降低升级迁移成本。
- `upgrade` 通道：把本地频道迁到 agentparty.leeguoo.com。

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
