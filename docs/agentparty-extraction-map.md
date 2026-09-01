# AgentParty → 本地无服务器版：可抽取组件地图

Repo: `/Users/leo/github.com/agentparty`。全部路径相对该根目录。

**一句话结论前置**：仓库里已经存在**两条完全本地、零网络的传输**——Claude 侧的 `cc-socks` Unix 域套接字注入（`cli/src/claude-inbox-inject.ts`），和 Codex 侧 #1012 新加的 ChatGPT Desktop 私有 IPC（`cli/src/codex-desktop-ipc.ts`）。它们分别是"把消息塞进一个活着的 Claude 会话"和"把消息塞进一个活着的 ChatGPT task"的最后一公里，都不经过 Cloudflare。云端目前只承担"消息总线 + 谁在线 + 谁欠谁一条回复"这三件事。

---

## 1. Claude 侧唤醒链

实际上是**三条并列的载体**，不是一条链：

| 载体 | 入口 | 传输 |
|---|---|---|
| A 无头 runner | `party serve --runner claude` | WebSocket → spawn `claude -p --resume` |
| B 活会话 MCP Channel | `party claude` → 隐藏子命令 `party claude-channel` | MCP 子进程里的 WebSocket → `notifications/claude/channel` 注入宿主 Claude |
| C 收件箱注入 | serve 的帧循环 / claude-channel 的休眠腿 | **纯本地 Unix socket** `/tmp/cc-socks/<pid>.sock` |

### 载体 A：`party serve --runner claude` 端到端

**flag 解析**：`cli/src/commands/serve.ts:1688`（`SERVE_FLAGS`）、`:1704`（`--runner codex|claude|codex-sdk`）、`:1715`（`--runner-timeout-seconds`）。

**preflight（本地，无网络）**：开 socket 之前先做 harness 认证检查——Claude 走 `claude auth status --json`（`serve.ts:3128`），解析 `loggedIn`（`:2640`）。失败即 `EXIT_RUNNER_UNAVAILABLE` 短路（`serve.ts:5382`）。

**工作目录隔离**：`runnerWorkdir(root, channel, namespace)` 在 `serve.ts:1672`，默认 `~/.agentparty/runners/<sha256(principal)>/<channel>`（`:1685`）。namespace **必须**是权威 `/api/me` principal 的 sha256（`:1674`，理由 `:1664-1668`：两个身份服务同一频道时曾互相覆盖对方的 `wake-session.json`）。

**runner 循环是 WebSocket 消费者，不是轮询**：`serve.ts:5387` 调 `connect(o.server, o.token, o.channel, o.since, {...})`（`cli/src/client.ts:488`）。URL 在 `client.ts:509` 由 HTTP base 直接改写：

```
const wsUrl = httpBase.replace(/^http/, "ws") + `/api/channels/${slug}/ws`;
```

重连退避 1s→30s（`client.ts:495-496`），25s ping（`:497`），3×ping 的入站空闲看门狗（`:498`）。帧落入 `FrameQueue`，serve 串行消费。主帧循环在 `serve.ts:5760-6100`：`fresh = directedDelivery !== null || frame.seq > conn.cursor`（`:5781`）→ `passesFilter`（`:5794`）→ debt 闸（`:5804`）→ lease 闸（`:5827`）→ `qualifies`（`:5836`）→ 跑 runner。处理**严格串行**，`serve.ts:5860` 的注释明确：一次唤醒运行期间新帧在 `FrameQueue` 里缓冲。

serve 里唯一的 REST **轮询**是 `--profile` 项目 agent 的控制面：`basePollMs = opts.pollIntervalMs ?? 5000`（`serve.ts:4974`），退避到 5min（`:4975`），每轮调 `listInvites(...)`（`:4982`）。数据面从不轮询。

**Claude 在哪里被 spawn**：`runClaudeHarness`，`serve.ts:3026-3080`：
- 冷启动守卫 `serve.ts:3031`（`no preallocated cold session id`）
- 权限参数 `serve.ts:3046`：只读沙箱用 `--permission-mode plan`，否则 **`bypassPermissions`**（理由 `:3037-3042`：`claude -p` 没有 TTY，权限提示 = 进程挂死）
- 托管 MCP 参数 `serve.ts:3050-3056`：`--mcp-config <file> --strict-mcp-config --allowedTools mcp__party`，配置文件写进 0700 的 stateDir（`:1642`，`writeManagedClaudeMcpConfig`）
- 活动 hook `serve.ts:3058`：`--settings <claudeHookSettingsJson()>`——会话级 hook 管道写入 `AP_ACTIVITY_FILE`（生成器 `serve.ts:2892`）
- **argv** 在 `serve.ts:3061-3077`：
  - resume：`claude -p --disallowed-tools AskUserQuestion <perm> <schema> <json> <mcp> <hooks> --resume <sid> <prompt>`
  - cold：同上但用 `--session-id <coldSessionId> --output-format json <prompt>`
- spawn 本体：`runProcess(args, {cwd, env, signal})`（`serve.ts:3078`），基于 `Bun.spawn`（`serve.ts:2400` 附近），abort → SIGTERM → SIGKILL 进程组逐级升级（`serve.ts:1072`）

**prompt 传的是路径不是正文**：`wakePrompt(contextFile, ...)`（`serve.ts:878`，用在 `serve.ts:3735`）。完整帧 + charter + 最近约 20 条消息写进 0700 工作目录里的 JSON 文件（`writeContextFile`，`serve.ts:3727` 调用），正是为了防止正文经 `ps -axww` 泄露（注释 `serve.ts:3728-3734`）。

**交给子进程的 env**（`serve.ts:3632-3652`）：`AGENTPARTY_CHANNEL`、`AP_RUNNER_WORKDIR`、`AP_RUNNER_HARNESS`、`AP_ACTIVITY_FILE`（仅 claude，`:3647`）、`AP_RUNNER_SESSION_ID`（`:3648`），加各类 delivery id。

### `--resume` 与会话 id 持久化

唤醒路径上**全程不读** `~/.claude/projects/*.jsonl`。会话连续性靠 party 自己的注册文件。

**文件**：`RUNNER_SESSION_FILE = "wake-session.json"`（`serve.ts:990`），写在 runner 工作目录里，即 `~/.agentparty/runners/<sha256(principal)>/<channel>/wake-session.json`。定向投递时作用域挪到 `continuations/<ref>.json`（`cli/src/continuation.ts:17` `RUNNER_CONTINUATIONS_DIR`，路径构造 `continuation.ts:41`）。

**发现顺序**：
1. `prior = scopedSession(scope, path => readSession(path, harness), ...)`（`serve.ts:3630`）；`readSession`（`serve.ts:2417`）要求 `state.harness === harness`，所以 codex 的 id 永远不可能喂给 `claude --resume`。
2. 没有 prior 且 harness 是 claude 时，party **自己预分配 id**：`coldSessionId = randomUUID()`（`serve.ts:3631`）。理由 `serve.ts:3033-3035`：从 stdout 解析 id 太晚，因为嵌套的 `party decision ask` 必须在本轮返回**之前**就把确切 handle 持久化。所以 id 在本地生成，用 `--session-id` 传进去。
3. 本轮结束后：`parseClaudeJson(stdout)` 读 `body.session_id`（`serve.ts:2812-2815`）；`finalSid = sid ?? coldSessionId`（`serve.ts:3080`）。
4. 提交：`writeSession(sessionPath, { harness, session_id, created_at, last_wake_ts, wakes, cwd, workdir, ... })`（`serve.ts:3831-3839`），经 `mergeRunnerContinuation`（`continuation.ts:179`）在 O_EXCL 锁下（`continuation.ts:82`）做 tmp+rename 原子写（`continuation.ts:129`）。
5. 然后 `onSession(...)`（`serve.ts:3840`）→ `reportAgentSession`（`serve.ts:5427`）→ 在**已有的 WebSocket** 上 `conn.send({type:"heartbeat", agent_session})`——仅 presence 元数据，从不用于路由（`serve.ts:5425-5426`）。

**失效处理**：若 `--resume` 非零退出且输出匹配 `isInvalidPersistedSessionFailure`（`serve.ts:3765`），状态文件被 `rmSync`、`oldSid` 置空（`:3766-3776`）——但**当前这一次唤醒绝不冷重启**，因为被 resume 的进程可能已产生副作用。若在本轮中途关停，`blockRunnerContinuation(sessionPath, "...previous turn outcome unknown, refusing resume")`（`serve.ts:3757`，实现 `continuation.ts:211`）会永久毒化该作用域的 resume。

**若完全恢复不出 id**：记 `missing_session_id=true note=session_continuity_unavailable`（`serve.ts:3826`）并照常投递——损失一轮连续性，绝不静默丢消息。

### 载体 B：MCP Channel 通知（数据靠服务端，注入是本地）

`party claude`（`cli/src/commands/claude-launch.ts`）和 `party bridge claude`（`cli/src/commands/bridge.ts:876-898`）启动真正的 `claude` 二进制，带上：
- `--dangerously-load-development-channels plugin:agentparty@agentparty`（`claude-launch.ts:52`，`claudeChannelLoadArgs`）。`claude-launch.ts:29-49` 的长注释说明了为什么个人账号上光用 `--channels` 没用（managed-only 的 `allowedChannelPlugins` allowlist；`findChannelEntry` 用 `Array.find`，两个都传会输）。
- 一个指向隐藏子命令 `party claude-channel` 的 `--mcp-config`（`bridge.ts:883`）
- hook 命令 `party claude-cross-session-hook --gate-directory <0700 mkdtemp>`（`bridge.ts:846-855`，目录创建在 `bridge.ts:2272`）

在那个 MCP 子进程里（`cli/src/commands/claude-channel.ts`），唤醒动作是：`connect()` 一个 WebSocket 到同样的 `/api/channels/<slug>/ws`（import 在 `claude-channel.ts:36`）→ 命中合格帧时构造 `notificationFor(...)`（`claude-channel.ts:1255`）→ 发出 `notifications/claude/channel`（类型 `claude-channel.ts:1122`）。文件头 `claude-channel.ts:3-7` 是关键：

