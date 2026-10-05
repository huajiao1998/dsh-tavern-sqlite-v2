#!/bin/sh
# 本地优先；发布构建填入固定地址和摘要，再内嵌零依赖Node获取器。
set -eu
RELEASE_URL='__DSH_RELEASE_URL__'
RELEASE_SHA256='__DSH_RELEASE_SHA256__'
VERSION='__DSH_RELEASE_VERSION__'
SCRIPT_DIR=''
case "$0" in
  *install.sh) SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) ;;
esac
export DSH_STORAGE_BOOTSTRAP_DIR="$SCRIPT_DIR"
export DSH_STORAGE_RELEASE_URL="${DSH_STORAGE_RELEASE_URL:-$RELEASE_URL}"
export DSH_STORAGE_RELEASE_SHA256="${DSH_STORAGE_RELEASE_SHA256:-$RELEASE_SHA256}"
export DSH_STORAGE_RELEASE_VERSION="$VERSION"
command -v node >/dev/null 2>&1 || { echo '需要已有酒馆使用的Node.js 22.19+；本脚本不另装运行时。' >&2; exit 1; }
node --input-type=module - "$@" <<'DSH_STORAGE_BOOTSTRAP'
__DSH_BOOTSTRAP_SOURCE__
DSH_STORAGE_BOOTSTRAP
