#!/usr/bin/env bash
# Downloads the opendataloader-pdf CLI jar + a Temurin 21 JRE into
# src-tauri/resources/ so the PDF -> Markdown tab is self-contained (no
# system Java required). Idempotent: skips any part that already exists.
#
# Usage: scripts/fetch-runtime.sh <windows-x64|mac-aarch64|mac-x64|linux-x64>
set -euo pipefail

CLI_VERSION="2.4.7"
JRE_FEATURE="21"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <windows-x64|mac-aarch64|mac-x64|linux-x64>" >&2
  exit 1
fi
PLATFORM="$1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES_DIR="$REPO_ROOT/src-tauri/resources"
JAR_PATH="$RESOURCES_DIR/opendataloader-pdf-cli.jar"
JRE_DIR="$RESOURCES_DIR/jre"

mkdir -p "$RESOURCES_DIR"

# ── CLI JAR ──────────────────────────────────────────────────────────────
if [ -f "$JAR_PATH" ]; then
  echo "[fetch-runtime] JAR already present, skipping: $JAR_PATH"
else
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  ZIP_URL="https://github.com/opendataloader-project/opendataloader-pdf/releases/download/v${CLI_VERSION}/opendataloader-pdf-cli-${CLI_VERSION}.zip"
  echo "[fetch-runtime] downloading CLI jar: $ZIP_URL"
  curl -sL -o "$TMP_DIR/cli.zip" "$ZIP_URL"
  unzip -q "$TMP_DIR/cli.zip" -d "$TMP_DIR/extracted"
  JAR_FILE="$(find "$TMP_DIR/extracted" -name 'opendataloader-pdf-cli-*.jar' | head -1)"
  if [ -z "$JAR_FILE" ]; then
    echo "[fetch-runtime] CLI jar not found inside downloaded zip" >&2
    exit 1
  fi
  cp "$JAR_FILE" "$JAR_PATH"
  echo "[fetch-runtime] placed JAR: $JAR_PATH"
  rm -rf "$TMP_DIR"
  trap - EXIT
fi

# ── JRE ──────────────────────────────────────────────────────────────────
case "$PLATFORM" in
  windows-x64) ADOPTIUM_OS="windows"; ADOPTIUM_ARCH="x64" ;;
  mac-aarch64) ADOPTIUM_OS="mac"; ADOPTIUM_ARCH="aarch64" ;;
  mac-x64)     ADOPTIUM_OS="mac"; ADOPTIUM_ARCH="x64" ;;
  linux-x64)   ADOPTIUM_OS="linux"; ADOPTIUM_ARCH="x64" ;;
  *)
    echo "Unknown platform: $PLATFORM (expected windows-x64|mac-aarch64|mac-x64|linux-x64)" >&2
    exit 1
    ;;
esac

if [ "$ADOPTIUM_OS" = "windows" ]; then
  JAVA_BIN_NAME="java.exe"
else
  JAVA_BIN_NAME="java"
fi
JAVA_BIN_PATH="$JRE_DIR/bin/$JAVA_BIN_NAME"

if [ -f "$JAVA_BIN_PATH" ]; then
  echo "[fetch-runtime] JRE already present, skipping: $JAVA_BIN_PATH"
else
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  JRE_URL="https://api.adoptium.net/v3/binary/latest/${JRE_FEATURE}/ga/${ADOPTIUM_OS}/${ADOPTIUM_ARCH}/jre/hotspot/normal/eclipse"
  echo "[fetch-runtime] downloading JRE ($PLATFORM): $JRE_URL"

  EXTRACT_DIR="$TMP_DIR/extracted"
  mkdir -p "$EXTRACT_DIR"
  if [ "$ADOPTIUM_OS" = "windows" ]; then
    curl -sL -o "$TMP_DIR/jre.zip" "$JRE_URL"
    unzip -q "$TMP_DIR/jre.zip" -d "$EXTRACT_DIR"
  else
    curl -sL -o "$TMP_DIR/jre.tar.gz" "$JRE_URL"
    tar -xzf "$TMP_DIR/jre.tar.gz" -C "$EXTRACT_DIR"
  fi

  # Find the dir that directly contains bin/java(.exe) — normalizes both the
  # plain "jdk-*-jre/" layout and macOS's "jdk-*-jre/Contents/Home/" layout.
  JAVA_FILE="$(find "$EXTRACT_DIR" -type f -path "*/bin/$JAVA_BIN_NAME" | head -1)"
  if [ -z "$JAVA_FILE" ]; then
    echo "[fetch-runtime] java binary not found inside downloaded JRE archive" >&2
    exit 1
  fi
  JRE_SOURCE_ROOT="$(dirname "$(dirname "$JAVA_FILE")")"

  rm -rf "$JRE_DIR"
  cp -R "$JRE_SOURCE_ROOT" "$JRE_DIR"
  chmod +x "$JRE_DIR/bin/$JAVA_BIN_NAME"
  echo "[fetch-runtime] placed JRE: $JRE_DIR"
  rm -rf "$TMP_DIR"
  trap - EXIT
fi

echo "[fetch-runtime] done."