> 声明 `claude/channel` capability 并发出 `notifications/claude/channel`，会向**当前** Claude 会话注入一条排队输入。不要用普通的 MCP logging/resource 通知替代：#553 已证明那些唤不醒空闲的 harness。

即：**消息数据服务端绑死**，但"进入运行中会话"这一步是发给父进程的 stdio MCP 通知，零网络。

### 载体 C：UDS 收件箱注入（`claude-inbox-inject.ts`）——完全本地

这是最后一公里，**100% 文件系统 + Unix socket，完全不碰服务端**。

- 寻址：读 `~/.claude/sessions/<pid>.json`（覆盖 env `CLAUDE_NATIVE_SESSIONS_DIR_ENV`，`claude-inbox-inject.ts:48`；目录解析 `:70`）拿 `messagingSocketPath`、`sessionId`、`name`、`pid`。
- `resolveSessionSocketByPid(pid, {expectSessionId})`（`:201`）。按 **PID 寻址而非按名字**：注释 `:186-193` 解释 party 的 announce 名（`claude-<12hex>`）和 Claude 原生会话名（`agentparty-d4`）属于两个不相交的命名空间，按名查永远 `no-match`。PID 复用靠严格的 `sessionId` 相等来防（`:220-224`）。
- 可选鉴权：`readPeerToken` 读 `~/.claude/sessions/<pid>.<sha256(socketpath)>.key`（`:242-271`），拒绝符号链接／异 uid／超大文件。
- 探活：`probeSocketAlive`（`:273-296`）—— `net.connect`，等 `connect`，**一个字节都不写**就 `destroy`，让接收方只看到连接/断开而不物化任何用户消息。
- 写入：JSONL 帧，每行 ≤1 MiB（`CLAUDE_INBOX_MAX_LINE_BYTES`，`:50`），正文包在 `<cross-session-message>` 标签里（`CROSS_SESSION_TAG` `:60`；构造 `wrapCrossSessionMessage` `:313`，成帧 `buildInjectFrames` `:342`），然后 `end()`。

三条红线写在 `claude-inbox-inject.ts:8-14`：只对同机、ACL 授权的 socket 发；`from` 如实标为 `uds:<自己的 sock>`，绝不冒充别的会话；**绝不写入任何 Claude Code 的文件**——socket/目录/key 全是只读消费。

**载荷是 ≤512 字节的 channel+seq 指针，不是正文**：`wakeProxyNote(ref)`（`serve-wake-proxy.ts:81`），上限 `WAKE_PROXY_NOTE_MAX_BYTES`（`:45`）。被唤醒的会话自己回去读频道。

**调用方**：
- serve 帧循环 `serve.ts:5865-5888`，守卫条件 `fresh && !fromSelf && hasLease && !selfPaused && !mentionOwnedByDelivery && frame.mentions.length > 0`。`!mentionOwnedByDelivery`（`serve.ts:5851-5858`）防止同一 seq 既作为 `msg` 帧又作为 `delivery` 帧到达时双重注入。
- `attemptWakeProxy`（`serve-wake-proxy.ts:364`）；目标选择 `selectWakeProxyTarget`（`:120`）；从不抛异常（`:359`）。
- `socketWakeProxyForwarder`（`serve-wake-proxy.ts:313`），#856 起的默认载体，失败返回结构化 `{reason, detail}`（`:337`）。
- 还有 `claude-channel.ts:958-1001`（休眠 announce 腿），最多 3 次尝试、间隔 `injectRetryDelayMs`（默认 250ms，`:745`），配 `injectedSeqs` LRU 去重（`:769`, `:994`）。

⚠️ **必须知道的语义坑**，写在 `claude-inbox-inject.ts:24-36`：`ok:true` 只表示"JSONL 帧到达了收件箱 socket"，**不表示"进入了对话"**。接收端的 `crossSessionInbound` 闸默认 **hold** → 审核队列 → **5 分钟没人点 Deliver 就丢弃**，且不给发送方任何错误。所以 serve 绝不能用它来清 @ 欠账——它也确实没有：`serve.ts:5871` 的 `await attemptWakeProxy(...)` **故意丢弃返回值**（不变式声明在 `serve-wake-proxy.ts:304-308`）。

### 支撑性本地状态

- **会话注册表**：`claude-session-registry.ts`。文件在 `~/.agentparty/claude-sessions/<session_id>.json` 和 `~/.agentparty/codex-sessions/<...>.json`，目录 0700 / 文件 0600（头 `:8`）。**按 harness 分目录而非单目录加过滤**，是硬安全边界（`:9-13`）：`listClaudeSessions()`（`:345`）在结构上永远不可能返回 codex 条目，因为 codex 会话没有 cc-socks 收件箱。容量 128（`:47`），O_EXCL 注册锁（`:62`），liveness 用 `kill(pid,0)`（`:269`），读取时清扫死/坏行（`listSessions` `:310`）。匹配要求 **server 来源相同**（`:127`, `:147`——#865，频道 slug 跨实例不唯一）**且 channel identity 相同**（`:162`, `:173`——#906，同一 worktree 里两个会话绑不同 handle）。缺字段的老行永不匹配：fail-quiet，不 fail-wrong。
- **注册时机**在 Claude hook 里：`recordClaudeSessionLifecycle`（`cli/src/commands/hook.ts:846-890`）。`SessionStart` → `registerClaudeSession`（`hook.ts:872`），`SessionEnd` → `unregisterClaudeSession`（`hook.ts:865`）。`pid = process.ppid`（hook 子进程的父进程**就是** Claude）。serve 托管的通道用 `if (env.AP_ACTIVITY_FILE) return` 排除（`hook.ts:870`）。显示名通过 `nativeSessionName(pid, ...)`（`hook.ts:880`）读 `~/.claude/sessions/<pid>.json` 机会性升级。
- **跨会话闸**：`claude-cross-session-gate.ts`。一个私有 0700 mkdtemp 目录，放 `state.json` / `armed.json` / `consume.lock`（`:19-21`），TTL 5min state / 30s permit（`:15-16`）。`runClaudeCrossSessionHook`（`:921`）由 `SessionStart` / `PreToolUse` / `PostToolBatch` 驱动（`commands/claude-cross-session-hook.ts:26`），输入畸形或存储出错就 fail-closed 退 2（`claude-cross-session-hook.ts:47`, `:63`, `:79`）。它把 party 的 `party_channel_peers` 结果与 Claude 原生 `ListAgents`/`SendMessage` 做关联（`:52-55`），并拒绝给标记 Remote Control / cloud 的行发送 permit（`:43-50`）——关联刻意只做同机。
- **重复唤醒抑制**：`mention-wake-claim.ts`——每 `(channel,seq)` 一个 claim 文件放在 `mentionWakeClaimDir`（`:67`），`PROCESS_WAKE_RUNTIME_ID`（`:31`），最长 6 小时（`:34`）。另有 `claudeChannelSiblingDormancy`（`:250`）让同 cwd+identity 的第二个 Claude 进入休眠，除非 `AGENTPARTY_CLAUDE_CHANNEL_FORCE_ARM=1`（`:241`）。
- **可观测性**：`claude-armed-listener.ts:105` 的 `probeClaudeArmedListener` 读 serve 实例锁的持有者 pid，再对它 `ps`（`:53`），把命令分类为 `claude-channel` / `serve` / `unknown`（`:66`）。纯本地。`wake-reachability.ts` 是 *codex* 的对应物（Stop hook，`CODEX_STOP_HOOK_COMMAND = "hook codex-stop"` 在 `:28`），并明确声明其结论 `scope: "local"`（`:36-42`）。
- `mention-drain.ts` 是 REST 形状的：`collectPendingMentionSeqs`（`:36`）驱动 `next-mention` 端点（`NextMention` 来自 `rest.ts`，`:12`），再逐条从 `/messages` 拉正文。

### 标注

**可直接复用——零服务端依赖：**

| 模块 | 理由 |
|---|---|
| `claude-inbox-inject.ts`（全文） | 对 `~/.claude/sessions` 做 `readdirSync`/`readFileSync`，对 `/tmp/cc-socks/<pid>.sock` 做 `net.connect`。不 import `rest.ts` 或 `client.ts` |
| `claude-session-registry.ts` | `~/.agentparty/{claude,codex}-sessions/`、`kill(pid,0)`、O_EXCL 锁。只有 `resolveSessionRegistryIdentity`（`:408`）碰 config，也只是本地文件读 |
| `claude-cross-session-gate.ts` | mkdtemp 闸目录 + JSON + O_EXCL 锁，解析 hook stdin |
| `commands/claude-cross-session-hook.ts` | stdin → 闸 → 退出码 |
| `claude-native-format.ts` | `locateClaudeBinary`（`:32`）+ `readClaudeNativeCrossSessionFormat`（`:72`）——读已装的 `claude` bundle 推导严格正则（`:123`）。只读的二进制自省 |
| `claude-armed-listener.ts` | 锁文件 + `ps` + registry |
| `wake-reachability.ts` | `~/.codex/hooks.json` + `~/.agentparty/agents`，自标 `scope:"local"` |
| `mention-wake-claim.ts` | `~/.agentparty` 下的 claim 文件 |
| `continuation.ts` | runner 工作目录下的原子 JSON |
| `serve-wake-proxy.ts` 全部导出：`wakeProxyNote`(`:81`)、`selectWakeProxyTarget`(`:120`)、`injectFromName`(`:149`)、`senderInjectFromName`(`:199`)、`resolveLocalIdentity`(`:237`)、`socketWakeProxyForwarder`(`:313`)、`attemptWakeProxy`(`:364`) | `ref.server` **只**用作匹配 registry 行的字符串，从不拨号 |
| Claude argv 构造 `serve.ts:3026-3080`、`claudeHookSettingsJson`(`:2892`)、`writeManagedClaudeMcpConfig`(`:1642`)、`runnerWorkdir`(`:1672`) | 纯 argv/文件/spawn。注意 `runnerWorkdir` **要求**一个 sha256 namespace（`:1674`），本地版需自行提供 |
| `claude-launch.ts` 的 flag 组装：`claudeChannelLoadArgs`(`:52`)、`mergeClaudeArgs`、`spawnSync("claude", ...)`(`:202`) | 本地进程启动 |

**需改造——核心是本地的，但当前与服务端输入纠缠：**

