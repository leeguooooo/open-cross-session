# CLAUDE.md

## 项目一句话

本地无服务器版 agent party：同机 Claude Code ↔ Codex 互相唤醒/互发消息（`ocs` CLI），向托管版 [Agent Party](https://agentparty.leeguoo.com) 引流。架构与决策记录在 **DESIGN.md**（必读），组件出处细节在 **docs/agentparty-extraction-map.md**。

## 常用命令

```bash
bun install
bun test               # 20 用例：真 UDS 端到端 + 假 IPC 路由器全握手
bunx tsc --noEmit
bun src/cli.ts <cmd>   # 本地跑 CLI（send/read/sessions/codex-sessions/watch/doctor/upgrade）
```

发布：打 `v*` tag 推送 → release workflow 编三平台二进制附 GitHub Release。**不发 npm registry。**

## 铁律（改代码前必知）

1. **seq 单一真值源是频道日志本身**（`store.ts` 锁内从日志尾推导）。别引入独立 seq 文件/缓存——「日志已写、seq 记录未更新」的崩溃窗口会造出重复 seq，读侧去重把后到消息永久遮蔽（已修复过一次，有回归测试）。
2. **锁抢占只许原子 rename 认领**（ESRCH + 锁龄门槛）。unlink 式抢占有双抢竞态。
3. **`isOcsMessage` 校验字段表与 `OcsMessage` 逐字镜像**，新增字段两边同改（漏改=静默丢消息；测试守着）。
4. **Claude 注入 `ok:true` ≠ 已送达**：接收端 `crossSessionInbound` 默认 hold，5 分钟无人 Deliver 静默丢弃。绝不拿 ok 清欠账；doctor 引导用户设 accept。
5. **Codex IPC unknown-outcome 绝不重放**（帧已写出但结果未知是一等错误）。IPC 是 ChatGPT.app 私有协议，宿主升级可能破，失败必须留降级余地。
6. **vendored 文件不是 canonical**：`src/claude-inject.ts`、`src/codex-ipc.ts`、`src/codex-sessions.ts` 来自 AgentParty 主仓（`~/github.com/agentparty`，文件头有标注）。行为疑问对上游；修 bug 考虑回流上游。
7. 唤醒载荷是 **≤512B 的 channel+seq 指针**，正文永远由被唤醒方 `ocs read` 回读。别把正文塞进注入帧。

## 路线（owner 已拍板）

验证跑通后：主仓抽 MIT 的 `packages/cross-session-core`（open-core，主仓保持 BUSL-1.1），本仓转为单向 sync 发行镜像——届时直接改本仓 vendored 文件无效。
