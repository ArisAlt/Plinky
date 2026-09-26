#!/usr/bin/env bash
# Repack a Tauri AppImage without its bundled libwayland-* libraries.
#
# Why: the AppImage is built on Ubuntu and carried Ubuntu's libwayland-client,
# -cursor, -egl and -server. On a newer desktop (KDE Wayland, AMD, 2026-09-26)
# the host's Mesa loaded against those old copies and WebKit aborted with
# "Could not create default EGL display: EGL_BAD_PARAMETER": the window opened
# and stayed grey. With the four files removed the same build ran normally,
# using the host's own libwayland, which every desktop that can show a window
# already has.
#
# usage: scripts/appimage-drop-wayland.sh <path/to/Plinky.AppImage>
set -euo pipefail

appimage="$(realpath "$1")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$work"
# --appimage-extract needs no FUSE, unlike running the AppImage.
"$appimage" --appimage-extract >/dev/null

removed=$(find squashfs-root/usr/lib -maxdepth 1 -name 'libwayland-*' -print -delete | wc -l)
if [ "$removed" -eq 0 ]; then
  echo "no libwayland-* in $appimage; left as it was"
  exit 0
fi

tool="$work/appimagetool"
curl -fsSL -o "$tool" \
  https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
chmod +x "$tool"
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$tool" --no-appstream squashfs-root "$work/out.AppImage" >/dev/null
mv "$work/out.AppImage" "$appimage"
echo "removed $removed libwayland-* file(s) from $appimage"
