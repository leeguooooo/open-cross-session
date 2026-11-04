import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALLER = join(import.meta.dir, "..", "install.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixture(npxExit = 0): {
  root: string;
  curlLog: string;
  env: Record<string, string>;
  npxLog: string;
  binaryLog: string;
  installDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ocs-install-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  const installDir = join(root, "install");
  const npxLog = join(root, "npx.log");
  const binaryLog = join(root, "binary.log");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "uname"), `#!/bin/sh
if [ "\${1:-}" = "-s" ]; then echo Darwin; else echo arm64; fi
`);
  executable(join(bin, "curl"), `#!/bin/sh
out=""
head=0
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -fsSI) head=1; shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$INSTALL_TEST_CURL_LOG"
if [ "$head" = 1 ]; then
  printf 'HTTP/2 302\\r\\nLocation: %s\\r\\ncontent-length: 0\\r\\n\\r\\n' "$INSTALL_TEST_LATEST_LOCATION"
  exit 0
fi
case "$out" in
  *.sha256) printf '%s\\n' 'deadbeef  archive' > "$out" ;;
  *) printf '%s\\n' 'archive' > "$out" ;;
esac
`);
  executable(join(bin, "shasum"), `#!/bin/sh
printf '%s\\n' 'deadbeef  archive'
`);
  executable(join(bin, "tar"), `#!/bin/sh
dest=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then dest="$2"; shift 2; else shift; fi
done
printf '%s\\n' '#!/bin/sh' \\
  'case "$1" in' \\
  '  help) exit 0 ;;' \\
  '  version) echo "ocs 0.4.2" ;;' \\
  '  skill) echo "$*" >> "$INSTALL_TEST_BINARY_LOG" ;;' \\
  'esac' > "$dest/ocs"
chmod +x "$dest/ocs"
`);
  executable(join(bin, "npx"), `#!/bin/sh
printf '%s\\n' "$*" > "$INSTALL_TEST_NPX_LOG"
exit "\${INSTALL_TEST_NPX_EXIT:-0}"
`);
  return {
    root,
    curlLog: join(root, "curl.log"),
    npxLog,
    binaryLog,
    installDir,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      OCS_INSTALL_DIR: installDir,
      OCS_INSTALL_SKILLS: "1",
      OCS_SKILLS_CLI_VERSION: "1.5.23",
      INSTALL_TEST_NPX_LOG: npxLog,
      INSTALL_TEST_BINARY_LOG: binaryLog,
      INSTALL_TEST_NPX_EXIT: String(npxExit),
      INSTALL_TEST_CURL_LOG: join(root, "curl.log"),
      INSTALL_TEST_LATEST_LOCATION: "https://github.com/leeguooooo/open-cross-session/releases/tag/v0.4.2",
    } as Record<string, string>,
  };
}

async function run(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["/bin/sh", INSTALLER], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

describe("curl installer skill setup", () => {
  test("pins skills add to the downloaded ocs version and targets Claude, Codex, Pi, and OpenCode", async () => {
    const f = fixture();
    const result = await run(f.env);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(join(f.installDir, "ocs"))).toBe(true);
    expect(readFileSync(f.npxLog, "utf8").trim()).toBe(
      "-y skills@1.5.23 add https://github.com/leeguooooo/open-cross-session/tree/v0.4.2/skills/ocs " +
        "--skill ocs --global --agent claude-code --agent codex --agent pi --agent opencode --yes",
    );
    expect(readFileSync(f.binaryLog, "utf8").trim()).toBe("skill install");
    expect(result.stdout).toContain("skill registered via skills CLI (source: v0.4.2)");
  });

  test("skills CLI failure keeps the binary install and runs the embedded fallback", async () => {
    const f = fixture(1);
    const result = await run(f.env);
    expect(result.code).toBe(0);
    expect(existsSync(join(f.installDir, "ocs"))).toBe(true);
    expect(readFileSync(f.binaryLog, "utf8").trim()).toBe("skill install");
    expect(result.stderr).toContain("skills CLI failed; using the embedded skill installer");
  });

  test("OCS_INSTALL_SKILLS=0 installs only the binary", async () => {
    const f = fixture();
    f.env.OCS_INSTALL_SKILLS = "0";
    const result = await run(f.env);
    expect(result.code).toBe(0);
    expect(existsSync(join(f.installDir, "ocs"))).toBe(true);
    expect(existsSync(f.npxLog)).toBe(false);
    expect(existsSync(f.binaryLog)).toBe(false);
    expect(result.stdout).toContain("skill installation skipped (OCS_INSTALL_SKILLS=0)");
  });
});

describe("curl installer release pinning", () => {
  const DL = "https://github.com/leeguooooo/open-cross-session/releases/download";

  test("resolves the latest tag once, then fetches archive and checksum from that tag", async () => {
    const f = fixture();
    f.env.OCS_INSTALL_SKILLS = "0";
    const result = await run(f.env);
    expect(result.code).toBe(0);
    expect(readFileSync(f.curlLog, "utf8").trim().split("\n")).toEqual([
      "https://github.com/leeguooooo/open-cross-session/releases/latest",
      `${DL}/v0.4.2/ocs-darwin-arm64.tar.gz`,
      `${DL}/v0.4.2/ocs-darwin-arm64.tar.gz.sha256`,
    ]);
  });

  test("OCS_VERSION pins the release without asking for latest", async () => {
    const f = fixture();
    f.env.OCS_INSTALL_SKILLS = "0";
    f.env.OCS_VERSION = "0.4.2";
    expect((await run(f.env)).code).toBe(0);
    expect(readFileSync(f.curlLog, "utf8").trim().split("\n")).toEqual([
      `${DL}/v0.4.2/ocs-darwin-arm64.tar.gz`,
      `${DL}/v0.4.2/ocs-darwin-arm64.tar.gz.sha256`,
    ]);
  });

  test("a redirect to another project or a non-version tag fails before downloading", async () => {
    for (const location of [
      "https://github.com/someone-else/open-cross-session/releases/tag/v0.4.2",
      "https://github.com/leeguooooo/open-cross-session/releases/tag/v0.4.2-rc.1",
      "",
    ]) {
      const f = fixture();
      f.env.INSTALL_TEST_LATEST_LOCATION = location;
      const result = await run(f.env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("could not determine the ocs release to install");
      expect(readFileSync(f.curlLog, "utf8").trim().split("\n")).toHaveLength(1);
      expect(existsSync(join(f.installDir, "ocs"))).toBe(false);
    }
  });

  test("a binary whose version differs from the pinned tag is not installed", async () => {
    const f = fixture();
    f.env.OCS_VERSION = "0.4.3";
    const result = await run(f.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("downloaded binary reports version 0.4.2, expected 0.4.3");
    expect(existsSync(join(f.installDir, "ocs"))).toBe(false);
  });
});
