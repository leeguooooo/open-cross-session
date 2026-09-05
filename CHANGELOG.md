# Changelog

## Unreleased

- Codex Desktop 明确不可投递时，自动降级唤醒唯一匹配的空闲 cmux Codex surface；匹配会验证标题 task 短 ID 与活 Codex 进程，陈旧 shell、多匹配和 IPC `unknown-outcome` 均 fail closed（#30）

## v0.4.2

- 发送输出明确区分 `stored` 与 wake 结果；唤醒失败返回退出码 2、结果未知返回退出码 3，并提醒消息已落盘、不可重发
- `send --codex` 与 `--codex-source` 直接接受 `ocs who` 展示的 `codex-<8hex>` 短地址；无效或歧义地址在消息落盘前失败
- CLI help、README 与安装 skill 补齐 ChatGPT Desktop 的第二个同 renderer source task 前置条件
- 明确跨机器边界：托管协作用 Agent Party；已有免密 SSH 时由控制端直接调用 workbox 上的本地 OCS/Herdr，不在 OCS 增加远程 runtime
- 测试临时目录统一按用例清理，删除失败会保留路径重试并使测试可见地失败；全量测试不再净增 `ocs-*` 残留

## v0.4.1

- Codex roster 只展示被 ChatGPT Desktop renderer 实际认领的 open task，不再把本地 rollout 历史误报成可达
- Codex target/source owner 改为并发短探测；未打开任务约 1 秒内明确报告消息已存储、可用 `ocs inbox`，不再串行等待 10 秒超时
- `ocs doctor` 分开报告 IPC router socket、当前 task renderer ownership 与 rollout 历史，避免 socket 存在被误解为端到端可唤醒

## v0.4.0

- `ocs who` 默认把当前项目放前面，用 `codex-<8hex>` / `pi-<8hex>` 短地址隐藏完整 UUID；`--verbose` 和 `--json` 按需展开
- Codex 通过宿主 thread id 自动识别发送者，Claude/Codex/Pi 日常发送都不再要求 `--as`
- 新增 `ocs inbox`：只列能由 route sidecar 或既有 cursor 证明归属的未读线程；稳定身份 cursor 支持 Claude 重启改名后续读，不猜测、不枚举其他私信
- 活 Claude/Codex/Pi 的 `Reply:` / `Thread:` 命令不再携带多余 `--as`；`send --reply-to` 会在回复者身份匹配时安全反转父消息 route，让回复进入原发送者 inbox
- `ocs doctor --fix` 同步修复三端 skill、Pi 扩展和数据目录权限；原子替换旧 skill，不沿符号链接改写共享缓存
- 支持常见的 `ocs --help`；修复 macOS 测试临时路径过长导致 Pi UDS 用例失败
- Release workflow 对 macOS 二进制重新做 ad-hoc codesign，并在打包前运行真实二进制 smoke test，避免无效签名被系统以 SIGKILL 拒绝执行

## v0.3.6

- 支持 Pi TUI：`ocs skill install` 同时安装 Pi skill 与直投扩展；`ocs who` 列出活会话，`ocs dm pi-<session-id>`、`@pi-<session-id>` 和 `--reply-to` 可直接唤醒
- Pi 忙碌时把跨会话消息排成 `followUp`，不打断当前工具调用；每个会话使用 0600 UDS、随机令牌和独立 `pi:` 身份命名空间
- `ocs doctor` 增加 Pi 扩展版本与活会话检查
- curl 安装完成后自动用 `skills` CLI 给 Claude Code、Codex、Pi 注册同版本 skill；关闭 telemetry，失败时改用二进制内置安装

## v0.2.0

- **`ocs who`**：全机 agent 花名册——Claude 会话、Codex 任务、cmux 终端一张表，自动标出你自己
- **`ocs dm <目标> <内容>`**：直发一个 agent，频道自动派生、载体自动选（UDS / Desktop IPC / cmux）
- **身份自动识别**：在 Claude 会话里 `--as` 可省略（进程祖先链推断；`OCS_NAME` 可覆盖）；`ocs whoami` 查看
- **cmux 第三载体**：探测到 cmux 时可唤醒终端里的 codex/claude TUI（按 surface 寻址；忙碌不打扰）；仍是可选加速器，绝不必装
- **`ocs skill install`**：给 Claude Code 装 ocs 技能，对任何会话说「找个 agent 商量」即可触发

## v0.1.2

- `@<codex-thread-id>` 自动路由到 ChatGPT Desktop IPC，不再要求记 `--codex` 语法
- codex 唤醒归因修复：target/source 分开探测、报错各自点名；自动选 source 逐候选跳过未打开的 rollout
- 自我唤醒防回环改为沿进程祖先链定位本会话（`process.ppid` 在 Bash 工具链路下失效）
- CLI 输出国际化：英文 canonical，`OCS_LANG`/locale 选中文；唤醒指针双语
- `ocs doctor --fix` 一键设 `crossSessionInbound=accept`（写前备份）；doctor 增加 cmux 可选加速器探测
- 对抗式审查修复 12 条（codex-ping 全仓审查，均有回归测试）：
  - 非法 `--reply-to` 写出永久不可读行；崩溃半行吞掉下一条消息
  - 空内容陈锁永久死锁；stale-break inode 校验 + 写后自校验堵双持锁竞态
  - 日志 EACCES 被伪装成空频道；游标并发回退（锁内比较 + 原子写）
  - owner 探测把传输故障误报成「任务未打开」；source 候选上限 10→50
  - 命令级参数 schema：缺值/未知 flag/多余参数必须报错（`--codex` 缺值曾静默吞掉）
  - install.sh 校验 fail-closed + sha256sum 兼容；冒烟通过前不覆盖旧二进制
- `ocs version`；双语 README（[English](./README.md) / [中文](./README.zh-CN.md)）

## v0.1.1

- `@<codex-thread-id>` 分流与祖先链防回环首版（详见 v0.1.2 收尾）

## v0.1.0

- 首个公开版本：本地频道日志（多进程安全单调 seq）、Claude 收件箱 socket 注入、
  ChatGPT Desktop 原生跨任务 IPC、`doctor` 体检、`upgrade` 迁移指引
- 三平台二进制（macOS arm64/x64、Linux x64）+ `install.sh`
