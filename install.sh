#!/usr/bin/env bash
# macstyle: a macOS-like Fedora GNOME desktop, by Hilali Abdel.
#
#   git clone https://github.com/abdel-hilali/fedora-gnome-macos-customization
#   cd fedora-gnome-macos-customization
#   ./install.sh
#
# Run it as your normal user from a terminal inside your GNOME session. It asks for your
# password once (for a few small Fedora packages and a Firefox setting), installs everything,
# then asks you to log out and back in. ./uninstall.sh puts your desktop back as it was.
#
# Options:
#   -y, --yes          answer every question with its default (no prompts)
#   --no-packages      skip everything that needs sudo (packages, the Firefox setting)
#   --no-apps          leave VS Code, Chrome and Firefox alone
#   --force            run on a Fedora or GNOME version this was not tested on
#   -h, --help         show this help
set -Eeuo pipefail
shopt -s nullglob

REPO="$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/common.sh
source "$REPO/lib/common.sh"

TESTED_GNOME=50
ICONS_COMMIT=839848b9a8a38a92a6936e30c4abe35cc6f2546d   # MacTahoe icon theme, 2026-09-10
ICONS_URL="https://github.com/vinceliuice/MacTahoe-icon-theme/archive/$ICONS_COMMIT.tar.gz"
WALLPAPERS=(mountain:Mountain sub-arctic:Sub-Arctic coast:Coast waterfall:Waterfall orionids:Orionids nuvole:Nuvole)
DEFAULT_WALLPAPER=mountain

ASSUME_YES=0 PACKAGES_ON=1 APPS_ON=1 FORCE=0
for arg in "$@"; do
    case "$arg" in
        -y|--yes) ASSUME_YES=1 ;;
        --no-packages) PACKAGES_ON=0 ;;
        --no-apps) APPS_ON=0 ;;
        --force) FORCE=1 ;;
        -h|--help) sed -n '2,/^set -E/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option: $arg (see ./install.sh --help)" ;;
    esac
done

trap 'die "install.sh stopped at line $LINENO. Your desktop is half set up: run ./install.sh again, or ./uninstall.sh to go back."' ERR

# --- checks --------------------------------------------------------------------------------------

preflight() {
    step "Checking this computer"
    [[ $EUID -ne 0 ]] || die "run ./install.sh as your normal user, without sudo."
    for d in extensions themes settings bin systemd lib wallpapers; do
        [[ -d "$REPO/$d" ]] || die "$REPO/$d is missing. Run install.sh inside the folder you cloned with git."
    done
    local id="" version_id=""
    if [[ -r /etc/os-release ]]; then
        id="$(. /etc/os-release && echo "${ID:-}")"
        version_id="$(. /etc/os-release && echo "${VERSION_ID:-}")"
    fi
    if [[ "$id" != fedora ]]; then
        [[ $FORCE = 1 ]] || die "this is made for Fedora (found: ${id:-unknown}). Use --force to try anyway."
        warn "not Fedora (${id:-unknown}); going on because of --force"
    fi
    command -v gnome-shell >/dev/null || die "GNOME Shell is not installed. This needs Fedora Workstation (GNOME)."
    local gv; gv="$(gnome-shell --version | awk '{split($3, v, "."); print v[1]}')"
    if [[ "$gv" != "$TESTED_GNOME" ]]; then
        [[ $FORCE = 1 ]] || die "tested on GNOME $TESTED_GNOME (Fedora 44); this computer has GNOME $gv. Some extensions may not load. Use --force to try anyway."
        warn "GNOME $gv is not tested; going on because of --force"
    fi
    [[ "${XDG_CURRENT_DESKTOP:-}" == *GNOME* && -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]] ||
        die "run it from a terminal inside your GNOME desktop (not over SSH or from a text console)."
    for c in dconf gsettings python3 systemctl gio curl tar; do
        command -v "$c" >/dev/null || die "the command '$c' is missing."
    done
    ok "Fedora ${version_id:-?}, GNOME Shell $(gnome-shell --version | awk '{print $3}'), ${XDG_SESSION_TYPE:-?} session"
}

