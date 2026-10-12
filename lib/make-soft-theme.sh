#!/usr/bin/env bash
# make-soft-theme.sh SRC OUT MAPPING.json
# Makes OUT, a GTK theme next to SRC (e.g. ~/.themes/WhiteSur-Light) whose gtk-3.0 and gtk-4.0
# stylesheets have softer backgrounds (soften-css.py with MAPPING; libadwaita's variables only
# for gtk-4.0). Everything else (assets, gtk-dark.css, gnome-shell, ...) is a link into SRC,
# so OUT stays small and follows SRC's assets. Run it again after SRC is updated.
# Written 2026-10-12 (plan 05).
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
src="$(readlink -f "$1")"; out="$2"; map="$(readlink -f "$3")"
name="$(basename "$out")"
[[ -f "$src/gtk-3.0/gtk.css" && -f "$src/gtk-4.0/gtk.css" ]] || { echo "not a GTK theme: $src" >&2; exit 1; }
rm -rf "$out.new"; mkdir -p "$out.new"
for entry in "$src"/*; do
    base="$(basename "$entry")"
    case "$base" in
        gtk-3.0|gtk-4.0) mkdir "$out.new/$base"
            for part in "$entry"/*; do
                [[ "$(basename "$part")" = gtk.css ]] || ln -s "$part" "$out.new/$base/$(basename "$part")"
            done ;;
        index.theme) sed -E "s/^(Name|GtkTheme|MetacityTheme)=.*/\1=$name/" "$entry" > "$out.new/index.theme" ;;
        *) ln -s "$entry" "$out.new/$base" ;;
    esac
done
python3 -I - "$map" "$out.new/map-gtk3.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1])); m.pop('vars', None)
json.dump(m, open(sys.argv[2], 'w'))
PY
python3 -I "$here/soften-css.py" --keep-urls "$src/gtk-3.0/gtk.css" "$out.new/gtk-3.0/gtk.css" "$out.new/map-gtk3.json"
python3 -I "$here/soften-css.py" --keep-urls "$src/gtk-4.0/gtk.css" "$out.new/gtk-4.0/gtk.css" "$map"
rm "$out.new/map-gtk3.json"
rm -rf "$out"; mv "$out.new" "$out"
echo "made $out"