- **`commands/claude-channel.ts`**。注入那一半是本地的（`notificationFor` `:1255`、`notifications/claude/channel` 发射、`inject(...)` `:958`），但整个类围绕 `BridgeConnection`（`:1141`）和定向投递状态机（`delivery_update` / `delivery_state` / `delivery_recover` 帧，`:1644-1743`, `:2078-2202`）构建。本地跑需要替一个假的 `BridgeConnection` 并 stub 掉 delivery ACK 路径——代码里明确指出全文通知**没有**消费确认（`:1671`），那套持久化逻辑存在的唯一原因就是 Worker 是真值源。
- **serve 帧循环**（`serve.ts:5760-6100`）。filter/debt/lease/proxy 逻辑很好，但它吃 `ServerFrame`，正确性建立在 `conn.cursor` + `conn.ack()` + 服务端租约之上。本地复用意味着喂合成帧。
- **`mention-drain.ts`**。纯函数（`collectPendingMentionSeqs` `:36`、格式化 `:65-95`）可复用，但注入的 `DrainMentionsSource.nextMention`（`:20`）是 `/next-mention` REST 端点。
- **serve preflight `claude auth status --json`**（`serve.ts:3128`）——本地动作，但接进了 `EXIT_RUNNER_UNAVAILABLE` 和频道侧的 `runner_health` 上报。

**服务端绑死（Cloudflare Worker）：**

- `connect()`（`client.ts:488`），WebSocket `…/api/channels/<slug>/ws`（`client.ts:509`）。这是载体 A 和 B **唯一**的新消息传输。
- `serve.ts:63` 从 `rest.ts` import 的全部：`fetchMe`、`fetchMessages`、`fetchRecentMessages`、`fetchChannelCharter`、`fetchServerVersion`、`postMessage`、`uploadAttachment`、`downloadAttachment`、`listProjectAgentInvites`、`mintProjectAgentRuntimeToken`、`ensureProjectAgentChannelRuntime`。
- 每轮的 `postMessage` 唤醒 ACK（`serve.ts:3714-3722`，`state:"working"`，`wake ack: …`）。
- 带 `agent_session` 的 `reportAgentSession` 心跳（`serve.ts:5443`）。
- 项目 agent 邀请轮询循环（`serve.ts:4974-5028`）。
- 所有出现 `directedDelivery`、`hasLease`、`conn.ack()` 的定向投递/租约仲裁。
- `runnerWorkdir` 的 namespace，按契约必须是 `/api/me` principal 的 sha256（`serve.ts:1679-1685`）。

**本地版的干净接缝**：载体 C 完全自包含。`attemptWakeProxy` + `socketWakeProxyForwarder` + `injectChannelMessage` + `listClaudeSessions` 就能唤醒本机任一活着的交互式 Claude，只需要有东西负责注册会话（`hook.ts:872` 的 SessionStart hook），并且接受 `claude-inbox-inject.ts:24-36` 的默认 hold 语义。

---

## 2. Codex 侧唤醒链

### 五个必要条件

规范枚举在 `cli/src/wake-checklist.ts:62-111`（`buildWakeChecklist`），渲染恰好四行，外加一个运行时强制但**故意不作为 checklist 行显示**的第五闸（session kind）。按从上游到下游排序：

**（0，最上游）hook 信任闸 — codex ≥ 0.149。** `~/.codex/hooks.json` 里列的 hook，只有当 `config.toml` 存在 `[hooks.state."<hooksPath>:<event>:<group>:<index>"] enabled = true` 时才会运行。未批准时 codex **静默跳过，零报错**。
- 版本阈值 + 证据：`codex-trust-gate.ts:44`（`CODEX_TRUST_GATE_MIN_VERSION`）、`codex-trust-gate.ts:52`（`CODEX_TRUST_GATE_EVIDENCE`），三态判定 `codexVersionHasTrustGate` 在 `codex-trust-gate.ts:78`。
- 本机哪个二进制带这个闸：`discoverCodexBinaries`（`codex-trust-gate.ts:274`）、`probeCodexTrustGate`（`codex-trust-gate.ts:414`）。
- 信任表读取/分类：`codexTrustTable`（`codex-hook-trust.ts:79`）、`trustStateOf`（`codex-hook-trust.ts:85`，四态 `enabled|disabled|unknown|absent`）、`findCodexOwnHooks`（`codex-hook-trust.ts:170`）、key 公式（`codex-hook-trust.ts:186`）。
- checklist 用的状态：`codexStopHookStatus`（`wake-diagnosis.ts:96`，key 推导 `codexStopHookTrustKey` 在 `wake-diagnosis.ts:73`）；若整个 `[hooks.state]` 表缺失，视为 pre-0.149 并返回 ok（`wake-diagnosis.ts:114-123`）——刻意不误报。
- 修复（外科式逐行写入 `enabled = true`，再重解析并比对差异）：`enableCodexHookTrust`（`codex-hook-trust.ts:262`），校验器 `onlyIntendedTrustFlagsChanged`（`codex-hook-trust.ts:339`），兜底"照这段贴"的 `codexTrustTomlSnippet`（`codex-hook-trust.ts:373`）。**绝不使用** `--dangerously-bypass-hook-trust`（明示硬边界，`codex-hook-trust.ts:22`、`codex-trust-gate.ts:31`）。
- checklist 行：`wake-checklist.ts:96-105`（`id: "hook_trusted"`），补救分支 `wake-checklist.ts:134-143` → `codexTrustApprovalGuidance`（`codex-trust-gate.ts:509`，三个分支 A/B/C：我们帮你翻开关 / codex TUI 仍会再问一次 / 打印 TOML 让你自己贴）。

**（1）cwd 已绑定到频道。** `wake-checklist.ts:78-83`（`channel_bound`）；运行时读取 `commands/hook.ts:1279`（`env.AGENTPARTY_CHANNEL ?? readState(cwd)?.channel`），廉价闸 `codexStopWakeGate`（`codex-stop-wake.ts:311-321`）。

**（2）该会话能解析出唯一身份。** `wake-checklist.ts:84-89`（`identity_resolved`）；实现 `resolveCodexHookIdentity`（`codex-session-identity.ts:212+`），五级优先级文档在 `codex-session-identity.ts:18-36`（env `AGENTPARTY_CONFIG` → join-binding → session-registry 按 `session_id` → **mcp 注册** → cwd 唯一）。铁律"绝不猜"（`codex-session-identity.ts:11`）。接进 Stop hook 在 `commands/hook.ts:1245-1273`。

**（3）Stop hook 已装进 hooks.json。** `wake-checklist.ts:90-95`（`hook_installed`）；安装器在 `commands/hook.ts:466-469` 同时写两个条目，用 `codexOwnHookCommand`（`codex-hook-trust.ts:151`），路径 `codexHooksJsonPath`（`wake-diagnosis.ts:65`）。

**（4）会话必须是交互式 codex，且非续跑。** 两个子闸：
- `stop_hook_active !== false ⇒ skip`——防无限 re-block 的唯一硬帽（`codex-stop-wake.ts:315`，理由 `codex-stop-wake.ts:30-38`）。
- session-kind 探测：`probeCodexSessionKind`（`codex-session-kind.ts:368`），先读 rollout 头（`readCodexRolloutMeta`，`codex-session-kind.ts:314`），再看进程形状（`codex-session-kind.ts:394`）；`non-interactive ⇒ return` 在 `commands/hook.ts:1386-1390`，SessionStart/auto-wake 侧则是 `decideCodexAutoWake`（`codex-auto-wake.ts:404-421`，连 `unknown` 也拒绝）。`codex exec` 根本不触发任何 hook——`wake-checklist.ts:52`（`CODEX_EXEC_NO_HOOKS_NOTE`）。

外加操作者总开关 `AGENTPARTY_CODEX_AUTO_WAKE=off` / `codex-auto-wake.json`，两层共用：`resolveCodexAutoWakeMode`（`codex-auto-wake.ts:120`），在 `commands/hook.ts:1281` 和 `codex-auto-wake.ts:384-392` 被查询。

**为什么 MCP 是检测支点**：MCP server 住在 `config.toml` 的 `mcp_servers` 表（`codex-mcp-registry.ts:91-129`），**完全不受 `[hooks.state]` 管辖**。所以 hook 全禁时，唯一还活着的"这个 codex 进程属于哪个 AgentParty 身份"的证据，就是 `party mcp` 子进程及其 `AGENTPARTY_CONFIG` 环境变量，由 `codexMcpConfigPaths`（`codex-session-identity.ts:646`）用 `ps -axo pid=,ppid=,args=` 再 `ps eww` 采集。这就是身份解析的第 4 级（`codex-session-identity.ts:479`, `:498`）。但 **MCP 自己不能唤醒**：`codex-auto-wake.ts:6-11` 记录了反证——codex 0.145 的 `initialize` 只声明 `elicitation` 不声明 `sampling`，对空闲会话发 `elicitation/create` 会在约 23ms 内被自动拒绝。

### `codex-sessions.ts` 是什么

纯本地文件系统发现 **Codex rollout JSONL 文件**——和 AgentParty 自己的 registry 毫无关系。它读 `$CODEX_HOME/sessions` 否则 `~/.codex/sessions`（`codexSessionsRoot`，`codex-sessions.ts:44`），走固定的 `YYYY/MM/DD` 树，匹配 `rollout-<local-ts>-<uuid>.jsonl`（`ROLLOUT_NAME_RE`，`codex-sessions.ts:17`；文件名里的 UUID **就是** `codex resume` 接受的 thread id）。每个文件只读有界的前 512 KiB（`CODEX_ROLLOUT_HEAD_BYTES`，`codex-sessions.ts:14`；`readHead`，`codex-sessions.ts:114`），取出 `session_meta`（cwd / originator / source / git.branch）加第一条 `event_msg` 类型 `user_message` 当标签（`summarizeCodexRolloutHead`，`codex-sessions.ts:139`）。

导出：`CODEX_ROLLOUT_HEAD_BYTES:14`、`isCodexThreadId:39`、`codexSessionsRoot:44`、`parseCodexRolloutFileName:52`、`listCodexRolloutFiles:86`、`summarizeCodexRolloutHead:139`、`listCodexSessions:201`、`latestCodexSession:230`、`formatCodexSessionLine:236`，类型 `CodexSessionSummary:26` / `ListCodexSessionsOptions:194`。