# --- record of what was there before -------------------------------------------------------------

mark_installed() {   # remember a path the install put in place
    mkdir -p "$STATE"
    grep -qxF -- "$1" "$INSTALLED" 2>/dev/null || printf '%s\n' "$1" >> "$INSTALLED"
}

keep_original() {    # save PATH as it was before the first install, once
    local path="$1" rel
    [[ -e "$path" || -L "$path" ]] || return 0
    grep -qxF -- "$path" "$INSTALLED" 2>/dev/null && return 0   # ours from an earlier run
    rel="${path#"$HOME"/}"
    [[ -e "$ORIGINAL/files/$rel" || -L "$ORIGINAL/files/$rel" ]] && return 0
    mkdir -p "$(dirname -- "$ORIGINAL/files/$rel")"
    cp -a -- "$path" "$ORIGINAL/files/$rel"
}

put() {              # put SRC at DEST (file or folder), keeping the original
    local src="$1" dest="$2"
    keep_original "$dest"
    rm -rf -- "$dest"
    mkdir -p -- "$(dirname -- "$dest")"
    cp -a -- "$src" "$dest"
    mark_installed "$dest"
}

write_file() {       # write stdin to DEST, keeping the original
    local dest="$1" tmp
    keep_original "$dest"
    mkdir -p -- "$(dirname -- "$dest")"
    tmp="$(mktemp "$dest.XXXXXX")"
    cat > "$tmp"
    chmod 644 "$tmp"
    rm -rf -- "$dest"
    mv -- "$tmp" "$dest"
    mark_installed "$dest"
}

backup() {
    step "Saving your current desktop settings"
    mkdir -p "$STATE"
    if [[ ! -e "$ORIGINAL/dconf.ini" ]]; then
        mkdir -p "$ORIGINAL"
        dconf dump / > "$ORIGINAL/dconf.ini"
        date -Iseconds > "$ORIGINAL/date"
        ok "saved in $ORIGINAL (./uninstall.sh uses it)"
    else
        ok "kept the copy from your first install ($(cat "$ORIGINAL/date" 2>/dev/null || echo earlier))"
    fi
    dconf dump / > "$STATE/dconf-before-last-install.ini"
}

# --- steps ---------------------------------------------------------------------------------------

