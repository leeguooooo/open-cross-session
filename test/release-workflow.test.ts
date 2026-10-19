import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("release workflow signs and smokes macOS binaries before packaging", () => {
  const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
  const sign = workflow.indexOf("codesign --force --sign - ocs");
  const verify = workflow.indexOf("codesign --verify --deep --strict --verbose=4 ocs");
  const smoke = workflow.indexOf("run: ./ocs help");
  const archive = workflow.indexOf("tar -czf ${{ matrix.asset }}.tar.gz ocs");
  expect(workflow).toContain("os: macos-26\n            target: bun-darwin-arm64");
  expect(workflow).toContain("os: macos-26-intel\n            target: bun-darwin-x64");
  expect(sign).toBeGreaterThan(0);
  expect(verify).toBeGreaterThan(sign);
  expect(smoke).toBeGreaterThan(verify);
  expect(archive).toBeGreaterThan(smoke);
});

test("release workflow Developer ID-signs and notarizes macOS binaries when secrets exist", () => {
  const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
  const sign = workflow.indexOf("codesign --force --options runtime --timestamp --entitlements scripts/entitlements.plist");
  const notarize = workflow.indexOf("xcrun notarytool submit");
  const gatekeeper = workflow.indexOf("spctl -a -vvv -t install ocs");
  const smoke = workflow.indexOf("run: ./ocs help");
  expect(workflow).toContain("if: runner.os == 'macOS' && env.HAS_SIGNING == 'true'");
  expect(workflow).toContain("if: runner.os == 'macOS' && env.HAS_SIGNING != 'true'");
  expect(sign).toBeGreaterThan(0);
  expect(notarize).toBeGreaterThan(sign);
  expect(gatekeeper).toBeGreaterThan(notarize);
  expect(smoke).toBeGreaterThan(gatekeeper);
  // hardened runtime 下 bun 的 JIT 必需；少了这两项签好的二进制一启动就被杀
  const entitlements = readFileSync(join(import.meta.dir, "..", "scripts", "entitlements.plist"), "utf8");
  expect(entitlements).toContain("com.apple.security.cs.allow-jit");
  expect(entitlements).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
});

test("release workflow builds, smokes, and checksums the Windows binary on real Windows", () => {
  const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
  const win = workflow.slice(workflow.indexOf("  windows:"));
  expect(win).toContain("runs-on: windows-latest");
  const build = win.indexOf("--target=bun-windows-x64 src/cli.ts --outfile ocs.exe");
  const smoke = win.indexOf("./ocs.exe help");
  const zip = win.indexOf("7z a -tzip ocs-windows-x64.zip ocs.exe");
  const sum = win.indexOf("sha256sum ocs-windows-x64.zip > ocs-windows-x64.zip.sha256");
  expect(build).toBeGreaterThan(0);
  expect(smoke).toBeGreaterThan(build);
  expect(zip).toBeGreaterThan(smoke);
  expect(sum).toBeGreaterThan(zip);
});

test("macOS CI signs the compiled binary before its smoke test", () => {
  const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
  const build = workflow.indexOf("bun build --compile src/cli.ts --outfile /tmp/ocs");
  const sign = workflow.indexOf("codesign --force --sign - /tmp/ocs");
  const verify = workflow.indexOf("codesign --verify --deep --strict --verbose=4 /tmp/ocs");
  const smoke = workflow.indexOf("/tmp/ocs help");
  expect(build).toBeGreaterThan(0);
  expect(sign).toBeGreaterThan(build);
  expect(verify).toBeGreaterThan(sign);
  expect(smoke).toBeGreaterThan(verify);
});

test("every release carries notes from CHANGELOG.md (no more empty release pages)", () => {
  const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
  expect(workflow).not.toContain('--notes ""');
  const publish = workflow.slice(workflow.indexOf("  publish:"));
  expect(publish).toContain("needs: [binaries, windows]");
  expect(publish).toContain('scripts/release-notes.sh "$RELEASE_TAG" > release-notes.md');
  expect(publish).toContain('--verify-tag --draft --title "$RELEASE_TAG" --notes-file release-notes.md');
  expect(publish.indexOf('sha256sum -c')).toBeLessThan(publish.indexOf('gh release create'));
  expect(workflow.slice(0, workflow.indexOf("  publish:"))).not.toContain('gh release create');
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const version = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version;
  const notes = spawnSync("sh", ["scripts/release-notes.sh", `v${version}`], { cwd: join(import.meta.dir, ".."), encoding: "utf8" });
  expect(notes.status).toBe(0);
  expect(notes.stdout).toContain("install.ps1");
  expect(spawnSync("sh", ["scripts/release-notes.sh", "v99.0.0"], { cwd: join(import.meta.dir, ".."), encoding: "utf8" }).status).toBe(1);
});
