import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_MD } from "../src/cli.ts";

test("skills/ocs/SKILL.md stays byte-for-byte aligned with the binary fallback", () => {
  const published = readFileSync(join(import.meta.dir, "..", "skills", "ocs", "SKILL.md"), "utf8");
  expect(published).toBe(SKILL_MD);
});
