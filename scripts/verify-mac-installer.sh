#!/usr/bin/env bash
set -euo pipefail

installer="$1"
mount_directory="$RUNNER_TEMP/tracelogdock-dmg"
install_directory="$RUNNER_TEMP/tracelogdock-installed"
mkdir -p "$mount_directory" "$install_directory"
hdiutil attach "$installer" -readonly -nobrowse -mountpoint "$mount_directory"
trap 'hdiutil detach "$mount_directory"' EXIT
codesign --verify --deep --strict "$mount_directory/TraceLogDock.app"
ditto "$mount_directory/TraceLogDock.app" "$install_directory/TraceLogDock.app"

# Verify the copied APP, so the smoke flows exercise the installed DMG contents.
application="$install_directory/TraceLogDock.app"
codesign --verify --deep --strict "$application"
version="$(node -p "require('./package.json').version")"
installed_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$application/Contents/Info.plist")"
[[ "$installed_version" == "$version" ]]
[[ "$(lipo -archs "$application/Contents/MacOS/TraceLogDock")" == 'arm64' ]]
export TRACELOGDOCK_SMOKE_EXECUTABLE="$application/Contents/MacOS/TraceLogDock"
for smoke_script in scripts/smoke-desktop.mjs scripts/smoke-remote.mjs scripts/smoke-multi-service-logs.mjs scripts/smoke-arthas.mjs; do
  node "$smoke_script"
done
printf '%s\n' 'Mac DMG, copied APP signature/arm64/version and installed APP smoke flows passed.'
