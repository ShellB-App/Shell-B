#!/bin/sh
# Registers shellb:// with the desktop: installs shellb-link into ~/.local/bin and makes it the shellb: handler.
# Optional: install-linux.sh https://your-shell-b-address  (writes SHELLB_URL, used when the app isn't installed)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
bin="$HOME/.local/bin"; apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$bin" "$apps"
install -m 755 "$here/shellb-link" "$bin/shellb-link"
sed "s|^Exec=shellb-link|Exec=$bin/shellb-link|" "$here/shellb-link.desktop" > "$apps/shellb-link.desktop"
xdg-mime default shellb-link.desktop x-scheme-handler/shellb
update-desktop-database "$apps" 2>/dev/null || true
if [ -n "${1:-}" ]; then
  conf="${XDG_CONFIG_HOME:-$HOME/.config}/shellb"; mkdir -p "$conf"
  echo "SHELLB_URL=$1" > "$conf/link.conf"
fi
echo "shellb:// now opens with $(xdg-mime query default x-scheme-handler/shellb)"
