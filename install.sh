#!/bin/sh
# open-cross-session installer — GitHub Release 二进制，零 token。
#   curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh
set -eu

REPO="leeguooooo/open-cross-session"
INSTALL_DIR="${OCS_INSTALL_DIR:-$HOME/.local/bin}"

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
curl -fsSL "$url.sha256" -o "$tmp/$asset.tar.gz.sha256" || true
if [ -s "$tmp/$asset.tar.gz.sha256" ]; then
  (cd "$tmp" && shasum -a 256 -c "$asset.tar.gz.sha256" >/dev/null) || {
    echo "sha256 mismatch" >&2; exit 1
  }
fi

mkdir -p "$INSTALL_DIR"
tar -xzf "$tmp/$asset.tar.gz" -C "$tmp"
mv "$tmp/ocs" "$INSTALL_DIR/ocs"
chmod +x "$INSTALL_DIR/ocs"

echo "installed: $INSTALL_DIR/ocs"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "note: add $INSTALL_DIR to your PATH" ;;
esac
"$INSTALL_DIR/ocs" help >/dev/null && echo "ok: run \`ocs doctor\` to get started"
