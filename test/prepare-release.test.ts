import { expect, test } from "bun:test";
import { prepareRelease } from "../scripts/prepare-release.ts";
const pkg = '{"version":"0.9.0"}';
const cli = 'export const OCS_VERSION = "0.9.0";\n';
const notes = '# Changelog\n\n## Unreleased\n\n- Fix routing\n\n## 0.9.0\n\n- Previous release\n';
test("release keeps CLI, package, notes and tag aligned; second run is a no-op", () => {
  const result = prepareRelease(pkg, cli, notes, "v0.9.0")!;
  expect(result.tag).toBe("v0.9.1");
  expect(JSON.parse(result.packageText).version).toBe("0.9.1");
  expect(result.cli).toContain('OCS_VERSION = "0.9.1"');
  expect(result.changelog).toContain("## Unreleased\n\n## 0.9.1\n\n- Fix routing\n\n## 0.9.0");
  expect(prepareRelease(result.packageText, result.cli, result.changelog, result.tag)).toBeNull();
});
test("empty unreleased section does not manufacture a release", () => {
  expect(prepareRelease(pkg, cli, notes.replace('- Fix routing', ''), 'v0.9.0')).toBeNull();
});
test("rejects drift, missing notes heading and duplicate versions before writing", () => {
  expect(() => prepareRelease(pkg, cli, notes, 'v0.9.1')).toThrow('latest stable tag');
  expect(() => prepareRelease(pkg, '', notes, 'v0.9.0')).toThrow('OCS_VERSION');
  expect(() => prepareRelease(pkg, cli, notes.replace('Unreleased', 'Draft'), 'v0.9.0')).toThrow('Unreleased');
  expect(() => prepareRelease(pkg, cli, notes + '\n## 0.9.1\nold\n', 'v0.9.0')).toThrow('already exists');
});
