# Open Cross-session — 设计文档

当前架构以本仓库为正本。操作约束见 [CLAUDE.md](CLAUDE.md)，消息和唤醒协议见 [docs/wake-protocol.md](docs/wake-protocol.md)。

## 定位与边界

OCS 负责跨厂商、跨会话的消息记录、寻址和唤醒。同机使用本地日志与宿主载体；跨机使用用户显式配对的局域网连接，异地可通过 Tailscale / WireGuard 等虚拟局域网接入。

Session Flow 负责创建工作会话、隔离 worktree、任务依赖、模型选择和工作流完成条件。OCS 不把发送成功、目标空闲或唤醒接受解释为任务完成。

AgentParty 已停止维护。原定抽取公共包、向 AgentParty 单向同步及托管升级的路线已作废。本仓库直接维护原 vendored 模块；文件中的版权、许可证和历史出处保留。历史抽取记录见 [docs/agentparty-extraction-map.md](docs/agentparty-extraction-map.md)。

## 消息与身份

消息先进入本机 per-channel append-only JSONL 日志，再尝试唤醒。每个频道的 seq 只在日志锁内从日志推导，不维护另一份序号缓存。陈锁通过原子 rename 认领。

`OcsMessage v1` 严格校验字段。路由和投递回执使用旁车帧，旧版本可跳过旁车并读取原消息。统计和接入能力不添加到消息 v1 中。

同机 DM 采用可验证的宿主身份；唯一的 Claude 工作区可保持稳定频道。短 ID 有歧义时必须使用完整 ID；Codex 的完整 thread UUID 才能精确标识会话。重启后的 inbox 只展示能够归属于当前身份的线程，不扫描私信名称猜身份。

## 唤醒载体

| 目标 | 载体 | 忙碌行为与边界 |
|---|---|---|
| Claude Code | 原生收件箱 socket 与回执 helper | 保留原生来源与权限闸；accept 不发已读证明，hold/refuse 等回执可报告未送达；Windows 暂无回执 |
| Codex Desktop | 被 renderer 认领的原生 IPC | 保留 delegation 来源信封；私有协议运行时探测，结果未知绝不降级补发 |
| Codex 终端 | 官方 queue，运行中可尝试 steer | 用 rollout FD 持有者及进程身份证明活性；不能 steer 时在宿主入队前合并积压 |
| Pi | 官方扩展 API 与私有 socket | follow-up 排在当前回合之后 |
| Hermes | 本地宿主 WebSocket | 使用 queued:true；每次重读凭据并查询活动会话 |
| Grok Build | 现有共享 leader 的原生 IPC | 完整会话 UUID 寻址；sendNow:false 排队；精确 prompt ID 接纳后才报 accepted，写出后无确认为 unknown |
| Antigravity agy | 可选 headless 接收端 | SQLite 队列串行执行，每频道保存 conversation ID，最终结果自动回传 |
| cmux | 可选终端 surface | 仅在精确匹配可验证时使用，不是硬依赖 |

宿主接入失败时消息仍留在日志。未知结果不可重放；只在明确未投递时使用允许的降级路径。Desktop delegation 的载体任务可能不是实际发送者，真实来源始终保留在消息正文中。

## 减少无效交流

普通任务、答案、阻塞和最终结果保持正常唤醒。skill 和唤醒信封要求停止无请求的确认、谢谢与重复完成回信。`--no-wake` 只记录消息，适用于收件方会主动读取的记录。

显式 `--batch <tasks.json>` 将相关任务的 JSON 字符串数组完整装入一条普通消息，对每个目标走一次投递流程。不会分析或删除任务，不会跨频道自动合并，不改写任务间的依赖。长消息仍遵守唤醒载荷上限，收件方须从日志读取完整正文。

Codex 忙时合并仍只控制通知：取走积压后按读游标过滤，未读消息合成一次投递。已取走的一批即使结果未知也不能补发；正文一直保留在频道日志。

## 可观察性

`who --json` 给每个候选附带版本化 capabilities：当次观察到的唤醒可用性、busyDelivery、noWake、batch 和回执能力。它不保证后续投递，也不证明权限获批。远端旧版本可能不提供这些字段；跨机不宣称支持未回传的终态回执。

`stats [channel] --json` 读取本机私有诊断记录，分别报告消息级结果、目标投递流程结果、显式批量和 Codex 合并计数。开始投递前记录 unknown，完成后更新；中途崩溃保持 unknown。统计不保存正文、凭据或 PID，不控制 seq、重试或投递，统计写入失败不改变发送结果。

统计只覆盖新版本实际观察到的活动，不回推旧历史，不把 accepted 当成已读，不把投递次数当成模型回合数、token 或费用。不同机器分别统计自身观察，不应直接相加当作唯一消息总数。

## 局域网

默认关闭，配对才授权。Ed25519 标识机器；握手使用签名覆盖的临时 X25519 密钥交换，记录层使用 AES-256-GCM。地址发现只是连接提示，必须先验证钉住的公钥再发送身份或任务。配对流程与临时信任、次数配额见 [docs/lan.md](docs/lan.md)。

远端只允许给可验证的本机地址派发，不允许随意创建频道。远端发送者在本机显示为 `x@peer`，日志保持旧消息格式。两端分别落盘和生成 seq，不复制多方频道。

`dm --json` 的 channel/seq 描述已确认的远端提交；本机副本只是历史记录。请求发出后没有可靠应答时，stored:null、wake:unknown、退出 3，不允许重发。

跨机静默投递使用独立 `dm-quiet` 操作，与普通 DM 共用身份、限流、配额和路由校验。旧接收端拒绝未知操作，不会因忽略新字段而意外唤醒。

## 发布与兼容

CLI 通过 GitHub Release 发布平台二进制和校验文件，不使用 npm registry。macOS 编译产物须签名并验证，Windows 批处理脚本保持 CRLF。

新增接入必须保持来源清晰、权限不扩大、消息先落盘、unknown 不重放。真实宿主验收与测试替身验收分别报告；本地源码和构建通过不等于公开 Release 已更新。
