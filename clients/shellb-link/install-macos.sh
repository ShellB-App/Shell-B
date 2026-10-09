#!/bin/sh
# Registers shellb:// on macOS with a tiny AppleScript app (~/Applications/Shell-B Link.app) that hands links on as
# web+shellb:, which the installed Shell:B app registered.
set -eu
app="$HOME/Applications/Shell-B Link.app"
mkdir -p "$HOME/Applications"
osacompile -o "$app" -e 'on open location u
  if u starts with "web+" then
    open location u
  else
    open location "web+" & u
  end if
end open location'
plist="$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string net.eviemi.shellb-link' "$plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :LSUIElement bool true' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes array' \
  -c 'Add :CFBundleURLTypes:0 dict' -c 'Add :CFBundleURLTypes:0:CFBundleURLName string Shell:B link' \
  -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string shellb' "$plist"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
echo "shellb:// now opens with $app"
