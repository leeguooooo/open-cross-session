// Claude 原生会话名是一次性地址；这里提供只面向当前活会话的工作区别名。
// 别名从 Claude 自己写入 sessions JSON 的绝对 cwd 推导，不持久化新身份，不合并历史。

import { basename, isAbsolute } from "node:path";
import type { NativeClaudeSession } from "./claude-inject.ts";
import { NAME_RE } from "./store.ts";

export function claudeWorkspaceAlias(session: NativeClaudeSession): string | null {
  if (typeof session.cwd !== "string" || !isAbsolute(session.cwd)) return null;
  const alias = basename(session.cwd);
  return NAME_RE.test(alias) ? alias : null;
}

/**
 * 一个可放进 Reply 行的别名必须同时满足：只有这一个活会话使用该工作区别名，
 * 且没有另一个活会话把别名本身当作精确原生名。否则 `ocs dm <alias>` 会先命中那个精确名。
 */
export function uniqueClaudeWorkspaceAlias(
  self: NativeClaudeSession,
  sessions: readonly NativeClaudeSession[],
): string | null {
  const alias = claudeWorkspaceAlias(self);
  if (alias === null) return null;
  const workspaceOwners = sessions.filter((session) => claudeWorkspaceAlias(session) === alias);
  if (workspaceOwners.length !== 1 || workspaceOwners[0]!.pid !== self.pid) return null;
  const exactNameCollision = sessions.some((session) => session.pid !== self.pid && session.name === alias);
  return exactNameCollision ? null : alias;
}

/** 只按完整工作区别名匹配；不猜测 `*-<suffix>`，避免把人工命名投给别人。 */
export function claudeWorkspaceTargetMatches(session: NativeClaudeSession, target: string): boolean {
  const alias = claudeWorkspaceAlias(session);
  return alias !== null && target === alias;
}
