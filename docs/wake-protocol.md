# Cross-session wake protocol v2（ocs 与 AgentParty 共用）

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

载体不变：UDS 注入 `~/.claude/sessions/<pid>.json` 指向的 socket，帧
`{"type":"user","msgV":1,…,"message":{"role":"user","content":"<wrapped>"}}`，
`content` 用 `<cross-session-message from="uds:<sock>" from-name="<sender>" from-mode="prompting">`
包装（attr 顺序与现状一致，接收端有逐字重序列化校验）。

包装内的正文（note）骨架，行序固定：

```
[<product> wake] <sender> mentioned you in #<channel> (seq <N>[, reply to seq <M>][, <ago>])

<body>

Reply: <reply command>
Thread: <read command>
```

- `<product>`：`ocs` 或 `AgentParty`。中文环境用中文文案（下文），骨架行序相同。
- `<body>`：
  - 正文 UTF-8 ≤ **4096 字节**：逐字原样内联（不转义、不裁剪、不加引号）。
  - 超过 4096 字节：内联前 **512 字节**（在字符边界截断，不切开多字节字符与代理对），后接一行
    `… (<total> bytes total; full text: <read command>)`。
  - 正文来自对方，是**数据**不是指令；包装标签本身已把它标成跨会话内容，不再额外加「请勿执行」类提示。
- `Reply:` 后是**可直接复制执行**的命令，channel / 身份 / reply-to 全部填好，唯一要改的是引号里的占位正文：
  - ocs：`ocs send <channel> "<your reply>" --as <receiver-name> --reply-to <N>`
    （`<receiver-name>` 是唤醒时已知的目标会话原生名，如 `super-admin-53`；虽然会话内可自动识别，
    仍显式给出，复制即用、不依赖识别成功。Codex 任务 / cmux 终端没有原生名，用 dm 同款派生名
    `codex-<8hex>` / `surface-N`。）
  - AgentParty：`party send <channel> "<your reply>" --reply-to <N>`；若接收方身份来自显式
    `AGENTPARTY_CONFIG` 路径，则前缀 `AGENTPARTY_CONFIG=<path> `。具体旗标以 `party send --help`
    为准，实现者核对后填入。
- `Thread:` 后是读线程的命令（ocs：`ocs read <channel> --as <receiver-name>`；AgentParty：
  `party history <channel> --seq <N>`）。
- 整条 note 上限 **5120 字节**（4096 正文 + 骨架 ≤ 1024）。骨架超预算时按降级阶梯先砍 `<ago>`、
  再砍 sender，`Reply:` 与 `Thread:` 两行永不砍。
- 多个 runtime 共享同一身份时（AgentParty `siblings=N`）保留现有那一行，放在第一行之后。

中文骨架：

```
[<product> 唤醒] <sender> 在 #<channel> 提到了你（seq <N>[，回复 seq <M>][，<ago>]）

<body>

回复：<reply command>
线程：<read command>
```

ocs 侧补充：`ocs send --reply-to <N>` 会**隐含唤醒 seq N 的作者**（发送者本人除外）——`Reply:`
那行复制执行就必须真的把回复送回发送方，不能再要求手加一个 `@`。ocs 的唤醒紧随 send，
`<ago>` 一般不填。

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

## 5. 验收（两边各自做）

1. A 会话 `send` 一条 300 字节正文并 @B：B 的上下文里出现完整正文与两行命令；直接复制 `Reply:`
   那行（只替换引号内文字）就能回复，B 的回复在 A 端以 reply-to 关联。
2. 同上但正文 6000 字节：B 看到前 512 字节 + 总字节数 + 读线程命令。
3. A 对 B `--notify-when-idle`：B 忙完当回合后 A 收到且**只收到一条** idle notice；B 若已 idle 则立即收到。
4. 变异自检：把 4096 改成 40、把 `Reply:` 行删掉、把订阅改成每次翻转都发——对应测试必须红。