消费方只有两个：`commands/bridge.ts:59-65` 服务于 `party bridge codex --resume/--resume-last`（`commands/bridge.ts:1751`, `:1773-1789`，thread-id 校验 `:1925-1929`），以及 `codex-session-kind.ts:38` 复用 `listCodexRolloutFiles`/`codexSessionsRoot` 按 `session_id` 定位*本*会话的 rollout 头（`locateCodexRolloutMeta`，`codex-session-kind.ts:324`）。

⚠️ **注意命名撞车**：`codex-session-identity.ts:50` import 的是一个**不同的** `listCodexSessions`，来自 `claude-session-registry.ts`——那个读的是 AgentParty 自己的 `~/.agentparty/codex-sessions/` 注册表（目录名在 `claude-session-registry.ts:43`，由 `hook codex-report` 写入，见 `commands/hook.ts:145`, `:577`）。

### 唤醒实际怎么到达 Codex 会话——三条不同的路

**路径 A — Stop hook（前台，主路径）。** hook 事件是 **`Stop`**，不是 SessionStart。安装为 `party hook codex-stop`（`commands/hook.ts:469`，超时 10s）。流程：`runCodexStopHookInput`（`commands/hook.ts:1500`）→ `handleCodexStopRecord`（`commands/hook.ts:1361`）。若 `AP_ACTIVITY_FILE` 已设则退出（那是 serve 托管 runner，`commands/hook.ts:1373`），跑廉价闸（`:1380`）、session-kind 闸（`:1386`），然后算 `since = max(cursor, live seen)`（`codexStopWakeQuerySince`，`codex-stop-wake.ts:245`；`commands/hook.ts:1397`），先试本地 StuckWake 快路径（`:1400`），否则问服务端（`:1404`）。决策：`decideCodexStopWake`（`codex-stop-wake.ts:337`）。若决定唤醒，**先写 seen 记录再打印**（`commands/hook.ts:1470`），然后只输出一行：`{"decision":"block","reason":...}`（`commands/hook.ts:1471-1474`）。

契约写在 `codex-stop-wake.ts:17-22`：`stop.command.output` 是 `additionalProperties:false` 且**没有 `prompt` 字段**——所以 **`reason` 本身就是被注入的 prompt**，上限 512 字节（`CODEX_STOP_WAKE_REASON_MAX_BYTES`，`codex-stop-wake.ts:79`；文本构造 `codexStopWakeReason`，`codex-stop-wake.ts:281`）。prompt 只携带 channel+seq 指针加一条身份钉死的命令（`codexStopWakeScopedPartyCommand`，`codex-stop-wake.ts:126`，用 `--config-b64`）；正文永远回频道重读。防循环全靠我们自己（codex 不给 block 循环封顶——`codex-stop-wake.ts:35`）：`stop_hook_active`、一个带 TTL 的持久化 seen 集（`codex-stop-wake.ts:49-63`，`recordCodexStopWakeSeen:270`），以及处处 fail-open。

兄弟 hook `party hook codex-report` 是 `SessionStart`（`commands/hook.ts:466`）：把会话登记进 `~/.agentparty/codex-sessions/`，并可能拉起唤醒层——`handleCodexHookRecord`（`commands/hook.ts:895+`）、`maybeStartCodexAutoWake`（`commands/hook.ts:1192`）、决策 `decideCodexAutoWake`（`codex-auto-wake.ts:382`），后者 spawn `party hook codex-autowake --supervise --channel C`（参数在 `codex-auto-wake.ts:497`）。

**路径 B — app-server bridge（`party bridge codex`）。** 这个进程 spawn `codex app-server --stdio`（`commands/codex-bridge.ts:406`），独占唯一的控制连接，再通过一个私有 0600 Unix socket 把它转给真正的 TUI（`CodexUnixJsonRpcProxy`，`codex-app-server-bridge.ts:2516`）。TUI 输入和 AgentParty 投递都汇入单写者 `CodexTurnArbiter`（原因在 `codex-turn-arbiter.ts:1-9`：`turn/start` 会打断当前活动任务）。投递账本是 `CodexAgentPartyBridge`（`codex-app-server-bridge.ts:3114`）；一条入站 `MsgFrame` 由 `codexInput`（`codex-app-server-bridge.ts:3032`）变成一个 codex turn，只有**turn 完成且关联的 REST 回帖落地**才算结清（`codex-app-server-bridge.ts:3103-3108`）。有未结投递时拒绝切换 thread / 改历史（`codex-app-server-bridge.ts:3140-3157`）。resume 走 `thread/resume`，用来自 `codex-sessions.ts` 的 rollout thread id（`commands/codex-bridge.ts:852-880`）。

**路径 C — ChatGPT Desktop 原生 bridge（`party bridge codex-native`）。** 不启第二个 app-server：直接跟 ChatGPT.app 自己的 0600 IPC 路由器对话（`CodexDesktopIpcClient`，来自 `codex-desktop-ipc.ts`，import 在 `commands/codex-native-bridge.ts:33`），找到拥有目标 task 的 renderer，通过 `thread-follower-start-turn` + `codex_app` toolOutput 投进*已经可见的* task（`codex-auto-wake.ts:12-14`）。`CodexNativeSessionController`（`codex-native-session.ts:41`）实现了与 app-server 路径相同的 `CodexAgentPartySession` 契约（`codex-app-server-bridge.ts:3000`），所以复用同一个 `CodexAgentPartyBridge` 账本（`commands/codex-native-bridge.ts:8-9`）。需要同一身份下的两个 task；否则 auto-wake 拒绝静默降级到后台 runner（`codex-auto-wake.ts:437-446`，`native-source-missing`）。

**MCP 不是唤醒路径**——见前文。它只是注册/身份证据。

### 标注

**纯本地文件系统/进程/socket，可直接复用：**
- `codex-sessions.ts` —— 只有文件系统，零网络。可原样复用。
- `codex-session-kind.ts` —— rollout 头读取 + `ps` 祖先链。可复用。
- `codex-hook-trust.ts` —— 对 hooks.json/config.toml 文本的纯函数，唯一 I/O 在调用方。可复用。
- `codex-trust-gate.ts` —— `ps`、readdir、`spawnSync <bin> --version`，加 `agentpartyHome()` 下的本地 JSON 版本缓存（`codex-trust-gate.ts:374-397`）。可复用；形状偏 macOS/`.app`（`appRoots`，`codex-trust-gate.ts:269`），Windows 下降级。
- `codex-mcp-registry.ts` —— TOML 读取 + `codex mcp remove` 子进程。可复用。
- `codex-turn-arbiter.ts` —— 基于注入式 `CodexTurnTransport`（`codex-turn-arbiter.ts:33`）的纯协议状态机。完全可复用，无 I/O。
- `codex-desktop-ipc.ts` / `codex-native-session.ts` —— 对 ChatGPT.app 的本地 Unix socket IPC。可复用，但与宿主版本耦合。
- `codex-stop-wake.ts` —— **纯决策 + 本地 seen 文件**逻辑。可原样复用；唯一的服务端依赖是*注入的*（`pending` 可以来自本地 StuckWake，`codex-stop-wake.ts:69-74`）。

**Worker/REST 绑死：**
- Stop hook 的慢路径：`fetchNextMention` → `GET /api/channels/:slug/next-mention?since=`（`rest.ts:1151-1160`），从 `commands/hook.ts:1300-1313` 调用，带 3 秒 `AbortSignal.timeout`（`CODEX_STOP_WAKE_QUERY_TIMEOUT_MS`，`codex-stop-wake.ts:95`）。这是路径 A 唯一必需的网络跳，也是"没人在跑 serve"时的主路径（`codex-stop-wake.ts:44-48`）。
- 语言解析 `resolveWakeLang`（`commands/hook.ts:1320-1341`）——可选的额外历史拉取，同一预算。
- `CodexAgentPartyBridge` —— 结构上就是服务端绑死：它经 `client.ts` 的 WebSocket 消费来自 `@agentparty/shared` 的 `ServerFrame`/`MsgFrame`/`DirectedDelivery`，并经 `rest.ts` 的 `postMessage` 回帖（`commands/codex-native-bridge.ts:10,30`；选项在 `codex-app-server-bridge.ts:2971-2993`）。lease/CAS 投递恢复协议（`requireDeliveryRecovery`，`codex-app-server-bridge.ts:2988`）假定 Worker 侧的 Durable Object 语义。
- `codex-auto-wake.ts` —— 决策函数是纯的（**可复用**），但 `codexAutoWakeAuth`/`codexAutoWakeTarget`（`codex-auto-wake.ts:493`, `:502`）一切按 `server`+`token` 取键，而且它 spawn 的东西（`party serve`/native bridge）是 Worker 客户端。本地纯跑**需改造**。

**需改造：**
- `codex-session-identity.ts` —— 逻辑是本地的（`ps`、config 文件、join-binding），但身份 key 是 `server + name`（`identityKey`，`codex-session-identity.ts:156`），且 `usableConfig`（`:165`）拒绝任何没有 `token` 和可修复 server URL 的 config。本地传输需要一个替代的身份 key。
- `commands/hook.ts` 的 `defaultCodexStopWakeDeps`（`:1236`）—— 把 `nextMention` 换成本地队列读取，路径 A 其余部分立刻能离线跑；`stuck`/`cursor` 本来就读本地状态（`loadStuck`/`loadCursor`，`commands/hook.ts:1291-1315`）。
- `commands/codex-bridge.ts` / `commands/codex-native-bridge.ts` —— app-server/IPC 管道是本地的，但两者都包着 `connect()` + `postMessage` + 实例锁；投递账本需要重新指向。

---

## 3. #1012「接入 ChatGPT 原生跨任务通信」——这就是纯本地通道

commit `33ffdeb`，25 文件 +3026 行 -111 行。核心新增 `cli/src/codex-desktop-ipc.ts`（+614）、`codex-native-session.ts`（+268）、`commands/codex-native-bridge.ts`（+204）。

