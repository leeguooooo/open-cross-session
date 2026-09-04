#!/bin/sh
# open-cross-session installer — GitHub Release 二进制，零 token。
#   curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh
set -eu

REPO="leeguooooo/open-cross-session"
INSTALL_DIR="${OCS_INSTALL_DIR:-$HOME/.local/bin}"
SKILLS_CLI_VERSION="${OCS_SKILLS_CLI_VERSION:-1.5.23}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os-$arch" in
  darwin-arm64) asset="ocs-darwin-arm64" ;;
  darwin-x86_64) asset="ocs-darwin-x64" ;;
  linux-x86_64) asset="ocs-linux-x64" ;;
  *) echo "unsupported platform: $os-$arch" >&2; exit 1 ;;
esac

url="https://github.com/$REPO/releases/latest/download/$asset.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "downloading $url"
curl -fsSL "$url" -o "$tmp/$asset.tar.gz"
# 校验 fail closed：发布流程固定附带 .sha256，拿不到或对不上都必须失败，
# 绝不静默跳过完整性校验。
curl -fsSL "$url.sha256" -o "$tmp/$asset.tar.gz.sha256"
expected=$(awk '{print $1}' "$tmp/$asset.tar.gz.sha256")
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$asset.tar.gz" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset.tar.gz" | awk '{print $1}')
else
  echo "neither shasum nor sha256sum found; cannot verify download" >&2
  exit 1
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "sha256 mismatch: expected $expected got $actual" >&2
  exit 1
fi

tar -xzf "$tmp/$asset.tar.gz" -C "$tmp"
chmod +x "$tmp/ocs"
# 冒烟通过前不动现有安装；staging 放同一目录内，rename 才是原子的。
"$tmp/ocs" help >/dev/null || { echo "downloaded binary failed smoke test" >&2; exit 1; }
mkdir -p "$INSTALL_DIR"
staged="$INSTALL_DIR/.ocs.staged.$$"
mv "$tmp/ocs" "$staged"
mv -f "$staged" "$INSTALL_DIR/ocs"

echo "installed: $INSTALL_DIR/ocs"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "note: add $INSTALL_DIR to your PATH" ;;
esac

# Install the same versioned ocs skill for Claude Code, Codex, and Pi. The
# skills CLI is optional: the binary has an embedded fallback and also installs
# Pi's runtime extension, which a SKILL.md package cannot provide by itself.
if [ "${OCS_INSTALL_SKILLS:-1}" != "0" ]; then
  ocs_version=$("$INSTALL_DIR/ocs" version | awk 'NR == 1 { print $2 }')
  skill_source="https://github.com/$REPO/tree/v$ocs_version/skills/ocs"
  if command -v npx >/dev/null 2>&1; then
    echo "installing ocs skill for Claude Code, Codex, and Pi"
    if DISABLE_TELEMETRY=1 npx -y "skills@$SKILLS_CLI_VERSION" add "$skill_source" \
      --skill ocs --global \
      --agent claude-code --agent codex --agent pi --yes </dev/null; then
      echo "skill registered via skills CLI (source: v$ocs_version)"
    else
      echo "warning: skills CLI failed; using the embedded skill installer" >&2
    fi
  else
    echo "note: npx not found; using the embedded skill installer" >&2
  fi
  if ! "$INSTALL_DIR/ocs" skill install </dev/null; then
    echo "warning: ocs installed, but skill/Pi extension setup failed; rerun: ocs skill install" >&2
  fi
else
  echo "note: skill installation skipped (OCS_INSTALL_SKILLS=0)"
fi
echo "ok: run \`ocs doctor\` to get started"
