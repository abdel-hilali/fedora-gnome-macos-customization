# Credits

macstyle brings together the work of many people. Thank you to all of them.

Every part keeps its own licence. The licence texts are in this repository:

- GPL-3.0: [LICENSE](LICENSE)
- GPL-2.0: [extensions/user-theme@gnome-shell-extensions.gcampax.github.com/COPYING](extensions/user-theme@gnome-shell-extensions.gcampax.github.com/COPYING)
- AGPL-3.0: [extensions/live-lockscreen@nick-redwill/LICENSE.txt](extensions/live-lockscreen@nick-redwill/LICENSE.txt)
- MIT: [themes/COPYING.WhiteSur](themes/COPYING.WhiteSur) and [extensions/clipboard-indicator@tudmotu.com/LICENSE.rst](extensions/clipboard-indicator@tudmotu.com/LICENSE.rst)
- CC-BY-SA-4.0 (wallpapers): <https://creativecommons.org/licenses/by-sa/4.0/>

## GNOME Shell extensions

These are copied from the projects below into [extensions/](extensions/). Four of them carry our own changes; each change is also kept as a patch in [patches/](patches/).

| Extension | Project | Version | Licence |
|---|---|---|---|
| AppMenu | <https://github.com/ChathurangaBW/AppMenu> | 15, changed | GPL-3.0 |
| Blur my Shell | <https://github.com/aunetx/blur-my-shell> | 72 | GPL-3.0 |
| Caffeine | <https://github.com/eonpatapon/gnome-shell-extension-caffeine> | 60 | GPL-2.0 |
| Clipboard Indicator | <https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator> | 71 | MIT |
| Compiz alike magic lamp effect | <https://github.com/hermes83/compiz-alike-magic-lamp-effect> | 24 | GPL-3.0 |
| Coverflow Alt-Tab | <https://github.com/dsheeler/CoverflowAltTab> | 88 | GPL-3.0 |
| Dash2Dock Motion | <https://github.com/Unmade760/dash2dock-motion> | based on Dash to Dock 105, changed | GPL-2.0 |
| Desktop Icons NG (DING) | <https://gitlab.com/rastersoft/desktop-icons-ng> | 99 | GPL-3.0 |
| Just Perfection | <https://gitlab.gnome.org/jrahmatzadeh/just-perfection> | 37 | GPL-3.0 |
| Live Lock Screen | <https://github.com/nick-redwill/LiveLockScreen> | 4.0.2 | AGPL-3.0 |
| Multi Monitors Bar | <https://github.com/FrederykAbryan/multi-monitors-bar_fapv2> | 54, changed | GPL-2.0 |
| Rounded Window Corners Reborn | <https://github.com/flexagoon/rounded-window-corners> | 25, changed | GPL-3.0 |
| Status Area Horizontal Spacing | <https://gitlab.com/p91paul/status-area-horizontal-spacing-gnome-shell-extension> | 32 | GPL-2.0-or-later |
| Top Bar Organizer Plus | <https://github.com/ShibasishPaul/top-bar-organizer-plus> | 17.2 | GPL-3.0 |
| Unite | <https://github.com/hardpixel/unite-shell> | 85 | GPL-3.0 |
| User Themes | <https://gitlab.gnome.org/GNOME/gnome-shell-extensions> | 50.4 | GPL-2.0-or-later |
| Downloads Fan | this repository (our own) | 0.3 | GPL-2.0-or-later |

Two more extensions come from Fedora packages and are not in this repository: Apps Menu (`gnome-shell-extension-apps-menu`) and Background Logo (`gnome-shell-extension-background-logo`).

### Our changes