**机制**（文件头 `codex-desktop-ipc.ts:1-8` 说得很清楚）：ChatGPT Desktop 自己拥有一个私有的 **0600 Unix socket**，位于 `$CODEX_HOME/ipc/ipc.sock`（默认 `~/.codex/ipc/ipc.sock`，路径解析 `codexDesktopIpcSocketPath` 在 `:61`）。这是 ChatGPT.app 用来在自己多个窗口/thread 之间做 follower 同步的通道。party 做的是：

1. **严格校验 socket 私有性**（`validateCodexDesktopIpcSocket`，`:68-88`）——必须是 socket、父目录是目录、uid 是自己、mode 的 group/other 位全零，否则抛 `CodexDesktopIpcUnavailableError`。
2. `initialize` 拿到 `clientId`（`:251-256`），初始值是哨兵 `INITIALIZING_CLIENT_ID`（`:219`）。
3. `discoverThreadOwner(threadId, hostId = "local")`（`:259`）找出**哪个 renderer 进程拥有目标 thread**。
4. 调用 ChatGPT **自己跨窗口用的同一个方法** `thread-follower-start-turn`（`:289-308`），把消息作为一个 `codex_app` namespace 下 `send_message_to_thread` 的 **toolOutput** 注入（`:299-301`），这样 UI 里保留原生的跨任务标签和来源链接，而不用去碰私有的 app-tools 管道。请求带 `targetClientId: ownerClientId` 和 `startTurnTimeoutMs`（默认 30s，`:234`）。
5. 回复关联：`:355-358` 通过匹配 `toolOutput.name === "send_message_to_thread"` + `namespace === "codex_app"` + `output === expectedOutput` 来识别并保存 linked reply。

传输是 **length-prefixed JSON 帧**，上限 `MAX_IPC_FRAME_BYTES = 64 MiB`（`:20`），每个请求带 `sourceClientId`（`:385`, `:426`）；超时/失败时对 `thread-follower-start-turn` 特殊处理，若帧已写出则抛 `CodexDesktopIpcUnknownOutcomeError` 而非普通失败（`:395`, `:542`）——即"不知道到底送没送到"是一个独立的一等错误类型。

路由选择 `selectCodexDesktopIpcRoute(targetThreadId, appServerPid, sessions)`（`:98`）要求 source 和 target 两个 thread **同 pid、同 channel、同 server、同 identity**，且 source 取的是反向查找里最后一个非目标会话。即需要同一身份下的两个 task 才能用；否则 `codex-auto-wake.ts:437-446` 报 `native-source-missing` 而**拒绝静默降级**到后台 runner。

commit message 里列的补齐项：身份失败关闭、WAL 回滚、畸形帧断连、不可信 patch 防护，以及跨任务回归测试（新增 `cli/test/codex-desktop-ipc.test.ts` 322 行、`codex-native-session.test.ts` 197 行等）。

`CodexNativeSessionController`（`codex-native-session.ts:41`）实现了和 app-server 路径**同一个** `CodexAgentPartySession` 接口（定义在 `codex-app-server-bridge.ts:3000`），内部用一个 promise lane 串行化（`:52`），并维护 `turnsByClientId` / `uncertainClientIds` 两个映射来跟踪不确定结果。所以复用同一套投递账本。

**标注：可直接复用（本地版的核心资产）**。`codex-desktop-ipc.ts` + `codex-native-session.ts` 零网络。唯一的服务端耦合在外层 `commands/codex-native-bridge.ts:10-33`——它 import 了 `connect`、`postMessage`、`resolveAuthDetailed`、`buildRuntimeTopology`、`DeliveryRecoveryJournal`、`acquireInstanceLock`。把这层换掉，IPC 本身原封不动可用。

**风险**：它依赖 ChatGPT.app 的私有 IPC 协议（方法名、clientId 握手、toolOutput 形状），宿主版本升级会破。

---

## 4. `scripts/verify-agentparty-claude-cross-session.ts` 验的是什么链路

2068 行，验的是**两个真实 Claude 进程在同一台机器上通过 AgentParty 完成一个来回**的完整 E2E，不是 mock。

`AgentPartyCrossSessionEvidence`（`:109-132`）有 **21 个布尔字段**，构成一条严格有序的证据链，读它就等于读拓扑：

```
receiver_session_start_armed / sender_session_start_armed
→ distinct_claude_session_ids
→ distinct_bridge_addresses
→ receiver_initialized_with_agentparty_mcp
→ sender_used_party_channel_peers
→ sender_received_expected_ready_hint
→ sender_used_list_agents_after_hint
→ sender_rechecked_exact_candidate_before_send
→ sender_used_send_message_to_hint_with_marker
→ sender_send_message_result_observed
→ receiver_observed_marker
→ receiver_wait_boundary_before_marker
→ receiver_used_party_channel_peers_for_reply
→ receiver_received_expected_sender_hint
→ receiver_used_list_agents_after_hint_for_reply
→ receiver_rechecked_exact_candidate_before_reply
→ receiver_used_send_message_to_sender_with_reply_marker
→ receiver_reply_send_message_result_observed
→ sender_observed_reply_marker
→ sender_wait_boundary_before_reply_marker
```

**这条链说明的拓扑**：发现（`party_channel_peers`，走服务端）和投递（Claude 原生 `ListAgents` / `SendMessage`，纯本地）是**两个不同的面**。服务端只提供"谁在你旁边"的提示（ready hint），真正的送达用 Claude 自己的 cross-session 通道。`_rechecked_exact_candidate_before_send` 这一步存在，正是因为 hint 可能过期——发送前必须重新确认。`_wait_boundary_before_marker` 则要求确认接收方是在一个真正的工具边界之后才看到 marker，防止把回放当成实时。

`readyHint`（`:694`）校验的 payload 结构值得整段抄：`version:2`、`availability:"ready"`、`topology_evidence:"client_asserted"`、`self === expectedSenderAgent`、`channel` 匹配、`peers` 数组；每个 peer 要 `agent === expectedReceiverAgent` 且 `same_identity === false`；每个 `claude_sessions` 条目要有 `display_name`、`candidate_ref`（正则 `^candidate_[A-Za-z0-9_-]{16,64}$`）、`relation === expectedRelation`、`runtime_count === 1`、`name_unique_among_hints === true`、`pre_send_check_required === true`、`coordination.action === TOPOLOGY_COORDINATION_ACTION[expectedRelation]`。最后要求恰好命中 1 个 session，否则返回 null。

blocker 类型分三层：
- `IntegrationPreflightFailureCode`（`:147`）——参数/环境级：`invalid_arguments`、`invalid_channel`、`receiver_config_invalid`、`sender_config_invalid`、`receiver_cwd_invalid`、`sender_cwd_invalid`、`server_configuration_invalid`、`server_mismatch`、`agent_token_conflict`、`unsupported_platform`、`claude_unavailable`、`claude_version_unsupported`、`runtime_topology_unavailable`、`internal_error`。
- `IntegrationAgentPartyBlocker`（`:163`）——身份/频道级：`{receiver,sender}_agentparty_auth_required`、`{receiver,sender}_identity_unavailable`、`{receiver,sender}_identity_invalid`、`{receiver,sender}_channel_unavailable`、`agent_identity_conflict`。
- `IntegrationPreflightStatus`（`:133`）——总状态：`ready`、`plugin_lifecycle_unavailable`、`claude_auth_required`、`claude_auth_unavailable`、`unsupported_provider`、`feature_flag_evaluation_disabled`、`agentparty_unavailable`、`worker_upgrade_required`、`runtime_peer_unavailable`、`invalid_request`、`environment_unavailable`、`internal_error`。

**注意 `worker_upgrade_required` 和 `runtime_peer_unavailable` 是纯服务端 blocker——本地版直接消失**，`worker_deployment_unavailable` 同理（`:436`）。

`integrationTopologyRelation`（`:681`）是可以整段抄走的三级判定：
```
left.worktree_ref === right.worktree_ref  → "same_worktree"
: left.workspace_ref === right.workspace_ref → "same_workspace"
: left.node_ref === right.node_ref → "same_local_installation"
: null
```

**标注：需改造，但这是最好的验收模板**。去掉 `worker_deployment` / `runtime_peer` 两类 blocker，其余 21 条证据在本地版一条不少——反而更容易全部满足，因为不再有网络时序。

---

## 5. 协议层

`shared/src/protocol.ts`，2614 行。另有 `shared/src/identity.ts`(94)、`mentions.ts`(300)、`onboarding.ts`(165)。

### 纯数据结构，可直接复用

- **`MsgFrame`（`:1882`）**——`type / seq / sender / kind / body / mentions / reply_to / state / note / status / ts` 是干净的消息模型。几处设计注释非常值钱：
  - `replay?: true` —— hello 补拉（历史重放）标记（#861）。服务端只在 `hello.since/since_rev` 补拉循环里打上，live 广播永不携带。客户端据此把"重放的老消息"和"真的新消息"分开——否则重连时一条 10 天前的 @ 会以 live 帧身份触发系统通知。
  - `superseded?: SupersededMark` —— "这条内容已被后续消息取代"（#881）。与 `replay` **正交**，可同时为真：replay 是传输事实，superseded 是内容事实。**定序依据仍然只有 `seq`**（频道全局单调）——注释明确写道刻意**不按 `ts` 排序或判定新旧**，因为 ts 是发送端本地时钟，同机多 runner / 跨机漂移下比 seq 更不可信，#881 明确否掉了那个方案。本地版同机多进程，这个结论**直接适用**。
  - `SupersededReason`（`:1948` 附近）只收两种可证明的关系：`revision`（显式 `supersedes`/`superseded_by` 链）和 `reply_correction`（同一 sender 用 `--reply-to` 回到这条、且再次 @ 同一目标、且该目标的 directed delivery 当时仍未结清）。刻意**不含**"同 sender 同 @ 目标的任意后续消息"——那会把「做 X」「再做 Y」两条独立指令中的前一条误标成过期，把有效指令降级掉，比不标更危险。
  - 其他可选字段：`workflow_ref`、`role`/`role_source`、`completion_artifact`/`completion_review`、`decision_request`/`decision_resolution`/`decision_response`、`attachments`、`response_source`、`receipts`、`edited*`/`retracted*`/`supersedes`/`superseded_by`/`rev_seq`/`revision`。
