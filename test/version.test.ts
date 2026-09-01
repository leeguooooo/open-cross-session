import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OCS_VERSION } from "../src/cli.ts";

test("OCS_VERSION 与 package.json 一致（发版忘同步会红）", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
    version: string;
  };
  expect(OCS_VERSION).toBe(pkg.version);
});
