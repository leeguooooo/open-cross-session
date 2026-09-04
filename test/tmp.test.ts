import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cleanupTempDirs, tempDir } from "./tmp";

afterEach(() => cleanupTempDirs());

describe("temporary test directory cleanup", () => {
  test("removes every registered directory", () => {
    const first = tempDir("ocs-tmp-helper-");
    const second = tempDir("ocs-tmp-helper-");

    cleanupTempDirs();

    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  test("reports failures and keeps their paths for a later retry", () => {
    const dir = tempDir("ocs-tmp-helper-");

    expect(() => cleanupTempDirs(() => {
      throw new Error("busy");
    })).toThrow(`failed to clean 1 temporary test directory: ${dir}`);
    expect(existsSync(dir)).toBe(true);

    cleanupTempDirs();
    expect(existsSync(dir)).toBe(false);
  });
});