- **`extractMentionTokens`（`:47`）**，以及全部枚举（`:190-228`）：`SenderKind`、`TokenRole`、`ChannelKind`、`ChannelMode`、`MessageKind`、`WebhookFilter`、`CaptureKind`、`TaskState`、`TaskAssigneeKind`、`StatusState`、`PresenceState`、`CollaborationRole`/`CollaborationRoleSource`、`Residency`、`WakeKind`、`HostDecisionKind`、`WorkflowKind`、`CompletionGate`、`DecisionMode`/`DecisionKind`/`DecisionState`、`DirectedDeliveryState`/`DirectedDeliveryCause`。
- **各类 limit 常量**：`BODY_LIMIT = 100_000`（`:12`）、`CHARTER_LIMIT`（`:13`）、`RATE_LIMIT_PER_MIN`（`:14`）、`LOOP_GUARD_*`（`:15-19`）、`RETAIN_N`（`:20`）、`IDEMPOTENCY_*`（`:22-27`）、`MAX_MENTIONS = 50`（`:40`）、`RESERVED_NAMES`（`:39`）。
- **退出码**（`:160-186`）：`EXIT_TIMEOUT=2`、`EXIT_AUTH=3`、`EXIT_LOOP_GUARD=4`、`EXIT_ARCHIVED=5`、`EXIT_STREAM_ENDED=6`、`EXIT_UPGRADED=7`、`EXIT_WORKFLOW_GUARD=8`、`EXIT_RATE_LIMITED=9`、`EXIT_UNREACHABLE=10`、`EXIT_TASK_LEASE_HELD=11`。
- **`AgentContext`（`:333`）、`WakeDelivery`（`:353`）、`CaptureRecord`（`:368`）、`TaskRecord`（`:386`)**——纯记录类型。
- **`RuntimeTopology`（`:726`）+ `cli/src/runtime-topology.ts` 整个文件——本地版的隐藏宝石。**
  - 结构：`{version:1, node_ref, runtime_ref, workspace_ref, worktree_ref, peer_scope:"local_installation", evidence:"client_asserted", harness_session?:{harness:"claude"|"codex", display_name}}`。
  - 实现：`loadOrCreateNodeSecret` 在 `~/.agentparty/node-secret` 维护一个 32 字节随机 hex（0600，O_EXCL 创建，读取时校验 mode/uid/size/正则）；`opaqueRef` 用 HMAC-SHA256（key = 该 secret）对 `agentparty-runtime-topology-v1\0<server>\0<prefix>\0<value>` 求摘要取 base64url 前 24 字符。
  - `buildRuntimeTopology(server, cwd, deps)` 对 `"installation"`、`runtimeId`（进程级 randomUUID）、git `rev-parse --show-toplevel`、git `rev-parse --path-format=absolute --git-common-dir` 分别求 ref。git 调用带 1s 超时且失败降级为 cwd。
  - **不暴露 hostname、用户名、仓库路径、git remote**（文件里明确写了这个目标）。读本地身份状态失败就返回 undefined、不出 topology，**绝不阻断投递连接**。
  - 本地版里对比这四个 ref 就能直接判定 same_worktree / same_workspace / same_local_installation——连服务端参与比较都不需要。注意 ref 按 `server` 加盐，本地版要选一个稳定的替代盐。
  - `harness_session.harness` 的注释（`:733-740`）指出这只是**显示/种类提示，绝非寻址契约**；服务端的 `claude_sessions` 投影刻意只收 `"claude"`，因为它的每个消费者都通过 Claude 自己的 ListAgents/SendMessage 面解析，而那个面够不到 codex 会话。

### 服务端绑死

- **游标**：`ReadCursor` / `ReadCursorFrame`（`:1655` 附近）依赖服务端广播；`WelcomeFrame`（`:1668`）的 `last_seq`、`last_rev_seq`、`charter_rev`、`presence`、`read_cursors`、`participants`，以及能力位 `directed_delivery:"v1"` / `delivery_recovery:"v1"` / `owner_decision_binding:"v1"`，全是 Durable Object 的快照与协商。
- **租约**：`DIRECTED_DELIVERY_LEASE_MS = 90_000`（`:115`）、`DELIVERY_WORK_ID_LIMIT`（`:116`）、`DELIVERY_CONTINUATION_REF_LIMIT`（`:117`）、`DirectedDelivery`（`:1697`）及 `lease_epoch` / `lease_token` / `lease_until`、`DirectedDeliveryFrame`（`:1755`）、`ServeLeaseClaimFrame` / `ServeLeaseFrame` / `DeliveryUpdateFrame` / `DeliveryRecoverFrame` / `DeliveryStateFrame` / `DeliveryRecoveryResultFrame`（见 `ClientFrame` `:1641` 与 `ServerFrame` `:2599` 两个联合）。这套 CAS + token-fenced 恢复协议是**纯分布式税**——单机进程内投递仍然要崩溃恢复，但不需要 lease epoch。
- **Presence**：`PresenceEntry`（`:1002`）、`PRESENCE_TIMEOUT_MS = 60_000`（`:28`）、`AGENT_ACTIVITY_TTL_MS`、`PresenceFrame`。本地版应该直接读 session registry，而不是心跳。
- **`RuntimePeerDiscovery`（`:792` 附近）** 标了 `comparison: "server_derived"`、`caller_binding`（`unbound_advisory` / `capability_probe` / `live_socket`）——但如上所述，本地版可以改成 client-derived，因为原始 ref 本来就在本机生成，服务端只是当了个比较器兼隐私边界。`RuntimePeerProjection.candidate_ref` 的注释（`:780` 附近）说得很清楚：它是**恰好一个当前活着的 topology 快照**的随机句柄，会在该 socket 再次发布 topology 时重新生成、在 socket 不再可比时消失；**仅用于协调，绝不是认证、授权或投递句柄**。
- 频道/账号配额类：`MAX_CHANNELS_PER_ACCOUNT`（`:78`）、`CHANNEL_CREATE_WINDOW_MS`（`:79`）、`MAX_CONNECTIONS_PER_CHANNEL`（`:83`）、membership 分层（`:123-157`）、webhook 全套（`:32-71`）、wake budget（`:90-102`）、审计与保留（`:107-111`）。

⚠️ **必须继承的教训**（`protocol.ts` 在 `replay` 和 `superseded` 两处都写了）：**`cli/src/client.ts` 的 `isMessageFrame` 校验必须逐字镜像 MsgFrame 的字段列表**，否则会静默丢帧（#622）。任何自建协议都要有这个一致性约束的测试。

---

## 6. MCP server

### 位置与传输

server 是 `cli/src/commands/mcp.ts` —— 一个 **stdio** MCP server，不是 HTTP/远程。文件头就这么写（`:1`），它 import `StdioServerTransport`（`:7`），在 `createMcpServer(defaultChannel)`（`:428`）里构建 server，在 `:1733-1734` connect。按身份逐个启动：`party mcp [--channel C] [--identity L]`，注册进 Claude 的 `~/.claude.json` 或 codex 的 `config.toml`。因为 stdout 是 JSON-RPC 通道，`console.log` 被重定向到 stderr（`:1746` 附近；`:1717` 的注释解释了 #596）。生命周期由 stdin EOF 加上 parent-liveness 看门狗界定（`:1749-1753`，`cli/src/parent-liveness.ts`）。

还有**第二个独立的 stdio server**：`party mcp --managed <stateDir>` → `runManagedMcp`（`cli/src/commands/mcp-managed.ts`，分发在 `mcp.ts:1697-1702`）。它是 `party serve --profile` 监督进程为 front/worker lane spawn 的角色受限工具面，同样是 `StdioServerTransport`（`mcp-managed.ts:20`），只暴露 `party_charter`、`party_history`、`party_reply`、`party_worker_dispatch`、`party_worker_feedback`、`party_decision_ask`、`party_worker_report`（`mcp-managed.ts:129,147,169,239,250,261,353`）。它的宿主握手是**文件式的**（`managed.json` / `wake.json` / `outcome-<seq>.ndjson`，文档在 `mcp-managed.ts:7-11`）——这个文件式握手模式本身对本地版有参考价值——但它仍从 REST import `fetchChannelCharter, fetchRecentMessages, postMessage`（`mcp-managed.ts:45`）。

`cli/src/mcp-registry.ts` 和 `cli/src/codex-mcp-registry.ts` **不是** server，是注册**治理**：对 `~/.claude.json`（`mcp-registry.ts:38`）和 codex TOML（`codex-mcp-registry.ts:41`）的纯解析/分类，加上"这进程是不是我们的"硬判据（`looksLikePartyMcpCommand`，`mcp-registry.ts:86`；`isPartyMcpRegistration`，`mcp-registry.ts:106`）。`commands/mcp-identities.ts` 是去重/清理 CLI（`party mcp identities`），`mcp-prune.ts` 是陈旧注册的回收器。

**一个刻意的架构约束**，写在 `cli/src/mcp-registry.ts:1-6`：**每身份一个进程，绝不共享 daemon**——一个能扮演所有本地身份的 server 是权限放大（引用事故 #865/#862）。做本地版**强烈建议保留这条**。

### 工具与网络依赖

每个需要凭据的 handler 都走 `auth()`（`mcp.ts:257-261`）→ `resolveAuth()`（`cli/src/oidc-cli.ts:486`），后者本身可能发网络请求刷 OIDC token（`oidc-cli.ts:133,347`）。所有 REST 调用汇聚到 `cli/src/rest.ts:234` 的**单个** `fetch`。

`mcp.ts` 里注册的工具（行号 = `registerTool` 调用处）：

