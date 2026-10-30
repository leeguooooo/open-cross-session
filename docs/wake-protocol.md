# Cross-session wake protocol v2（ocs 与 AgentParty 共用）

> 2026-10：AgentParty 已停止维护，本协议此后只由 ocs 演进；下文里 AgentParty 的部分保留作历史参考。

本文是 [open-cross-session#3](https://github.com/leeguooooo/open-cross-session/issues/3)、
[#4](https://github.com/leeguooooo/open-cross-session/issues/4)、
[#5](https://github.com/leeguooooo/open-cross-session/issues/5) 与
[AgentParty#1052](https://github.com/leeguooooo/agentparty/issues/1052) 的共同设计，**正本在此**。
AgentParty 在 `docs/cross-session-internals.md` 镜像「协议」一节并链接回来。两个仓库各自只接一层壳；
字段名、文案骨架、上限数字两边逐字一致，改动先改这里。

## 0. 为什么

对照 Claude Code 内置 `SendMessage`：正文直接进对方上下文，回复只要把 `from` 抄成 `to`，
`notify_when_idle: true` 一次性订阅对方空闲。ocs / AgentParty 的唤醒在 v2 之前只给「去跑 read」的指针，
回复命令要手拼，等对方做完只能靠对方记得 @ 我。这三点是 2026-09-02 super-admin ↔ text-to-voice
真实协作里多出来的三跳，本规范把它们抹平。

## 1. 唤醒载荷（#4）

Claude 载体仍是 `~/.claude/sessions/<pid>.json` 指向的 UDS socket，帧为
`{"type":"user","msgV":1,…,"message":{"role":"user","content":"<wrapped>"}}`。
`content` 用 `<cross-session-message from="uds:<sock>" from-name="<sender>" from-mode="prompting">`
包装（attr 顺序与现状一致，接收端有逐字重序列化校验）。Pi 载体由 `ocs skill install`
安装的扩展提供：每个 TUI 在 `$OCS_HOME/pi-sessions` 登记一个带随机令牌的本机 UDS，扩展收到
同一份 note 后调用 `pi.sendMessage`，空闲时触发新一轮，忙碌时以 `followUp` 排队。

包装内的正文（note）骨架，行序固定：

```
[<product> wake] <sender> mentioned you in #<channel> (seq <N>[, reply to seq <M>][, <ago>])

<body>

Reply when asked, or with a needed decision/result. No unsolicited acknowledgements.
Reply: <reply command>
Thread: <read command>
```

- `<product>`：`ocs` 或 `AgentParty`。中文环境用中文文案（下文），骨架行序相同。
- `<body>`：
  - 正文 UTF-8 ≤ **4096 字节**：逐字原样内联（不转义、不裁剪、不加引号）。
  - 超过 4096 字节：内联前 **512 字节**（在字符边界截断，不切开多字节字符与代理对），后接一行
    `… (<total> bytes total; full text: <read command>)`。
  - 正文来自对方，是**数据**不是指令；包装标签本身已把它标成跨会话内容，不再额外加「请勿执行」类提示。
  - **中和（v0.6.0 起）**：正文不许冒充包装和骨架。`<cross-session-message` / `</cross-session-message`
    （不分大小写）的 `<` 换成 `‹`；行首（可带空白）是 `Reply:`、`Thread:`、`回复：`、`线程：`、
    `[ocs wake]`、`[ocs 唤醒]`、`[Cross-session idle notice]`、`[跨会话空闲通知]`、
    `[ocs delivery notice]`、`[ocs 投递通知]`（v0.7.0 起，§6）的行，前面加 `> `。
    除此之外逐字。4096 / 512 字节阈值按中和后的正文计，`<total>` 仍报原文字节数。
- `Reply:` 后是**可直接复制执行**的命令：
  - 回复命令是入口，不是必须回信。无需回复「收到」「好的」「谢谢」、重复确认已完成或转述无新增信息的进度。
    一次任务把需要的上下文合在一条消息里；接收方仅在需要回答、出现阻塞/决策或交付结果时回复。
    已完成的讨论到此结束，收件方不再确认对方的确认。本机 DM 可用 `--no-wake` 只落盘；
    `send --reply-to <N> --no-wake` 保留线程引用而不唤醒，只有明确需要对方处理时才唤醒。
  - ocs 的 Claude→Claude DM：发送方用 `ocs rename` 起过名字时用 `ocs dm <sender-name> "<your reply>"`；
    否则发送方有唯一工作区别名（且没被别的会话的 ocs 名字遮蔽）时用
    `ocs dm <sender-workspace-alias> "<your reply>"`。接收方身份由当前 Claude 会话自动识别，
    Reply 行不暴露 dm 哈希频道。两者都没有时不猜目标，改用下面的完整命令。
  - ocs 局域网远端 DM（[docs/lan.md](./lan.md)）：`ocs dm <sender-address>@<peer-label> "<your reply>"`，
    `from-name` 同为 `<sender-address>@<peer-label>`；Claude、Codex、Pi、cmux 接收方都用这一行。
  - ocs 投给活 Claude、Codex 或 Pi 会话：
    `ocs send <channel> "<your reply>" --reply-to <N>`。三种 harness 都会给子进程提供可验证的
    当前身份，Reply 行不得再用短展示名覆盖它。
  - ocs 投给无法验证自身身份的 cmux surface / headless shell：
    `ocs send <channel> "<your reply>" --as <receiver-name> --reply-to <N>`。
  - AgentParty：`party send <channel> "<your reply>" --reply-to <N>`；若接收方身份来自显式
    `AGENTPARTY_CONFIG` 路径，则前缀 `AGENTPARTY_CONFIG=<path> `。具体旗标以 `party send --help`
    为准，实现者核对后填入。
- `Thread:` 后是读线程的命令（ocs 的活 Claude/Codex/Pi：`ocs read <channel>`；
  无法验证自身身份的 ocs 载体：`ocs read <channel> --as <receiver-name>`；AgentParty：
  `party history <channel> --seq <N>`）。
- 整条 note 上限 **5120 字节**（4096 正文 + 骨架 ≤ 1024）。骨架超预算时按降级阶梯先砍 `<ago>`、
  再砍 sender，`Reply:` 与 `Thread:` 两行永不砍。
- 多个 runtime 共享同一身份时（AgentParty `siblings=N`）保留现有那一行，放在第一行之后。

中文骨架：

```
[<product> 唤醒] <sender> 在 #<channel> 提到了你（seq <N>[，回复 seq <M>][，<ago>]）

<body>

只在被要求或有必要决策/结果时回复；不发无请求的确认回信。
回复：<reply command>
线程：<read command>
```

ocs 侧补充：`ocs send --reply-to <N>` 会**隐含唤醒 seq N 的作者**（发送者本人除外）——`Reply:`
那行复制执行就必须真的把回复送回发送方，不能再要求手加一个 `@`。ocs 的唤醒紧随 send，
`<ago>` 一般不填。

`ocs dm --no-wake` 和 `ocs send --no-wake` 仍完整落盘、保留 route/seq/inbox，
明确跳过所有唤醒载体，JSON 报 `wake: skipped`、退出 0。`dm --no-wake` 不可同时订阅
`--notify-when-idle`，也暂不支持 LAN 目标；这两种在任何写入前拒绝。静默消息不会因自身投递而启动模型回合。

Pi 地址固定为 `pi-<session UUID>`，频道身份使用独立的 `pi:<session UUID>` 命名空间。
socket 写出但没收到确认时按「结果未知」处理，不自动重发。

### 1.1 Codex 回合进行中（ocs v0.7.4，#41）

Codex 宿主在目标正跑回合时不会丢弃 `codex queue` / Desktop start-turn 的输入，而是排进线程的
待发队列，回合结束后**每条单独开一个新回合**。连发 N 条就是任务结束后 N 个回合逐条补放旧消息。
所以 ocs 在入队前先看目标是否在回合中（rollout 最后一个生命周期事件是 `task_started`，取其 `turn_id`）：

1. **插入当前回合**（首选）：非 Desktop 托管的线程，连 `$CODEX_HOME/app-server-control/app-server-control.sock`
   （守护进程，WebSocket 上的 app-server JSON-RPC），`initialize` 后发
   `turn/steer {threadId, expectedTurnId: <turn_id>, input: [{type:"text", text:<note>}]}`。note 与 §1 相同。
   宿主拒绝（回合已换等）= 明确没插进去，走下一步；帧发出后无应答 = 结果未知，停止，不重放。
2. **合并积压**（退路）：插不进时消息只落盘，唤醒记进 `$OCS_HOME/codex-wakes/<thread>.<channel>.json`，
   每对（接收方, 频道）一个脱离终端的等待器。回合结束时取出这一批，筛掉接收方读游标已覆盖的 seq，
   剩下的合成**一条**唤醒走 §1 原有载体；全部读过就不发。积压超过 6 小时不再等，照样投一条。
   合并唤醒正文是最新一条，首行在 `reply to` 之后、`<ago>` 之前加：

   ```
   plus <K> earlier unread from seq <F> — read the thread first
   前面还有 <K> 条未读（从 seq <F> 起），先读线程
   ```

   这一段与 `Reply:` / `Thread:` 一样不进降级阶梯。`<ago>` 按消息落盘时间算，延迟一眼可见。

`--peek` 不推进游标，所以 peek 过的消息仍会被合并唤醒提醒——读取不等于处理，宁可多提醒一次也不吞消息。
空闲目标的投递和 0.7.3 完全一样。

ocs 的 Claude DM 频道使用稳定工作区身份派生。Git 仓库按规范化远程地址归一，非 Git 目录按
启动路径归一；原始值只进本机 `workspace-key` 的 HMAC，频道名不携带路径或远程地址。同一工作区多会话或
别名冲突时不共用频道，改用会话级身份。v0.3.4 之前的旧历史用
`ocs dm <target> "<text>" --inherit <old-dm-channel>` 绑定一次；绑定前要求双方工作区在线且唯一，并验证旧频道里双方都发过言。
若稳定频道已有消息，则新建确定性合并频道，先写旧历史、再写稳定历史；两个原频道不改写。
合并频道名包含快照内容摘要，崩溃后源频道若继续增长，重试会生成新快照，不复用未绑定的旧快照。

## 2. 空闲通知（#5）

名字统一：订阅叫 **`notify_when_idle`**（CLI 旗标 `--notify-when-idle`，独立命令
`notify-when-idle <target>`，MCP/API 参数 `notify_when_idle: true`）。语义与内置一致：

- **一次性**：订阅只触发一次，触发即失效。
- **触发条件**：目标下一次由 busy 变为 idle，或目标退出/离线。订阅时目标已 idle → 立即触发。
- **有效期**：6 小时；到期未触发发一条过期通知。
- **投递**：作为一条唤醒注入订阅方的会话（与 §1 同一条注入路径），不进公共频道正文；
  AgentParty 若没有「只投给一个订阅方」的原语，实现者选最接近的现有定向投递机制并在 PR 里说明。
- **顺带发消息**：`send … --notify-when-idle` = 先发消息再订阅；单独 `notify-when-idle <target>` 不发消息。

通知正文（包装标签同 §1，`from-name` 为 `<product>`）：

```
[Cross-session idle notice] <target> is now idle. (busy for <duration>)
[Cross-session idle notice] <target> exited before going idle.
[Cross-session idle notice] <target> did not go idle within 6h; subscription expired.
```

中文：

```
[跨会话空闲通知] <target> 现在空闲了（忙了 <duration>）。
[跨会话空闲通知] <target> 在空闲前已退出。
[跨会话空闲通知] <target> 6 小时内没有空闲，订阅已过期。
```

状态来源：
- ocs：`~/.claude/sessions/<pid>.json` 的 `status`（`busy` / `idle`）与 `statusUpdatedAt`，
  pid + sessionId 双重钉住防 pid 复用；进程消失 = 退出。
- AgentParty：ChannelDO presence 行的 `busy` 与 state（offline）；由 `status` 帧翻转触发。

ocs 侧实现：没有常驻进程，每份订阅派一个脱离终端的 watcher（`ocs _idle-watch <id>`，同一二进制，
setsid + stdio 全关），每 2 秒轮询目标文件；订阅记录在 `$OCS_HOME/idle-subs/<id>.json`
（目标、订阅方 pid+sessionId、创建/过期时间、状态），`ocs who` 据此列出待触发项，同一
（目标, 订阅方）对重复订阅去重。订阅方必须是运行 `ocs` 的那个 Claude 会话（沿进程祖先链找到），
不在会话里则明确拒绝——没有会话可收通知。`<duration>` 从目标 `statusUpdatedAt`（读不到则从首次
观测到 busy）起算，格式 `45s` / `3m 12s` / `1h 5m`。

## 3. `read` 不回显自己（ocs #3）

`ocs read` 默认跳过 `from` 等于自己的消息，折叠成一行 `#<seq> <you> <前 60 字符>…`；
`--include-self` 完整显示。`--json` 输出不折叠，但每条带 `self: true/false`。
唤醒目标排除发送者本人：按祖先链 pid 排，也按发送者名字（`--as` 的那个）排，两条都有测试钉住。

## 4. 命名（#6）

会话名以 Claude Code 写在 `~/.claude/sessions/<pid>.json` 的 `name` 为准，两个项目都不自行派生；
读不到时才用各自的回退名（ocs：pid；AgentParty：`claude-<12hex>`），且要在之后的 hook 回合重试读取，
读到就以原生名覆盖显示名。

自身会话识别顺序（两个项目一致）：先看 Claude Code 给子进程的环境变量 `CLAUDE_CODE_SESSION_ID` +
`CLAUDE_CODE_MESSAGING_SOCKET`——从 socket 文件名取 pid，读 `sessions/<pid>.json`，要求 sessionId、
messagingSocketPath 都与环境变量一致且 pid 活，才算认出自己（零 spawn）；任一不符（继承来的陈旧环境、
`/clear` 后换会话、pid 复用）就回落到沿进程祖先链找（父 pid：Linux 读 `/proc/<pid>/stat`，否则 `ps`；
两者都没有＝视为不在会话里）。

## 5. 验收（两边各自做）

1. A 会话 `send` 一条 300 字节正文并 @B：B 的上下文里出现完整正文与两行命令；直接复制 `Reply:`
   那行（只替换引号内文字）就能回复，B 的回复在 A 端以 reply-to 关联。
2. 同上但正文 6000 字节：B 看到前 512 字节 + 总字节数 + 读线程命令。
3. A 对 B `--notify-when-idle`：B 忙完当回合后 A 收到且**只收到一条** idle notice；B 若已 idle 则立即收到。
4. 变异自检：把 4096 改成 40、把 `Reply:` 行删掉、把订阅改成每次翻转都发——对应测试必须红。
   §6 同理：不核对 `orig_msg_id`、不把 `expired`+`refused` 归一、delivered 也通知、终态通知发两次、
   通知自己也带回执——每一条都要有测试变红。
5. Pi A 启动并登记后，B 对 `pi-<session UUID>` 发 DM：A 空闲时立即开始一轮；A 忙碌时不打断当前工具调用，等本轮结束后处理。关闭 A 后，`ocs who` 不再把旧登记列为可达。
6. 接收端 `crossSessionInbound` 为 hold 时 A 对 B 发消息：A 当场看到「被扣留，尚未送达」且退出码 2；
   B 那边没人批准，5 分钟后 A 收到且**只收到一条**投递通知；B 批准了则 A 什么都不收。接收端为
   accept 时 A 看到 accepted、退出码 0。

## 6. 投递回执（Claude 载体，v0.7.0）

> English: [delivery-receipts.md](./delivery-receipts.md)（内容跟随本节，本节是正本）。

§1 的帧写进收件箱 socket 之后，还要过接收端的 `crossSessionInbound` 闸门：`accept` 直接进对话；
`hold`（**默认值**，仓库级设置还能把用户级的 accept 收紧成 hold）进待审队列，5 分钟没人批准就丢；
也可能被拒。v0.7.0 之前发送方分不出这几种归宿。Claude Code 自己有回执（`peer_message_status`，
2.1.285 实测，未文档化），这一节规定怎么用它。

### 线上形态

user 帧同时带 `from: "uds:<回执 socket>"` 和 `msg_id` 时，接收端把这条消息的归宿作为 JSONL 控制帧
连到那个 socket 写回来：

```
{"type":"control","action":"peer_message_status","status":"<status>","reason":"…",
 "from":"uds:<接收端 socket>","orig_msg_id":"<原消息的 msg_id>","msgV":1,"msg_id":"…"}
```

| 线上 `status` | 归一后 | 含义 |
|---|---|---|
| （没有回执） | `accepted` | 策略是 accept：接收端**一条都不回**，消息直接进对话 |
| `held` | `held` | 被闸门扣下，等人批准（写入后 30–50 ms 内到）。之后还有一条终态 |
| `delivered` | `delivered` | 被扣的消息有人批准了 |
| `expired` | `expired` | 5 分钟超时、待审队列被挤、或接收端会话退出 |
| `expired` + `status_detail:"refused"` | `refused` | 被拒 |
| `dropped`（带 `drop_reason`） | `dropped` | 队列满 |
| `denied` | `denied` | 策略拒绝 |

只认 `orig_msg_id` 等于自己那条 `msg_id` 的帧；状态不认识的丢弃。`reason` 是接收端给的文本，
压成一行、限 200 字符，当数据处理（进通知前过 §1 的中和）。

**回执证明什么、不证明什么**：`held` / `refused` / `dropped` / `denied` / `expired` 证明消息**没进**对话；
`delivered` 证明被扣的消息进了对话。`accepted` 只是「协议在窗口内没报告扣留或拒绝」——不是已读回执，
不证明对方处理了，也不证明接收端是一个会发回执的版本。任何记账（游标、@ 欠账）仍然只认对方回话。

### 回执地址与进程模型

接收端对回执地址有两条校验，决定了实现形状：

- 路径必须匹配 `/^\/\S*\.sock$/`，并且和接收端自己的 socket **同目录**。ocs 用
  `<目标 socket 所在目录>/<16 hex>.sock`（例如 `/tmp/cc-socks/3f9a…e1.sock`），权限 0600。
  目录不是真目录 / 不属于本用户 / 路径含空白时不建，退回无回执路径。
- 回执只发给**写入那条消息的进程**（按 socket 对端凭据的 pid 核对）。所以写帧的进程必须同时监听
  回执 socket，并且活到终态回执到来。

因此每次 Claude 唤醒由一个脱离终端的 helper 进程完成（`ocs _claude-wake <job-id>`，内部命令，
模型同 §2 的 idle watcher）：

1. 建回执监听 → 写帧（`from` + `msg_id`）→ 等第一条回执 **400 ms** → 往 stdout 报一行结果。
2. 没有回执：`accepted`，退出。`refused` / `dropped` / `denied` / `expired` / `delivered`：报告后退出。
3. `held`：继续等终态，最长 **5 分钟 + 60 秒**；期间目标会话消失（连续 3 次读不到）提前结束。
   到点仍无终态记为 `unknown`。
4. 终态 `delivered` 只记录。其它终态记录后**通知发送方一次**，然后退出（与 §2 同一条一次性纪律）。

CLI 派出 helper 后最多等 1.5 秒拿第一行结果；拿不到按「结果未知」报（退出码 3）。**帧只由 helper 写，
CLI 在任何情况下都不自己再写一遍**——只有 helper 根本没派出去时才在本进程走无回执的旧路径。

在 Claude 的 socket 目录里建这一个临时 socket 文件，是「Claude 的目录只读消费」的唯一例外：
只建这一个，helper 退出前必删；helper 被 SIGKILL 时，下一次唤醒按 `$OCS_HOME/wake-jobs/` 里的登记
清掉它留下的那个文件（只删登记过的路径，目录里别的文件不碰）。

### 发送方看到什么

| 第一阶段 | CLI 输出（英文） | 退出码 |
|---|---|---|
| `accepted` | `wake: accepted by inbox → <target> (no hold/refuse receipt; this is not a read receipt)` | 0 |
| `delivered` | `wake: delivered → <target> (receiver confirmed)` | 0 |
| `held` | `wake: HELD, not delivered yet → <target>: …dropped if nobody approves within 5 minutes…` | 2 |
| `refused` / `dropped` / `denied` / `expired` | `wake: NOT delivered → <target>: <status> (<reason>)…` | 2 |
| helper 没给结果 | `wake: outcome unknown → <target>: …` | 3 |
| 回执不可用 | `wake: delivered to inbox → <target>`（与 v0.6 逐字相同） | 0 |

回执不可用的情况：Windows（回执地址得是命名管道，还要带不该发布的认证材料）、`OCS_NO_RECEIPTS=1`、
回执监听建不起来、调用方不是 ocs CLI。退出码 2 / 3 的含义不变：消息已落盘，别重发。

### 投递通知

被扣下的消息最终没送达时，helper 往**发送方自己的会话**投一条通知（包装同 §1，`from-name` 为 `ocs`）：

```
[ocs delivery notice] seq <N> to <target> in #<channel> was held for approval and NOT delivered: <status>[ (<reason>)].
The message is still in the channel log; <target> will see it on `ocs inbox` / `ocs read <channel>`. Do not resend.
Fix on the receiving side: `ocs doctor --fix` (sets "crossSessionInbound": "accept" in ~/.claude/settings.json). A repo-level setting can still force hold.
```

中文：

```
[ocs 投递通知] 发给 <target> 的 #<channel> seq <N> 被扣留待审，最终没有送达：<status>[（<reason>）]。
消息还在频道日志里，<target> 跑 `ocs inbox` / `ocs read <channel>` 能看到。请勿重发。
根治：在接收端跑 `ocs doctor --fix`（把 ~/.claude/settings.json 的 "crossSessionInbound" 设为 "accept"）。仓库级设置仍可能强制 hold。
```

- 发送方 = 运行 `ocs` 的宿主会话（Claude / Codex / Pi），按各自载体投；不在任何会话里（裸 shell）
  就没人可通知，CLI 的 held 文案会明说。
- 通知帧**不带 `from`**：它自己不产生回执，不会「扣留 → 通知 → 再扣留」。§2 的空闲通知同理，不变。
- 发送方就是目标会话时不通知。
- 第一阶段就失败的（refused 等）CLI 已经当面说了，不再补通知。

### 落盘

回执作为独立的旁车帧写进同一频道日志（不是 `OcsMessage` 字段，旧二进制跳过这一行照常读消息）：

```
{"v":1,"type":"receipt","seq":<消息 seq>,"to":"<target>","status":"<归一后状态>","ts":"…"[,"detail":"…"]}
```

写在消息之后，一条消息可以有多行（`held` → `expired`），读侧按 (seq, to) 取最后一行。
`ocs read` 在**自己发的**消息下面显示 `[wake → <target>: <status>]`，`--json` 里是 `delivery` 数组。
回执行不参与 seq 推导。

### 局域网

远端 DM 由接收端机器上的守护进程走同一条唤醒：第一阶段结果随应答回给发送方（`outcome` 仍是
`ok` / `failed` / `unknown`，held 等归入 `failed`，具体状态在 `lines` 里），终态只记在接收端的频道日志，
不跨机回传、不通知。详见 [docs/lan.md](./lan.md)。

AgentParty 侧：serve 无回执 socket 时保持省略 `from`（现状）；要接回执需满足上面的进程模型。


## Explicit batches and diagnostics

`send/dm --batch <tasks.json>` stores all related task strings as a single ordinary
v1 message and invokes normal delivery once per recipient. It never drops, heuristically
merges or reruns tasks. Long bodies still follow this document's preview limits; receivers
must read the original full message. Batch counts and capabilities are not message v1
fields. Diagnostics never authorize replay. See [traffic.md](traffic.md).

LAN quiet delivery is a distinct authenticated dm-quiet operation. Old receivers reject
it before storing. LAN JSON describes the remote commit; an unanswered request is
stored:null, wake:unknown, exit 3, never a known unstored failure.

## OpenCode 2.2.1+

`ocs skill install` installs a local V2 plugin. The canonical address is
`opencode-<full ses_ ID>`; `oc-<8hex>` hashes the full ID rather than truncating its
time prefix. Session IDs remain case-sensitive in route sidecars and name records.
No fields are added to `OcsMessage v1`.

Only sessions observed by the plugin's prompt/context/tool hooks register. Each
registration has a private socket (or a random Windows pipe), live process ID and
runtime token. The shell hook gets identity from the tool invocation's async context,
never a mutable process-wide "current session". DM replies retain the ordinary
`Reply:` / `Thread:` envelope and do not imply user authorization.

The receiver calls `session.prompt` with `delivery: "queue"` and source metadata.
Only matching native queue admission produces the local `queued` acknowledgement.
Errors after submitting the prompt, malformed acknowledgements or lost responses
remain unknown; no fallback, automatic replay or session creation is allowed.
The durable OCS channel remains available through inbox/read. Queue acceptance
proves neither model consumption nor task completion. V1 is outside this adapter's
supported API contract.