packages() {
    step "Fedora packages and the Firefox setting (needs your password)"
    if [[ $PACKAGES_ON = 0 ]]; then
        warn "skipped (--no-packages): menus of Firefox, Chrome and VS Code may not reach the top bar"
        return
    fi
    local missing=() p
    for p in "${PACKAGES[@]}"; do rpm -q "$p" >/dev/null 2>&1 || missing+=("$p"); done
    if ((${#missing[@]})); then
        info "installing: ${missing[*]}"
        sudo dnf install -y "${missing[@]}"
    fi
    ok "packages: ${PACKAGES[*]}"
    if [[ $APPS_ON = 1 ]] && command -v firefox >/dev/null; then
        # Firefox: its menu in the top bar, and GNOME's title bar instead of tabs in the title bar.
        # A default value for every profile, also ones made later; you can still change both
        # in about:config.
        local merged
        merged="$({ cat "$FIREFOX_POLICIES" 2>/dev/null || true; } | python3 -I -c '
import json, sys
text = sys.stdin.read().strip()
data = json.loads(text) if text else {}
prefs = data.setdefault("policies", {}).setdefault("Preferences", {})
prefs["widget.gtk.global-menu.enabled"] = {"Value": True, "Status": "default"}
prefs["browser.tabs.inTitlebar"] = {"Value": 0, "Status": "default"}
print(json.dumps(data, indent=2))')"
        if [[ ! -e "$STATE/firefox-policies-existed" && ! -e "$STATE/firefox-policies-new" ]]; then
            if [[ -e "$FIREFOX_POLICIES" ]]; then
                mkdir -p "$ORIGINAL/files-root"
                cp -- "$FIREFOX_POLICIES" "$ORIGINAL/files-root/policies.json"
                touch "$STATE/firefox-policies-existed"
            else
                touch "$STATE/firefox-policies-new"
            fi
        fi
        sudo mkdir -p "$(dirname -- "$FIREFOX_POLICIES")"
        printf '%s\n' "$merged" | sudo tee "$FIREFOX_POLICIES" >/dev/null
        sudo chmod 644 "$FIREFOX_POLICIES"
        ok "Firefox: top-bar menu and system title bar ($FIREFOX_POLICIES)"
    fi
}

extensions() {
    step "GNOME extensions"
    local dir uuid count=0
    for dir in "$REPO"/extensions/*/; do
        uuid="$(basename -- "$dir")"
        put "${dir%/}" "$EXT_DIR/$uuid"
        count=$((count + 1))
    done
    ok "$count extensions copied to $EXT_DIR"
}

themes() {
    step "Themes, icons and cursor"
    local t
    for t in WhiteSur-Light WhiteSur-Dark; do
        put "$REPO/themes/$t" "$THEMES_DIR/$t"
    done
    keep_original "$THEMES_DIR/WhiteSur-Light-soft"
    bash "$REPO/lib/make-soft-theme.sh" "$THEMES_DIR/WhiteSur-Light" "$THEMES_DIR/WhiteSur-Light-soft" \
        "$REPO/lib/map-softer.json" >/dev/null
    mark_installed "$THEMES_DIR/WhiteSur-Light-soft"
    ok "WhiteSur Light (soft), WhiteSur Dark"

    if [[ -f "$ICONS_DIR/MacTahoe-light/index.theme" && -f "$ICONS_DIR/MacTahoe-dark/index.theme" ]]; then
        ok "MacTahoe icons are already installed"
    else
        info "downloading the MacTahoe icon theme (about 10 MB)..."
        local tmp; tmp="$(mktemp -d)"
        curl -fsSL --retry 3 "$ICONS_URL" -o "$tmp/icons.tar.gz" ||
            die "could not download $ICONS_URL. Check the internet connection and run ./install.sh again."
        tar -xzf "$tmp/icons.tar.gz" -C "$tmp"
        local src; src="$(find "$tmp" -maxdepth 1 -type d -name 'MacTahoe-icon-theme-*' -print -quit)"
        [[ -n "$src" && -x "$src/install.sh" ]] || die "the icon download looks wrong ($ICONS_URL)."
        for t in MacTahoe MacTahoe-light MacTahoe-dark; do keep_original "$ICONS_DIR/$t"; done
        (cd "$src" && ./install.sh -d "$ICONS_DIR" >/dev/null 2>&1) ||
            die "the MacTahoe icon installer failed."
        for t in MacTahoe MacTahoe-light MacTahoe-dark; do mark_installed "$ICONS_DIR/$t"; done
        rm -rf -- "$tmp"
        ok "MacTahoe icons and cursor installed"
    fi

    # GTK 4 and libadwaita apps (Files, Settings, Text Editor...) take the theme from this file,
    # in light and dark. Unite adds its own lines for the window buttons at the next login.
    local f
    for f in gtk.css gtk-dark.css assets windows-assets; do
        [[ -L "$CONFIG_HOME/gtk-4.0/$f" ]] && { keep_original "$CONFIG_HOME/gtk-4.0/$f"; rm -f -- "$CONFIG_HOME/gtk-4.0/$f"; }
    done
    write_file "$CONFIG_HOME/gtk-4.0/gtk.css" <<EOF
@media (prefers-color-scheme: light) { @import url("file://$THEMES_DIR/WhiteSur-Light-soft/gtk-4.0/gtk.css"); }
@media (prefers-color-scheme: dark)  { @import url("file://$THEMES_DIR/WhiteSur-Dark/gtk-4.0/gtk.css"); }
EOF
    ok "GTK 4 apps follow the theme ($CONFIG_HOME/gtk-4.0/gtk.css)"
}

wallpapers() {
    step "Wallpapers (day and night)"
    local w file title xml="" list="$DATA_HOME/gnome-background-properties/$NAME.xml"
    keep_original "$WALL_DIR"
    mkdir -p "$WALL_DIR"
    mark_installed "$WALL_DIR"
    for w in "${WALLPAPERS[@]}"; do
        file="${w%%:*}" title="${w#*:}"
        cp -f "$REPO/wallpapers/$file-l.jpg" "$REPO/wallpapers/$file-d.jpg" "$WALL_DIR/"
        xml+="  <wallpaper deleted=\"false\">
    <name>$title</name>
    <filename>$WALL_DIR/$file-l.jpg</filename>
    <filename-dark>$WALL_DIR/$file-d.jpg</filename-dark>
    <options>zoom</options>
    <shade_type>solid</shade_type>
    <pcolor>#1c3b5a</pcolor>
    <scolor>#000000</scolor>
  </wallpaper>
"
    done
    cp -f "$REPO/wallpapers/CREDITS.txt" "$WALL_DIR/"
    if [[ -f "$list" ]]; then   # pictures listed there before, other than ours, stay in the list
        xml+="$(python3 -I "$REPO/lib/wallpaper-list.py" "$list" "$WALL_DIR")"
        [[ -z "$xml" || "$xml" == *$'\n' ]] || xml+=$'\n'
    fi
    write_file "$list" <<EOF
<?xml version="1.0"?>
<!DOCTYPE wallpapers SYSTEM "gnome-wp-list.dtd">
<wallpapers>
$xml</wallpapers>
EOF
    gsettings set org.gnome.desktop.background picture-uri "file://$WALL_DIR/$DEFAULT_WALLPAPER-l.jpg"
    gsettings set org.gnome.desktop.background picture-uri-dark "file://$WALL_DIR/$DEFAULT_WALLPAPER-d.jpg"
    gsettings set org.gnome.desktop.background picture-options zoom
    ok "six day-and-night pairs (Settings > Appearance), \"Mountain\" set"
}

services() {
    step "Dark Style switch and app helper (small background services)"
    put "$REPO/bin/macstyle-darkswitch" "$BIN_DIR/macstyle-darkswitch"
    put "$REPO/bin/macstyle-appfollow" "$BIN_DIR/macstyle-appfollow"
    put "$REPO/libexec/downloads-stack" "$LIBEXEC_DIR/downloads-stack"
    chmod 755 "$BIN_DIR/macstyle-darkswitch" "$BIN_DIR/macstyle-appfollow" "$LIBEXEC_DIR/downloads-stack"
    local u
    for u in macstyle-darkswitch.service macstyle-appfollow.service macstyle-appfollow.path; do
        put "$REPO/systemd/$u" "$UNIT_DIR/$u"
    done
    systemctl --user daemon-reload
    systemctl --user enable macstyle-darkswitch.service >/dev/null 2>&1
    if [[ $APPS_ON = 1 ]]; then
        systemctl --user enable macstyle-appfollow.service macstyle-appfollow.path >/dev/null 2>&1
        systemctl --user start macstyle-appfollow.path
    fi
    systemctl --user restart macstyle-darkswitch.service
    ok "Dark Style now switches themes, icons, top bar, dock and window shadows together"
}

launcher() {
    # The Downloads icon in the dock: a click fans out the newest files (Downloads Fan extension).
    write_file "$APPS_DIR/downloads-folder.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Downloads
Comment=Show the newest downloads; opens the Downloads folder when the Downloads Fan extension is off
Icon=folder-download
Exec="$LIBEXEC_DIR/downloads-stack" toggle
Terminal=false
StartupNotify=false
Categories=Utility;
Actions=folder;latest;reveal;

[Desktop Action folder]
Name=Open Downloads Folder
Exec="$LIBEXEC_DIR/downloads-stack" open-folder

[Desktop Action latest]
Name=Open Most Recent Download
Exec="$LIBEXEC_DIR/downloads-stack" open-latest

[Desktop Action reveal]
Name=Show Most Recent in Files
Exec="$LIBEXEC_DIR/downloads-stack" reveal-latest
EOF
}

settings() {
    step "Settings"
    dconf load / < "$REPO/settings/extensions.dconf"
    ok "settings of the extensions"
    gsettings set org.gnome.desktop.interface gtk-theme 'WhiteSur-Light-soft'
    gsettings set org.gnome.desktop.interface icon-theme 'MacTahoe-light'
    gsettings set org.gnome.desktop.interface cursor-theme 'MacTahoe-light'
    gsettings set org.gnome.desktop.wm.preferences button-layout 'close,minimize,maximize:appmenu'
    gsettings set org.gnome.mutter workspaces-only-on-primary false
    if fc-list : family 2>/dev/null | grep -E '(^|,)SF Pro Display(,|$)' >/dev/null; then
        gsettings set org.gnome.desktop.interface font-name 'SF Pro Display 11'
        ok "font: SF Pro Display (found on this computer)"
    fi
    ok "window buttons on the left, themes, icons and cursor"
    launcher
    local uuids=() dir
    for dir in "$REPO"/extensions/*/; do uuids+=("$(basename -- "$dir")"); done
    gsettings set org.gnome.shell disable-user-extensions false
    python3 -I "$REPO/lib/dconf-tool.py" enable "${uuids[@]}" "${RPM_EXTENSIONS[@]}" \
        --disable "${CONFLICTING_EXTENSIONS[@]}"
    python3 -I "$REPO/lib/dconf-tool.py" add-favorite downloads-folder.desktop
    ok "extensions switched on (they start at your next login); Downloads added to the dock"
}

apps() {
    step "Apps: VS Code, Chrome, Firefox and other Chromium or Electron apps"
    if [[ $APPS_ON = 0 ]]; then
        warn "skipped (--no-apps)"
        return
    fi
    # Chromium browsers and Electron apps (VS Code, Chrome, Brave, Discord...) as X11 clients with
    # GNOME's title bar: their menus go to the top bar and the window buttons follow Unite. The
    # service does this again for every app installed later.
    "$BIN_DIR/macstyle-appfollow" || warn "macstyle-appfollow reported a problem (see above)"
    if [[ -x /usr/bin/code ]]; then
        # "code" typed in a terminal starts VS Code the same way.
        write_file "$BIN_DIR/code" <<'EOF'
#!/bin/sh
# VS Code as an X11 client, like its launcher (macstyle): the top bar shows its menu.
exec /usr/bin/code --ozone-platform=x11 "$@"
EOF
        chmod 755 "$BIN_DIR/code"
    fi
    python3 -I "$REPO/lib/vscode-colors.py" "$STATE"
    if [[ -f /usr/share/applications/org.mozilla.firefox.desktop ]]; then
        { echo "# macstyle: copy of /usr/share/applications/org.mozilla.firefox.desktop with MOZ_ENABLE_WAYLAND=0,"
          echo "# so Firefox runs as an X11 client and its menu and window buttons go to the top bar."
          sed 's/^Exec=/Exec=env MOZ_ENABLE_WAYLAND=0 /' /usr/share/applications/org.mozilla.firefox.desktop
        } | write_file "$APPS_DIR/org.mozilla.firefox.desktop"
        ok "Firefox launcher"
    fi
    update-desktop-database -q "$APPS_DIR" 2>/dev/null || true
    ok "apps done; an app that is open now changes the next time you start it"
}

finish() {
    step "Done"
    cat <<EOF
    Log out and log back in to finish: GNOME starts new extensions only at login.

    After that:
      - Dark Style (Quick Settings) switches everything, wallpaper included.
      - Maximize a window: its buttons and its menu move to the top bar.
      - Click Downloads in the dock to fan out your newest files.

    Undo everything:  ./uninstall.sh
    Log of this run:  $LOG
EOF
    if ask "Log out now? [y/N]" n; then
        gnome-session-quit --logout || true
    fi
}

main() {
    mkdir -p "$STATE"
    LOG="$STATE/install-$(date +%Y%m%d-%H%M%S).log"
    exec > >(tee -a "$LOG") 2>&1
    printf '%smacstyle%s: a macOS-like Fedora GNOME desktop, by Hilali Abdel\n' "$B" "$N"
    preflight
    backup
    packages
    extensions
    themes
    wallpapers
    settings
    services
    apps
    finish
}

main
