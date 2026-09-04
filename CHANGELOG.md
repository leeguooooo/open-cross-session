# Changelog

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
