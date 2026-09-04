import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = new URL(".", import.meta.url).pathname;

// #24 的回归守卫：临时目录泄漏是靠「每个测试文件自己挂 autoCleanupTempDirs()」
// 修好的，帮助模块里挂不生效（bun 的 afterEach 只作用于调用它的文件）。这意味着
// 新增测试文件时漏调一次就悄悄恢复泄漏，没有任何报错。这里从源码上钉死两件事。
describe("临时目录清理（#24）", () => {
  const sources = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => ({ name, source: readFileSync(join(TEST_DIR, name), "utf8") }));

  test("不得裸用 mkdtempSync 而不自行清理", () => {
    const offenders = sources
      .filter(({ source }) => source.includes("mkdtempSync(") && !source.includes("rmSync("))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  // 顶层 autoCleanupTempDirs() 是常规写法；helper 自己的测试直接调 cleanupTempDirs()
  // 也算数，两者都会把目录删掉。
  test("用了 tempDir() 的文件必须挂上清理", () => {
    const offenders = sources
      .filter(({ source }) => source.includes("tempDir("))
      .filter(({ source }) => !source.includes("autoCleanupTempDirs()") && !source.includes("cleanupTempDirs("))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });
});
