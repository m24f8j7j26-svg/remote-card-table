#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/dist/Remote Spades.app"
SITE_DIR="$APP_DIR/Contents/Resources/site"
ICONSET_DIR="$ROOT_DIR/build/RemoteSpades.iconset"
BASE_PPM="$ROOT_DIR/build/remote-spades-icon.ppm"
BASE_PNG="$ROOT_DIR/build/remote-spades-icon.png"

rm -rf "$APP_DIR" "$ICONSET_DIR"
mkdir -p "$ROOT_DIR/build" "$ROOT_DIR/dist"

osacompile -s -o "$APP_DIR" "$ROOT_DIR/packaging/RemoteSpades.applescript"
mkdir -p "$SITE_DIR"
cp \
  "$ROOT_DIR/index.html" \
  "$ROOT_DIR/styles.css" \
  "$ROOT_DIR/app.js" \
  "$ROOT_DIR/handfoot.html" \
  "$ROOT_DIR/handfoot.css" \
  "$ROOT_DIR/handfoot.js" \
  "$SITE_DIR/"
cp "$ROOT_DIR/packaging/launcher.py" "$APP_DIR/Contents/Resources/launcher.py"
chmod +x "$APP_DIR/Contents/Resources/launcher.py"

/usr/bin/python3 "$ROOT_DIR/packaging/make_icon.py" "$BASE_PPM"
sips -s format png "$BASE_PPM" --out "$BASE_PNG" >/dev/null
mkdir -p "$ICONSET_DIR"
sips -z 16 16 "$BASE_PNG" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$BASE_PNG" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$BASE_PNG" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$BASE_PNG" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$BASE_PNG" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$BASE_PNG" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$BASE_PNG" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$BASE_PNG" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$BASE_PNG" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$BASE_PNG" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET_DIR" -o "$APP_DIR/Contents/Resources/applet.icns"

/usr/libexec/PlistBuddy -c "Add :CFBundleName string Remote Spades" "$APP_DIR/Contents/Info.plist" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Remote Spades" "$APP_DIR/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Remote Spades" "$APP_DIR/Contents/Info.plist" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Remote Spades" "$APP_DIR/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.local.remotespades" "$APP_DIR/Contents/Info.plist" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.local.remotespades" "$APP_DIR/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string applet" "$APP_DIR/Contents/Info.plist" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile applet" "$APP_DIR/Contents/Info.plist"

for key in \
  NSAppleEventsUsageDescription \
  NSAppleMusicUsageDescription \
  NSCalendarsUsageDescription \
  NSCameraUsageDescription \
  NSContactsUsageDescription \
  NSHomeKitUsageDescription \
  NSMicrophoneUsageDescription \
  NSPhotoLibraryUsageDescription \
  NSRemindersUsageDescription \
  NSSiriUsageDescription \
  NSSystemAdministrationUsageDescription
do
  /usr/libexec/PlistBuddy -c "Delete :$key" "$APP_DIR/Contents/Info.plist" 2>/dev/null || true
done

codesign --force --deep --sign - "$APP_DIR" >/dev/null

echo "$APP_DIR"
