// 测试用临时目录的统一创建与清理（#24）。
//
// 此前各测试各自 mkdtempSync，但只有 pi/install/pi-cli 三个文件做了清理，其余建完就不管。
// 单个目录不大，CI 与本地反复跑之后按千计累积——2026-09-04 这台机器 $TMPDIR 里躺着
// 3150 个 ocs-* 目录，和别的残留一起把磁盘撑到 100%，`ENOSPC` 让 party join、codex runner
// 甚至 shell 钩子全线报错。
//
// 用法：把 `mkdtempSync(join(tmpdir(), "ocs-x-"))` 换成 `tempDir("ocs-x-")`。
// 用法：import { tempDir, autoCleanupTempDirs } from "./tmp"; 顶层调用一次 autoCleanupTempDirs()。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

/** 建一个测试用临时目录，登记后在本用例结束时自动删除。 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

type RemoveTempDir = (dir: string) => void;

function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 立即清掉已登记的目录；失败项保留到下一次清理重试，并在本轮统一报错。 */
export function cleanupTempDirs(remove: RemoveTempDir = removeTempDir): void {
  const failures: Array<{ dir: string; error: unknown }> = [];
  for (const dir of created.splice(0)) {
    try {
      remove(dir);
    } catch (error) {
      created.push(dir);
      failures.push({ dir, error });
    }
  }

  if (failures.length > 0) {
    const paths = failures.map(({ dir }) => dir).join(", ");
    throw new AggregateError(
      failures.map(({ error }) => error),
      `failed to clean ${failures.length} temporary test director${failures.length === 1 ? "y" : "ies"}: ${paths}`,
    );
  }
}

// 清理必须由测试文件自己挂：afterEach/afterAll 只作用于调用它的那个文件的套件，
// 在这个被 import 的帮助模块里调用不生效；process.on("exit") 在 bun test 下也不触发
// （两种都实测过，残留照涨）。所以导出一个注册函数，测试文件顶层调用一次即可。
import { afterEach } from "bun:test";

/** 在调用方文件里注册「每个用例后清掉本文件建的临时目录」。 */
export function autoCleanupTempDirs(): void {
  afterEach(() => cleanupTempDirs());
}
