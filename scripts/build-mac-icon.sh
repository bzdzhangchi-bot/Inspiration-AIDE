#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ICON_DIR="$ROOT_DIR/build/icons"
SOURCE_SVG="$ICON_DIR/app-icon.svg"
ICONSET_DIR="$ICON_DIR/icon.iconset"
SOURCE_PNG="$ICON_DIR/app-icon.png"
TARGET_ICNS="$ICON_DIR/icon.icns"

if [[ ! -f "$SOURCE_SVG" ]]; then
  echo "Missing icon source: $SOURCE_SVG" >&2
  exit 1
fi

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

qlmanage -t -s 1024 -o "$ICON_DIR" "$SOURCE_SVG" >/dev/null 2>&1

if [[ ! -f "$ICON_DIR/app-icon.svg.png" ]]; then
  echo "Failed to render SVG icon with qlmanage" >&2
  exit 1
fi

mv "$ICON_DIR/app-icon.svg.png" "$SOURCE_PNG"

function make_icon() {
  local size="$1"
  local output="$2"
  sips -z "$size" "$size" "$SOURCE_PNG" --out "$ICONSET_DIR/$output" >/dev/null
}

make_icon 16 icon_16x16.png
make_icon 32 icon_16x16@2x.png
make_icon 32 icon_32x32.png
make_icon 64 icon_32x32@2x.png
make_icon 128 icon_128x128.png
make_icon 256 icon_128x128@2x.png
make_icon 256 icon_256x256.png
make_icon 512 icon_256x256@2x.png
make_icon 512 icon_512x512.png
cp "$SOURCE_PNG" "$ICONSET_DIR/icon_512x512@2x.png"

iconutil -c icns "$ICONSET_DIR" -o "$TARGET_ICNS"

echo "Generated macOS icon: $TARGET_ICNS"