| 工具 | 行 | 网络？ |
|---|---|---|
| `party_whoami` | 440 | REST —— `fetchMe`（:450） |
| `party_charter` | 466 | REST —— 经 `charterData()`（:411-412）→ `fetchChannelCharter` |
| `party_authz_check` | 500 | REST —— `fetchChannelCharter`（:526）；**决策本身是本地的**（`checkAuthz`，`cli/src/authz.ts`） |
| `party_channels` | 541 | REST —— `listChannels`（:551） |
| `party_send` | 559 | REST —— `postMessage`（:602），加附件上传 `uploadAttachmentPaths` |
| `party_decision_ask` | 629 | REST —— `askDecision`（:655） |
| `party_status` | 674 | REST —— `postMessage`（:741）+ `updateTask`（:754）；另有**本地**租约 `acquireTaskLeaseAcrossMachines`（:714）和 `buildContext` |
| `party_who` | 776 | REST —— `fetchPresence`（:794） |
| `party_history` | 821 | REST —— `fetchMessages` / `fetchRecentMessages`（:872-883） |
| `party_digest` | 903 | REST —— 经 `captureCommand`（:924）在进程内重入 `digest` 命令 |
| `party_task_list` | 929 | REST —— `listTasks`（:946） |
| `task_list` | 958 | REST —— `listTasks`（:975） |
| `party_task_create` | 987 | REST —— `createTask`（:1039） |
| `party_task_from_message` | 1058 | REST ×2 —— `fetchMessages`（:1082）后 `createTask`（:1087） |
| `party_task_update` | 1105 | REST —— `updateTask`（:1139） |
| `task_claim` | 1147 | REST —— `updateTask`（:1161） |
| `task_status` | 1169 | REST —— `updateTask`（:1184） |
| `task_complete` | 1192 | REST —— `updateTask`（:1206） |
| `task_block` | 1214 | REST —— `updateTask`（:1228） |
| `party_spawn_worker` | 1236 | REST —— `spawnAgent`（:1259） |
| `party_watch_once` | 1270 | **混合** —— 本地读 debt `loadStuck`（:1307）、本地游标 `loadCursor`/`saveCursor`（:1396, :1413），但用 `fetchMessages`/`fetchRecentMessages`（:1323-1324）确认，并阻塞在 `runWatch` → **WebSocket** `…/api/channels/<slug>/ws`（`client.ts:509,637`） |
| `party_ack` | 1451 | REST —— `fetchRecentMessages`（:1499）、`ackDelivery`（:1533）；也推进本地游标 |
| `party_receipt` | 1572 | REST —— `postReceipt`（:1599） |
| `party_wake_test` | 1616 | REST —— 重入 `wake test` 命令（:1637） |

另有两个 MCP **resource**：`party://charter`（绑定频道，`:1655`）和模板 `party://{channel}/charter`（`:1672`）——都调 `charterData()`，所以也是 REST。

**净结论：没有一个工具是纯本地的。** 完全本地的逻辑只在辅助层——`checkAuthz`、`cli/src/config.ts` 里的游标/stuck 欠账簿记、`cli/src/task-lease.ts` 的租约文件存储、频道/slug 校验。

### 能否脱离云端后端跑

按现状**不能，而且没有 transport seam**。具体：

1. **REST 是作为自由函数 import 的，不是注入的。** `mcp.ts:29-48` 从 `../rest` import 约 18 个具名函数，每个 handler 直接调例如 `postMessage(cfg.server, cfg.token, resolved, …)`。没有 `PartyClient` 接口、没有构造参数、没有 DI。`createMcpServer(defaultChannel)` 只收一个 channel 字符串（`:428`）。换后端意味着改 25 个 handler 体，或者 shim 掉整个模块。
2. **`{server, token}` 被贯穿到每个调用点**，作为 `auth()` 产出的两个位置参数。这个签名形状把"存在一个带 bearer 凭据的远端"硬编码进去了。
3. **`party_watch_once` 需要推送通道**，不只是请求/响应：`runWatch` 打开的 WebSocket 由 HTTP base 经 `httpBase.replace(/^http/, "ws")` 推导（`client.ts:509`）。本地版需要一个替代事件源（文件 watch、Unix socket、本地 pub/sub）。
4. **有四个工具连 `rest.ts` 都不直接走**——`party_digest`（:924）和 `party_wake_test`（:1637）通过 `captureCommand` 重入 CLI，`party_decision_ask`/`party_status` 复用 `askDecision`/`buildContext`。这些路径在更深一层才碰到 REST，所以光换 `rest.ts` 还盖不住命令层。

**现实的接缝**：`cli/src/rest.ts:234` 是所有 HTTP 的**单一**收敛点，`cli/src/client.ts:488` 的 `connect()` 是唯一的 WS 收敛点。本地版可行做法有两条：(a) 把 `rest.ts` 的导出抽到一个接口后面，把实现注入 `createMcpServer`；(b) 更粗暴但小得多——**保留签名**（让 `server`/`token` 变成无意义但兼容的参数），针对本地存储/回环重新实现 `rest.ts` + `client.ts`。当前形状邀请的是 (b)，25 个 handler 一行不用动。

---

## 7. `~/.agentparty/` 本地状态

根目录是 `agentpartyHome()` —— `$AGENTPARTY_HOME` 或 `~/.agentparty`（`cli/src/config.ts:133-138`）。所有写入走 `atomicWriteJson`（tmp + rename + chmod 0600，`cli/src/atomic-json.ts:26-38`）；注意 tmp 文件名形如 `.<name>.<pid>.<uuid>.tmp`（`:29`）——本机 `~/.agentparty/state/activity/` 下观察到若干孤儿 `.tmp`，说明崩溃的写入方确实会留残渣。

### 本机实际内容

顶层：`config.json`、`account.json`、`join-bindings.json`、`node-secret`、`codex-auto-wake.json`、`codex-trust-gate.json`。目录：`agents/`（约 156 个身份文件）、`agent-configs/`、`project-agents/`、`state/`（14211 项）、`instances/`（28 个锁）、`owners/`、`runners/`、`logs/`、`wake-claims/`、`delivery-recovery/`、`claude-sessions/`、`codex-sessions/`、`codex-auto-wake/`、`codex-stop-wake/`、`desktop/`、`apple-release/`。

**`config.json`**（mode 0600）对应 `interface Config`（`config.ts:24-32`）：`server`、`token`（*存在，已隐去*）、`lang`，加嵌套 `identity` 对应 `CachedIdentity`（`config.ts:34-46`）——`name`、`email`、`kind`、`role`、`owner`（一个 `lark:on_…` principal）、`owner_handle`、`owner_display_name`、`channel_scope`、`verified_at`。路径解析：显式 `$AGENTPARTY_CONFIG` 优先（`:205`），否则 `~/.agentparty/config.json`（`:220`），否则 per-cwd 的工作区 config `state/<workspaceId>/config.json`（`:234`）。

**`agents/*.json`** —— 同样的 `Config` shape，每个频道作用域的 agent 身份一个文件，各自持有 token。`durableConfigPointerPath`（`config.ts:288-297`）专为"在 `$TMPDIR` 里发出的 token 要镜像到这里"而存在（#518）。`localAgentConfigsForChannel`（`config.ts:156`）为路由建索引，并明确文档化为仅供诊断、**永不返回 token**（`:148-154`）。

**`account.json`** —— 人类 OIDC 会话：`server`、`refresh_token`（*存在，已隐去*）、`access_token`（*存在，已隐去*）、`expires_at`、`email`、`sub`。带轮换的刷新在 `oidc-cli.ts:338-353`。

**`node-secret`** —— 65 字节的 0600 文件（*内容已隐去*）。

**`join-bindings.json`** —— `{version:1, bindings:[…]}`，每条对应 `JoinBinding`（`join-binding.ts:41-56`）：`harness`（`codex|claude|other`）、规范化的 `server`、`channel`、`owner`、`identity`、`config_path`、`cwd`、`created_at`。**明确不含 token**（`:40`）。容量 200（`:59`）；replace-vs-coexist 按 4 元组取键（`joinBindingKey`，`:74`）。文件头注释（`:1-27`）是整个仓库里意图最清楚的一段：以前身份是靠 cwd/进程树/env 事后**推断**的，四条阶梯在 owner 机器上全挂了，所以修法是在 join 那一刻**记录事实**。

**`state/<workspaceId>/`** —— per-cwd 游标状态。`state.json` 对应 `WorkspaceState`（`config.ts:100-125`）：顶层 `channel`/`cursor`/`rev_cursor` 镜像，加一个 per-channel 的 `cursors: {slug: {cursor, rev_cursor, stuck?}}` map（#113 加的，防 `serve --profile` 把每个频道从 seq 0 重放），加 `bindings` map 和 `config_path` 面包屑。本机实读为 `{channel:"agentparty", cursor:844, rev_cursor:124}`。

`stuck` 字段是 `StuckWake`（`config.ts:66-98`）——一笔唤醒**欠账**，语义上与游标截然不同（游标说"这条我读完了"，stuck 说"这条我欠着"）：`seq`、`delivery_id`、`work_id`、`continuation_ref`、`delivery_acceptance`（`unconfirmed|accepted`）、`attempts`、`last_error`、`retriable`、`termination_unconfirmed`、`source`、`channel_last_seq`、`first_wake_ts`、`skipped_mention_seqs`。

同一工作区目录下还有：`health.json`（`health-cache.ts:54`）——实测键为 `v, pid, channel, ws_connected, last_frame_at, reconnecting, reconnect_count, last_error, connected_since, current_task, task_started_at, heartbeat_at, supervisor_state, supervisor_attempt, restart_delay_ms, last_exit_code, last_exit_at, supervisor_error, lease_state, serve_standbys, updated_at`；`statusline.json`（`statusline-cache.ts:55`）；以及 `slots/`——按 (channel, config 来源, token 指纹) 分的缓存槽，命名 `<kind>-<channel>-<sha256[:16]>.json`，kind 取 `health | statusline | upgrade-hint`（`cache-slot.ts:14-30`）。指纹刻意包含 `token_fingerprint`，这样同一 cwd 下的两个身份不会互相覆盖缓存。`state/activity/` 下有约 568 个按 UUID 命名的小 json。

**`instances/`** —— 单实例锁，命名 `<kind>-<sha256(server+token)[:24]>-<channel>.lock`，kind 取 `watch|serve`（`instance-lock.ts:20,45,54`）。实测内容 `{pid, kind, channel, ts}`。锁目录**刻意不按 cwd 分域**，这样同一身份不能从另一个仓库二次启动（`instance-lock.ts:48-50`）；token 只以哈希形式出现（`:53`）。liveness 用 pid + 进程启动时间（`isSameLiveProcess`，`:156`）。`instances/runner-cwd/` 存 `RunnerCwdClaim` 文件（`:353,378`）。

