#!/bin/sh
# 仓库根目录稳定入口：完整下载最新正式发行SH，再透传参数；不内嵌版本或包摘要。
set -eu
command -v curl >/dev/null 2>&1 || { echo '需要curl下载正式发行安装器。' >&2; exit 1; }
entry=$(mktemp "${TMPDIR:-/tmp}/dsh-tavern-v2-entry.XXXXXXXX")
# 只清理本次mktemp创建的确切文件，不删除目录或其它会话文件。
case "$entry" in
  "${TMPDIR:-/tmp}"/dsh-tavern-v2-entry.*) ;;
  *) echo '临时入口路径异常，拒绝执行。' >&2; exit 1 ;;
esac
trap 'rm -f -- "$entry"' 0
trap 'exit 130' INT
trap 'exit 143' TERM
curl --proto '=https' --proto-redir '=https' -fsSL --connect-timeout 10 --max-time 60 \
  https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh -o "$entry"
[ -s "$entry" ] || { echo '正式发行安装器为空，未执行任何安装操作。' >&2; exit 1; }
sh "$entry" "$@"