- **AppMenu** ([patches/appmenu-v15-real-menus.patch](patches/appmenu-v15-real-menus.patch)): shows an app's real menus in the top bar. That covers apps that publish them over DBusMenu (VS Code, Chrome, Firefox) and GTK apps that publish their menu bar (LibreOffice and others). Entries are built only when a menu opens, so the bar stays fast.
- **Dash2Dock Motion** ([patches/dash2dock-motion-local.diff](patches/dash2dock-motion-local.diff)): adds Dash to Dock's own fix for a crash at logout (from Dash to Dock's pull request #2655), a guard for logout, and a lighter dock shadow in light mode.
- **Multi Monitors Bar** ([patches/multi-monitors-bar-v54.patch](patches/multi-monitors-bar-v54.patch)): the second monitor's bar copies the main bar. It shows the same items in the same order, Unite's window buttons work on it, and it gets the same blur. The overview on the second monitor is laid out like the one on the main monitor.
- **Rounded Window Corners Reborn** ([patches/rwc-v25-local.diff](patches/rwc-v25-local.diff)): a window minimized while the overview was open gets its rounded corners back when it returns.

These four copies have no version number in `metadata.json`, so extensions.gnome.org never replaces them with the unchanged versions.

## Themes, icons and cursor

- **WhiteSur GTK theme** by vinceliuice: <https://github.com/vinceliuice/WhiteSur-gtk-theme>, commit `d578265`, MIT ([themes/COPYING.WhiteSur](themes/COPYING.WhiteSur)). `WhiteSur-Light` and `WhiteSur-Dark` were built with the theme's own installer. Our change: the highlight of top-bar menus in the shell theme ([patches/whitesur-menu-highlight.diff](patches/whitesur-menu-highlight.diff)). The install also makes `WhiteSur-Light-soft`, a copy of `WhiteSur-Light` with softer backgrounds ([lib/make-soft-theme.sh](lib/make-soft-theme.sh), [lib/map-softer.json](lib/map-softer.json)).
- **MacTahoe icon theme and cursor** by vinceliuice: <https://github.com/vinceliuice/MacTahoe-icon-theme>, GPL-3.0. Not in this repository: the install downloads commit `839848b9` and runs the theme's own installer.

## Wallpapers

From KDE Plasma (<https://invent.kde.org/plasma/plasma-workspace-wallpapers>), licence CC-BY-SA-4.0:

- "Mountain" by Andy Betts
- "Sub-Arctic", "Coast", "Waterfall", "Orionids" and "Nuvole" by Krystian Zajdel

The day and night pictures were scaled and cropped from 5120×2880 PNG to 3840×2160 JPEG. These changed pictures are shared under the same licence. Details: [wallpapers/CREDITS.txt](wallpapers/CREDITS.txt).

## Terminal

- **Powerlevel10k** by Roman Perepelitsa: <https://github.com/romkatv/powerlevel10k>, MIT. Not in this repository: the install downloads commit `d05a1b0`, unless your own zsh setup loads Powerlevel10k already, and runs its gitstatus installer, which fetches the `gitstatusd` program. [terminal/p10k-base.zsh](terminal/p10k-base.zsh) is a settings file made with Powerlevel10k's configuration wizard (rainbow style), used when you have no `~/.p10k.zsh`. [terminal/p10k-macstyle.zsh](terminal/p10k-macstyle.zsh) turns the segments into round pills.
- **JetBrains Mono** by JetBrains, with icons added by **Nerd Fonts** (<https://github.com/ryanoasis/nerd-fonts>), SIL Open Font License 1.1. Not in this repository: the install downloads `JetBrainsMono.tar.xz` of Nerd Fonts v3.5.1, checks its SHA-256, and keeps four styles and `OFL.txt`.
- From Fedora's own repositories, installed with dnf and not bundled: zsh-autosuggestions (MIT), zsh-syntax-highlighting (BSD-3-Clause), fastfetch (MIT), lsd (Apache-2.0), fzf (MIT) and zoxide (MIT). These are the projects' own licences; Fedora's packages also list those of the libraries built into them.

## macstyle's own code

`install.sh`, `uninstall.sh`, [lib/](lib/), [bin/](bin/), [libexec/](libexec/), [systemd/](systemd/), [settings/](settings/), [terminal/](terminal/) (except `p10k-base.zsh`, see above) and the Downloads Fan extension, by Hilali Abdel, under the GNU General Public License 3.0 ([LICENSE](LICENSE)). The Downloads Fan files are marked GPL-2.0-or-later, which allows GPL-3.0.

## Not included

The SF Pro font belongs to Apple and is not shared here. macstyle uses it only if it is already installed on the computer.
