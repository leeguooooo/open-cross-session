// 读写 ~/.claude/settings.json 的 crossSessionInbound 键。
//
// 这是唯一允许写 Claude Code 配置的地方，且只在用户显式 `ocs doctor --fix` 时执行
// （注入模块 claude-inject.ts 的红线「绝不写入任何 Claude Code 的文件」不变——那条
// 管的是投递路径，这里是用户主动请求的一次性配置变更，写前先备份）。
// 上游先例：AgentParty #844 接入包同样把 crossSessionInbound 设为 accept。

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const CLAUDE_SETTINGS_PATH_ENV = "OCS_CLAUDE_SETTINGS_PATH";
export const CROSS_SESSION_INBOUND_KEY = "crossSessionInbound";

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CLAUDE_SETTINGS_PATH_ENV];
  if (typeof override === "string" && override !== "" && isAbsolute(override)) return override;
  return join(homedir(), ".claude", "settings.json");
}

export function readCrossSessionInbound(env: NodeJS.ProcessEnv = process.env): unknown {
  try {
    const settings = JSON.parse(readFileSync(claudeSettingsPath(env), "utf8")) as unknown;
    if (typeof settings !== "object" || settings === null) return undefined;
    return (settings as Record<string, unknown>)[CROSS_SESSION_INBOUND_KEY];
  } catch {
    return undefined;
  }
}

export type EnableInboundResult =
  | { changed: false; value: "accept" }
  | { changed: true; backupPath: string | null }
  | { changed: false; error: string };

/**
 * 把 crossSessionInbound 设为 accept。settings.json 已存在则整读→改一键→整写
 * （其余键原样保留），写前复制一份 `.ocs-backup-<ts>`；不存在则创建只含这一键的文件。
 * settings.json 解析失败时拒绝动它——绝不覆盖一份看不懂的配置。
 */
export function enableCrossSessionInbound(
  env: NodeJS.ProcessEnv = process.env,
): EnableInboundResult {
  const path = claudeSettingsPath(env);
  let settings: Record<string, unknown> = {};
  let exists = false;
  try {
    const raw = readFileSync(path, "utf8");
    exists = true;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { changed: false, error: `${path} 不是 JSON 对象，拒绝改写` };
    }
    settings = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { changed: false, error: `${path} 读取/解析失败，拒绝改写：${String(error)}` };
    }
  }
  if (settings[CROSS_SESSION_INBOUND_KEY] === "accept") {
    return { changed: false, value: "accept" };
  }
  let backupPath: string | null = null;
  if (exists) {
    backupPath = `${path}.ocs-backup-${Date.now()}`;
    try {
      copyFileSync(path, backupPath);
    } catch (error) {
      return { changed: false, error: `备份失败，拒绝改写：${String(error)}` };
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  settings[CROSS_SESSION_INBOUND_KEY] = "accept";
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return { changed: true, backupPath };
}
