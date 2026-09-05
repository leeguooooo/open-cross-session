import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const TEST_DIR = new URL(".", import.meta.url).pathname;
type TestSource = { name: string; source: string };

function calledFunctionNames(source: string): Set<string> {
  const parsed = ts.createSourceFile("guard-input.test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) names.add(node.expression.text);
      else if (ts.isPropertyAccessExpression(node.expression)) names.add(node.expression.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return names;
}

function bareMkdtempSources(candidates: readonly TestSource[]): string[] {
  return candidates
    .filter(({ source }) => {
      const calls = calledFunctionNames(source);
      return calls.has("mkdtempSync") && !calls.has("rmSync");
    })
    .map(({ name }) => name);
}

function unguardedTempDirSources(candidates: readonly TestSource[]): string[] {
  return candidates
    .filter(({ source }) => {
      const calls = calledFunctionNames(source);
      return calls.has("tempDir") && !calls.has("autoCleanupTempDirs") && !calls.has("cleanupTempDirs");
    })
    .map(({ name }) => name);
}

// #24 的回归守卫：临时目录泄漏是靠「每个测试文件自己挂 autoCleanupTempDirs()」
// 修好的，帮助模块里挂不生效（bun 的 afterEach 只作用于调用它的文件）。这意味着
// 新增测试文件时漏调一次就悄悄恢复泄漏，没有任何报错。这里从源码上钉死两件事。
describe("临时目录清理（#24）", () => {
  const sources = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => ({ name, source: readFileSync(join(TEST_DIR, name), "utf8") }));

  test("不得裸用 mkdtempSync 而不自行清理", () => {
    expect(bareMkdtempSources(sources)).toEqual([]);
  });

  // 顶层 autoCleanupTempDirs() 是常规写法；helper 自己的测试直接调 cleanupTempDirs()
  // 也算数，两者都会把目录删掉。
  test("用了 tempDir() 的文件必须挂上清理", () => {
    expect(unguardedTempDirSources(sources)).toEqual([]);
  });

  test("注释或字符串里的清理函数名不能骗过守卫", () => {
    const fakeMkdtempCleanup = [{
      name: "comment-only-rm.test.ts",
      source: `mkdtempSync("prefix-"); // rmSync("not-really-called")\nconst decoy = "rmSync(";`,
    }];
    const fakeHelperCleanup = [{
      name: "literal-only-helper.test.ts",
      source: `tempDir("prefix-"); /* autoCleanupTempDirs() */\nconst decoy = "cleanupTempDirs(";`,
    }];
    expect(bareMkdtempSources(fakeMkdtempCleanup)).toEqual(["comment-only-rm.test.ts"]);
    expect(unguardedTempDirSources(fakeHelperCleanup)).toEqual(["literal-only-helper.test.ts"]);
  });
});
