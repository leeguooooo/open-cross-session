# Changelog

## v0.1.2

- `@<codex-thread-id>` 自动路由到 ChatGPT Desktop IPC，不再要求记 `--codex` 语法
- codex 唤醒归因修复：target/source 分开探测、报错各自点名；自动选 source 逐候选跳过未打开的 rollout
- 自我唤醒防回环改为沿进程祖先链定位本会话（`process.ppid` 在 Bash 工具链路下失效）
- `ocs version`；双语 README（[English](./README.md) / [中文](./README.zh-CN.md)）

## v0.1.1

- `@<codex-thread-id>` 分流与祖先链防回环首版（详见 v0.1.2 收尾）

## v0.1.0

- 首个公开版本：本地频道日志（多进程安全单调 seq）、Claude 收件箱 socket 注入、
  ChatGPT Desktop 原生跨任务 IPC、`doctor` 体检、`upgrade` 迁移指引
- 三平台二进制（macOS arm64/x64、Linux x64）+ `install.sh`
