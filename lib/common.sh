# Shared by install.sh and uninstall.sh. Sourced, not run.

NAME=macstyle
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
STATE="$STATE_HOME/$NAME"
ORIGINAL="$STATE/original"          # the desktop as it was before the first install
INSTALLED="$STATE/installed.list"   # every path the install put in place
EXT_DIR="$DATA_HOME/gnome-shell/extensions"
THEMES_DIR="$HOME/.themes"
ICONS_DIR="$DATA_HOME/icons"
BIN_DIR="$HOME/.local/bin"
LIBEXEC_DIR="$HOME/.local/libexec"
UNIT_DIR="$CONFIG_HOME/systemd/user"
APPS_DIR="$DATA_HOME/applications"
WALL_DIR="$DATA_HOME/backgrounds/$NAME"
# Firefox reads default settings for every profile from here (a test can point elsewhere).
FIREFOX_POLICIES="${MACSTYLE_FIREFOX_POLICIES:-/etc/firefox/policies/policies.json}"

# Extensions that come from Fedora packages instead of this repository.
RPM_EXTENSIONS=(apps-menu@gnome-shell-extensions.gcampax.github.com background-logo@fedorahosted.org)
PACKAGES=(libdbusmenu libdbusmenu-gtk3 gnome-shell-extension-apps-menu gnome-shell-extension-background-logo)
# For the terminal (skipped with --no-terminal).
TERMINAL_PACKAGES=(zsh zsh-autosuggestions zsh-syntax-highlighting fastfetch lsd fzf zoxide)
# Docks that would fight with Dash2Dock Motion.
CONFLICTING_EXTENSIONS=(dash-to-dock@micxgx.gmail.com ubuntu-dock@ubuntu.com dash2dock-lite@icedman.github.com)

# dconf keys outside the extension folders that the install changes (restored by uninstall.sh).
DCONF_KEYS=(
    /org/gnome/shell/enabled-extensions
    /org/gnome/shell/disabled-extensions
    /org/gnome/shell/disable-user-extensions
    /org/gnome/shell/favorite-apps
    /org/gnome/desktop/interface/gtk-theme
    /org/gnome/desktop/interface/icon-theme
    /org/gnome/desktop/interface/cursor-theme
    /org/gnome/desktop/interface/font-name
    /org/gnome/desktop/wm/preferences/button-layout
    /org/gnome/desktop/background/picture-uri
    /org/gnome/desktop/background/picture-uri-dark
    /org/gnome/desktop/background/picture-options
    /org/gnome/mutter/workspaces-only-on-primary
    /org/gnome/Ptyxis/use-system-font
    /org/gnome/Ptyxis/font-name
    /org/gnome/Ptyxis/interface-style
    /org/gnome/Ptyxis/default-profile-uuid
    /org/gnome/Ptyxis/profile-uuids
)
# Keys of the Ptyxis profile the install changes (under /org/gnome/Ptyxis/Profiles/UUID/).
PTYXIS_PROFILE_KEYS=(palette opacity use-custom-command custom-command)

if [[ -t 1 ]]; then
    B=$'\e[1m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' N=$'\e[0m'
else
    B='' G='' Y='' R='' N=''
fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '\n%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# Ask a yes/no question; the default answer is the first letter of $2 (y or n).
ask() {
    local q="$1" def="$2" a
    if [[ "${ASSUME_YES:-0}" = 1 || ! -t 0 ]]; then [[ "$def" = y ]]; return; fi
    read -r -p "$q " a || a=""
    a="${a:-$def}"
    [[ "$a" = [yYoO]* ]]
}
