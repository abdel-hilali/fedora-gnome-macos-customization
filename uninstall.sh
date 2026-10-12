#!/usr/bin/env bash
# macstyle: put the desktop back as it was before the first ./install.sh.
#
#   ./uninstall.sh        (asks first)
#   ./uninstall.sh --yes  (does not ask)
#
# It removes what install.sh put in place, brings back the files and settings it had
# replaced, and stops the two background services. The Fedora packages stay (harmless).
# Log out and back in at the end.
set -Eeuo pipefail
shopt -s nullglob

REPO="$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/common.sh
source "$REPO/lib/common.sh"

ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help) sed -n '2,/^set -E/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option: $arg" ;;
    esac
done

trap 'die "uninstall.sh stopped at line $LINENO. Run it again; it continues where it stopped."' ERR

[[ $EUID -ne 0 ]] || die "run ./uninstall.sh as your normal user, without sudo."
[[ -e "$INSTALLED" || -e "$ORIGINAL/dconf.ini" ]] || die "nothing to undo: install.sh has not run for this user."
[[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]] || die "run it from a terminal inside your GNOME desktop."

printf '%smacstyle%s uninstall\n' "$B" "$N"
when="$(cat "$ORIGINAL/date" 2>/dev/null || echo 'before the first install')"
if [[ $ASSUME_YES != 1 ]]; then
    ask "Put your desktop back as it was on $when? [y/N]" n || { echo "Nothing changed."; exit 0; }
fi

step "Stopping the background services"
systemctl --user disable --now macstyle-darkswitch.service macstyle-appfollow.service \
    macstyle-appfollow.path >/dev/null 2>&1 || true
ok "stopped"

step "Apps"
python3 -I "$REPO/lib/vscode-colors.py" --remove "$STATE" || warn "VS Code colours: see above"
python3 -I "$REPO/lib/appfollow-undo.py" || warn "app settings: see above"
if [[ -e "$STATE/firefox-policies-new" || -e "$STATE/firefox-policies-existed" ]]; then
    if [[ -e "$STATE/firefox-policies-existed" && -f "$ORIGINAL/files-root/policies.json" ]]; then
        sudo cp -- "$ORIGINAL/files-root/policies.json" "$FIREFOX_POLICIES"
    else
        sudo rm -f -- "$FIREFOX_POLICIES"
    fi
    rm -f -- "$STATE/firefox-policies-new" "$STATE/firefox-policies-existed"
    ok "Firefox setting removed"
fi
rm -rf -- "$STATE_HOME/macstyle-appfollow"

step "Files"
removed=0 restored=0
if [[ -f "$INSTALLED" ]]; then
    # Last in, first out, so a folder goes after the files in it.
    while IFS= read -r path; do
        [[ -n "$path" && "$path" == "$HOME"/* ]] || continue
        rm -rf -- "$path"
        removed=$((removed + 1))
        rel="${path#"$HOME"/}"
        if [[ -e "$ORIGINAL/files/$rel" || -L "$ORIGINAL/files/$rel" ]]; then
            mkdir -p -- "$(dirname -- "$path")"
            cp -a -- "$ORIGINAL/files/$rel" "$path"
            restored=$((restored + 1))
        fi
    done < <(tac "$INSTALLED")
fi
systemctl --user daemon-reload || true
update-desktop-database -q "$APPS_DIR" 2>/dev/null || true
ok "$removed paths removed, $restored of them brought back as they were"

step "Settings"
if [[ -f "$ORIGINAL/dconf.ini" ]]; then
    python3 -I "$REPO/lib/dconf-tool.py" restore "$ORIGINAL/dconf.ini" "$REPO/settings/extensions.dconf" \
        "${DCONF_KEYS[@]}"
    ok "extension settings, themes, wallpaper and dock favourites as before"
fi

mkdir -p "$STATE_HOME"
mv -- "$STATE" "$STATE_HOME/$NAME-uninstalled-$(date +%Y%m%d-%H%M%S)"

step "Done"
cat <<EOF
    Log out and log back in to finish.
    The saved copy of your old desktop stays in $STATE_HOME/$NAME-uninstalled-*
    (delete it when you are happy). The Fedora packages from the install stay installed
    (libdbusmenu, libdbusmenu-gtk3, the Apps Menu and Background Logo extensions); they
    are harmless.
EOF
if ask "Log out now? [y/N]" n; then
    gnome-session-quit --logout || true
fi