**`task-leases/`** —— `TaskLeaseHolder`（`task-lease.ts:32-41`）：`executor_id`、`channel`、`task_id`、`acquired_at`、`renewed_at`、`expires_at`、可选 `taken_over_from`。文件名按 `sha256(server+token)` + channel + task id 取键（`:77-87`）。executor 身份从一个 env 阶梯解析（`EXECUTOR_ID_ENV_LADDER`，`:134`），带一个文档化的拒绝态——身份未知时返回 `unenforced`，即**拒绝伪造判定**（`:53`）。（本机该目录不存在，无活跃租约。）

**`delivery-recovery/<bridge>-<channel>-<principal>.json`**（`delivery-recovery-journal.ts:181-195`）—— 有界（64 条，`:59`）的崩溃恢复日志。每条（`:31-45`）携带完整 `DirectedDelivery` 加 `phase`（`claimed | running_authorized | harness_issued | harness_accepted | reply_posted | waiting_owner | failed_pending`，`:23-30`）、`nextLeaseToken`（**在发出恢复请求之前就落盘**，好让 ACK 丢失后的重试幂等，`:37`）、`replyBody`、`replySeq`、`claimReceipt`、`terminalError`、`threadId`、`turnId`、`updatedAt`。实测文件确认含服务端签发的租约字段：`lease_epoch`、`lease_token`、`lease_until`、`work_id`、`continuation_ref`。

**`continuations/`**（相对 runner 工作目录，`continuation.ts:17,41`）—— `sha256(continuation_ref).json`，存 `RunnerContinuationState`（`:21-39`）：`harness`（`codex|claude|codex-sdk`）、`session_id`/`thread_id`、`created_at`、`last_wake_ts`、`wakes`、`cwd`、`workdir`、`continuation_ref`、`work_id`，以及用于"句柄有效但 resume 不安全"情形的 `resume_blocked_reason`/`resume_blocked_at`。注意仓库根目录下也有一个同名 `continuations/` 目录。

**`claude-sessions/` 与 `codex-sessions/`** —— 活跃 harness 会话注册表：`{version, harness, session_id, pid, display_name, channel, server, identity, cwd, registered_at}`。

**`wake-claims/`** —— `{runtime_id, channel, seq, claimed_at}`，即 per-(身份, 频道, seq) 去重，防两个 runtime 都去答同一个 @。

**`codex-trust-gate.json`** —— `{key（已隐去）, savedAt, versions:{<codex 二进制路径>: version}}`。**`codex-auto-wake.json`** —— `{version, mode:"serve"}`。另有 `logs/`、`runners/<sha256>/<channel>/`、`owners/`、`desktop/{bin,duty-blocked,duty-locks,logs}`。

### 无服务器场景下哪些概念存活

**存活——它们描述的是*这台机器*，不是远端：**

- **每 agent 身份与 `agents/` 目录。** 同机多 agent 仍需不同 principal；`channel_scope`、`owner`、`name` 依旧有意义。只有 `token` 字段和 `verified_at` 是远端产物——身份会从"服务端已验证"变成自声明或本地签名。
- **join bindings**（`join-binding.ts`）。4 元组失去 `server`，但"(harness, channel, owner) → identity，在 join 时记录"正是本地消歧问题本身，而且文件本来就不含 token。这可以说是这批模块里**最可移植的一个**。
- **游标 / `rev_cursor`**（`config.ts:100-125`）。append-only 日志上的每频道读位置与传输无关；本地日志同样有 seq。
- **实例锁**（`instance-lock.ts`）。防同身份的两个 `watch`/`serve` 进程同时跑，是纯本地互斥问题。锁*目标*从 `sha256(server+token)` 换成类似 `sha256(config path)` 即可，机制（pid + 启动时间 liveness）原封不动。
- **`stuck` 唤醒欠账**（`config.ts:66-98`）。"我被叫醒了还没答，崩溃不能静默丢"是本地持久性属性。`delivery_id` 假定服务端签发 id，但本地总线可以自己铸。
- **缓存槽、health 缓存、statusline 缓存**（`cache-slot.ts`、`health-cache.ts`、`statusline-cache.ts`）。这些是本地可观测性。部分*字段*是远端专属（`ws_connected`、`reconnect_count`、`connected_since`），槽指纹会用 config path 取代 `token_fingerprint`。
- **continuations**（`continuation.ts`）。把一次唤醒映射回可 resume 的本地 harness 会话，完全是本地 Claude/codex 进程的事。
- **`atomic-json.ts`、两个会话注册表、wake-claims、`codex-trust-gate.json`。** 全是本地进程事实。

**只因为有远端服务器才存在：**

- **`config.token`** 以及整个 `account.json` OIDC 会话（`refresh_token`/`access_token`/`expires_at`/`sub`）—— 给 Worker 的 bearer 凭据。`cli/src/oidc-cli.ts` 整个消失。
- **`config.server`** 和 `normalizeBindingServer`（`join-binding.ts:66`）—— 促成 #865 的多实例消歧本质上就是"哪个 Cloudflare 部署"。
- **`identity.verified_at`** —— 记录 `fetchMe` 曾远程确认过这份 profile。
- **`delivery-recovery/` 的当前形态。** 这个日志存在，是因为定向投递是一个*分布式* ack 协议：`lease_epoch`、`lease_token`、`lease_until`、发送前落盘的 `nextLeaseToken` 幂等性、`running_authorized`/`harness_accepted` 这些相位，全是为了熬过网络丢 ACK。单机进程内投递仍然要崩溃恢复，但那套 lease-token/epoch 机器是纯分布式税。
- **`task-leases/` 的跨机那一半。** *本地*文件存储（`cli/src/task-lease.ts`）是真正的本地互斥、可以留下，但 `task-lease-remote.ts` / `acquireTaskLeaseAcrossMachines`（用在 `commands/mcp.ts:714`）和 health 缓存里的 `lease_state` 只为跨主机协调 executor 而存在。
- **Presence / 心跳。** `party_who` → `fetchPresence`、`heartbeat_at`、`serve_standbys`、`reportWakeSelfCheck`（`commands/mcp.ts:1740-1743`，`cli/src/wake-reachability.ts`）——"这个身份从别处可达吗"在没有"别处"时毫无意义。本地版直接读会话注册表。
- **`node-secret` 之外的凭据**（`node-secret` 本身是 topology 用的，要留）。

**结构性观察**：这个切分在*数据*层异常干净（锁、游标、bindings、continuations 全是自包含模块，**没有一个 import `rest`**），但在*工具*层不干净——`commands/mcp.ts` 把 REST 函数直接 import 进全部 25 个 handler。所以本地版基本上就是"重新实现 `rest.ts` + `client.ts`，再删掉 auth/lease/presence 路径"，`~/.agentparty/` 下的状态模块大体可原样存活。

---

## 总结：最薄的可行本地传输层

**现成的本地传输已经有两条**，不需要从零发明：

1. **Claude ← `cc-socks` UDS**：`claude-inbox-inject.ts` + `serve-wake-proxy.ts` + `claude-session-registry.ts` 三件套。`attemptWakeProxy` + `socketWakeProxyForwarder` + `injectChannelMessage` + `listClaudeSessions` 就能唤醒本机任一活着的交互式 Claude，只要有东西负责注册会话（`commands/hook.ts:872` 的 SessionStart hook）。
2. **Codex/ChatGPT ← Desktop IPC**：`codex-desktop-ipc.ts`（#1012），走 ChatGPT.app 自己的 `~/.codex/ipc/ipc.sock`，用 `thread-follower-start-turn` + `codex_app` toolOutput 注入原生跨任务消息。
3. 补充路径：**Codex Stop hook** 的 `{"decision":"block","reason":…}` —— `reason` 即注入的 prompt，上限 512 字节。机制本身完全本地，只有"有没有新消息"这一问要走 `/next-mention`。

### 推荐架构

中间放一个**本机 append-only 消息日志**（单个 JSONL 文件或 SQLite，per-channel 单调 `seq`），配一个 UDS 或文件 watch 做"有新消息"的通知。然后：

- 复用 `MsgFrame` 的数据形状（含"只按 seq 定序、绝不按 ts"的结论和 `superseded` 的两种可证明关系），丢掉 `WelcomeFrame` / lease / presence 帧。
- 复用 `runtime-topology.ts` 整个文件做 locality 判定——本地版里连 "server_derived comparison" 都不需要，client 自己比四个 ref 就够；只需换掉按 `server` 加盐这一点。
- 复用 `join-binding.ts`、`instance-lock.ts`、`config.ts` 的 cursor/stuck、`continuation.ts`、两个 session registry、`atomic-json.ts`、`mention-wake-claim.ts`，几乎原样。
- 投递就是：写日志 → 通知 → 按目标 harness 选载体（Claude 走 UDS 注入，ChatGPT Desktop 走 IPC，headless 走 spawn `claude -p --resume` / `codex resume`）。
- 复用 `codex-turn-arbiter.ts` 做单写者串行化（它的 transport 本来就是注入的）。
- **保留"每身份一进程 MCP，绝不共享 daemon"**（`mcp-registry.ts:1-6`）。
- 改造成本集中在两个点：重写 `rest.ts`（保签名、换实现打本地存储）和 `client.ts:488` 的 `connect()`（换成本地日志 tail）。25 个 MCP handler 一行不用动。
- 验收直接抄 `verify-agentparty-claude-cross-session.ts` 的 21 条证据，删掉 `worker_deployment` / `runtime_peer` 两类 blocker。

### 必须正面处理的两个已知坑

1. **Claude 的 `crossSessionInbound` 默认 hold**、5 分钟无人 Deliver 就丢弃且不回错（`claude-inbox-inject.ts:24-36`）。这是"本地传输已就绪"和"消息真的送达"之间的鸿沟，也是现有代码刻意丢弃 `attemptWakeProxy` 返回值的原因。本地版必须给出答案（要么改默认，要么设计一条带确认的回路）。
2. **Codex hook 信任闸**（`codex-trust-gate.ts:44`）—— 本地版同样绕不过去，且它**静默失败**、零报错。`codex-hook-trust.ts:262` 的修复器（外科式写入 + 重解析比对）可以直接复用；**别去碰 `--dangerously-bypass-hook-trust`**，仓库里两处明示了这条硬边界。
