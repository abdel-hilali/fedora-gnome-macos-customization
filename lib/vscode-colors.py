#!/usr/bin/python3 -I
"""VS Code (and VSCodium, Code - OSS): one colour from the title bar down, in light and dark.

The system title bar (set by macstyle-appfollow) is drawn in the GTK theme's colours. These
colour blocks make VS Code's own top area match it, so there is no seam:

  light theme in use: bars #f3f3f5 and editor #f7f7f8 (the soft WhiteSur-Light-soft values)
  dark theme in use:  shell #373737 (WhiteSur-Dark's title bar), side bar, tabs and panel in
                      the theme's own editor colour

It also sets window.autoDetectColorScheme, so VS Code follows GNOME's Dark Style. A block or
key that is already there is left alone. With --terminal, VS Code's terminal runs zsh in the
macstyle terminal font (these two keys replace other values; the old ones are recorded). Every
change is recorded, so --remove takes out exactly what was added and puts back what was
replaced (if it is still unchanged).

  vscode-colors.py STATE_DIR [--terminal]   apply
  vscode-colors.py --remove STATE_DIR       undo
"""
import glob
import json
import os
import re
import shutil
import sys

HOME = os.path.expanduser('~')
CONFIG_HOME = os.environ.get('XDG_CONFIG_HOME') or os.path.join(HOME, '.config')
APP_DIRS = ['/usr/share/code', '/usr/share/codium', '/usr/share/code-oss', '/usr/lib/code-oss',
            '/opt/visual-studio-code', '/opt/vscodium-bin']
LIGHT = {
    'modernUI.shellBackground': '#f3f3f5', 'modernUI.inactiveShellBackground': '#f3f3f5',
    'surface.border': '#00000000',
    'sideBar.background': '#f3f3f5', 'sideBarSectionHeader.background': '#f3f3f5',
    'editorGroupHeader.tabsBackground': '#f3f3f5', 'tab.inactiveBackground': '#f3f3f5',
    'panel.background': '#f3f3f5', 'activityBar.background': '#f3f3f5',
    'statusBar.background': '#f3f3f5', 'statusBar.noFolderBackground': '#f3f3f5',
    'editor.background': '#f7f7f8', 'tab.activeBackground': '#f7f7f8',
    'tab.unfocusedActiveBackground': '#f7f7f8',
}
TERMINAL = {'terminal.integrated.defaultProfile.linux': 'zsh',
            'terminal.integrated.fontFamily': "'JetBrainsMono Nerd Font', monospace"}
DARK_SHELL = {'modernUI.shellBackground': '#373737', 'modernUI.inactiveShellBackground': '#373737',
              'surface.border': '#00000000'}
DARK_PANELS = ['sideBar.background', 'sideBarSectionHeader.background',
               'editorGroupHeader.tabsBackground', 'tab.inactiveBackground', 'panel.background']
# Old theme names that VS Code maps to new ones.
RENAMED = {'Default Dark Modern': 'Dark Modern', 'Default Light Modern': 'Light Modern',
           'Default Dark+': 'Dark+', 'Default Light+': 'Light+',
           'VS Code Dark': 'Dark 2026', 'VS Code Light': 'Light 2026',
           'Experimental Dark': 'Dark 2026', 'Experimental Light': 'Light 2026'}
DEFAULTS = {'light': ['Light 2026', 'Light Modern', 'Light+'],
            'dark': ['Dark 2026', 'Dark Modern', 'Dark+']}


def strip_jsonc(text):
    """JSON with comments and trailing commas -> JSON."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == '\\' else 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith('//', i):
            j = text.find('\n', i)
            i = n if j < 0 else j
        elif text.startswith('/*', i):
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
        else:
            out.append(c)
            i += 1
    return re.sub(r',(\s*[}\]])', r'\1', ''.join(out))


def load_jsonc(path):
    with open(path, encoding='utf-8-sig') as f:
        return json.loads(strip_jsonc(f.read()))


def scan_top_level(text):
    """(key, key_start, value_start, value_end) of each top-level key of a JSONC object.
    value_end is where the value text stops (before any blank space, comma or brace)."""
    i, n, depth, found = 0, len(text), 0, []
    key, key_start, key_pending, vstart = None, None, False, None

    def close(at):
        end = vstart + len(text[vstart:at].rstrip())
        found.append((key, key_start, vstart, end))

    while i < n:
        c = text[i]
        if text.startswith('//', i):
            j = text.find('\n', i)
            i = n if j < 0 else j
            continue
        if text.startswith('/*', i):
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == '\\' else 1
            if depth == 1 and vstart is None:
                key, key_start, key_pending = json.loads(text[i:j + 1]), i, True
            i = j + 1
            continue
        if c == ':' and depth == 1 and key_pending:
            key_pending, vstart = False, i + 1
        elif c in '{[':
            depth += 1
        elif c in '}]':
            depth -= 1
            if depth == 0 and vstart is not None:
                close(i)
                vstart = None
        elif c == ',' and depth == 1 and vstart is not None:
            close(i)
            vstart = None
        i += 1
    return found


def theme_dirs(app_dir, product):
    dirs = [os.path.join(app_dir, 'resources', 'app', 'extensions')]
    data = product.get('dataFolderName')
    if data:
        dirs.append(os.path.join(HOME, data, 'extensions'))
    return dirs


def theme_file(theme, dirs):
    for d in dirs:
        for pkg in sorted(glob.glob(os.path.join(d, '*', 'package.json'))):
            try:
                themes = load_jsonc(pkg).get('contributes', {}).get('themes', [])
            except (OSError, ValueError):
                continue
            for t in themes:
                if theme in (t.get('id'), t.get('label')) and t.get('path'):
                    return os.path.normpath(os.path.join(os.path.dirname(pkg), t['path']))
    return None


def editor_background(path, depth=0):
    if not path or depth > 5:
        return None
    try:
        data = load_jsonc(path)
    except (OSError, ValueError):
        return None
    colour = (data.get('colors') or {}).get('editor.background')
    if colour:
        return colour
    if data.get('include'):
        return editor_background(os.path.join(os.path.dirname(path), data['include']), depth + 1)
    return None


def pick_theme(settings, kind, dirs):
    name = settings.get('workbench.preferred%sColorTheme' % kind.capitalize())
    if name:
        return RENAMED.get(name, name)
    for name in DEFAULTS[kind]:
        if theme_file(name, dirs):
            return name
    return DEFAULTS[kind][0]


def write(path, text, mode):
    tmp = path + '.macstyle-tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def set_top_level(text, key, value):
    """Return text with the top-level KEY set to VALUE (added after the first brace if new)."""
    entries = scan_top_level(text)
    for k, kstart, vstart, vend in entries:
        if k == key:
            indent = text[text.rfind('\n', 0, kstart) + 1:kstart]
            indent = indent if not indent.strip() else '    '
            body = json.dumps(value, indent=4).replace('\n', '\n' + indent)
            return text[:vstart] + ' ' + body + text[vend:]
    at = text.find('{')
    after = text[at + 1:]
    m = re.search(r'\n([ \t]+)\S', after)
    indent = m.group(1) if m else '    '
    body = json.dumps(value, indent=4).replace('\n', '\n' + indent)
    return text[:at + 1] + '\n%s%s: %s%s' % (indent, json.dumps(key), body,
                                             ',' if entries else '') + after


def remove_top_level(text, key):
    """Return text without the top-level KEY; comments around it stay."""
    entries = scan_top_level(text)
    for idx, (k, kstart, vstart, vend) in enumerate(entries):
        if k != key:
            continue
        line_start = text.rfind('\n', 0, kstart) + 1
        start = line_start if not text[line_start:kstart].strip() else kstart
        if idx + 1 < len(entries):            # a comma follows: cut through it and its line end
            end = text.index(',', vend) + 1
            m = re.match(r'[ \t]*\n', text[end:])
            return text[:start] + text[end + (m.end() if m else 0):]
        head = text[:start]
        if idx > 0:                           # last key: drop the comma after the key before it
            comma = text.index(',', entries[idx - 1][3])
            head = head[:comma] + head[comma + 1:]
        tail = text[vend:].lstrip(',')
        if head.endswith('\n') and tail.startswith('\n'):
            tail = tail[1:]
        return head + tail
    return text


def apps():
    for app_dir in APP_DIRS:
        product_path = os.path.join(app_dir, 'resources', 'app', 'product.json')
        if os.path.exists(product_path):
            try:
                yield app_dir, load_jsonc(product_path)
            except (OSError, ValueError):
                continue


def apply(state_dir, terminal=False):
    record_path = os.path.join(state_dir, 'vscode.json')
    try:
        records = json.load(open(record_path))
    except (OSError, ValueError):
        records = {}
    done_paths = set()
    for app_dir, product in apps():
        name = product.get('nameShort') or 'Code'
        path = os.path.join(CONFIG_HOME, name, 'User', 'settings.json')
        if path in done_paths:
            continue
        done_paths.add(path)
        text = open(path, encoding='utf-8-sig').read() if os.path.exists(path) else '{\n}\n'
        try:
            settings = json.loads(strip_jsonc(text)) if text.strip() else {}
        except ValueError:
            print('  %s: could not be read, left alone' % path)
            continue
        dirs = theme_dirs(app_dir, product)
        rec = records.setdefault(path, {'keys': {}, 'blocks': {}})
        replaced = rec.setdefault('replaced', {})
        new = text if text.strip() else '{\n}\n'
        if 'window.autoDetectColorScheme' not in settings:
            new = set_top_level(new, 'window.autoDetectColorScheme', True)
            rec['keys']['window.autoDetectColorScheme'] = True
        term = []
        for key, value in (TERMINAL.items() if terminal else ()):
            if key not in settings:
                rec['keys'][key] = value
            elif settings[key] != value and key not in replaced:
                replaced[key] = {'old': settings[key], 'new': value}
            else:
                continue
            new = set_top_level(new, key, value)
            term.append(key)
        colours = dict(settings.get('workbench.colorCustomizations') or {})
        light = pick_theme(settings, 'light', dirs)
        dark = pick_theme(settings, 'dark', dirs)
        added = []
        if '[%s]' % light not in colours:
            colours['[%s]' % light] = dict(LIGHT)
            added.append('[%s]' % light)
        if '[%s]' % dark not in colours:
            bg = editor_background(theme_file(dark, dirs))
            if bg:
                block = dict(DARK_SHELL)
                block.update({k: bg for k in DARK_PANELS})
                colours['[%s]' % dark] = block
                added.append('[%s]' % dark)
            else:
                print('  %s: colours of the dark theme "%s" not found, dark block skipped' % (name, dark))
        for b in added:
            rec['blocks'][b] = colours[b]
        if added:
            if 'workbench.colorCustomizations' not in settings:
                rec['created_colours'] = True
            new = set_top_level(new, 'workbench.colorCustomizations', colours)
        if new == text:
            print('  %s: nothing to add' % name)
            continue
        check = json.loads(strip_jsonc(new))
        if any(check['workbench.colorCustomizations'].get(b) != colours[b] for b in added):
            print('  %s: the edit did not check out, not written' % name)
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path):
            backup = os.path.join(state_dir, 'backup', 'vscode-' + name.replace(' ', '_') + '-settings.json')
            os.makedirs(os.path.dirname(backup), exist_ok=True)
            if not os.path.exists(backup):
                shutil.copy2(path, backup)
            mode = os.stat(path).st_mode & 0o7777
        else:
            mode = 0o644
        write(path, new, mode)
        print('  %s: light "%s", dark "%s"%s%s' % (name, light, dark,
              ' (colour blocks added)' if added else '',
              '; terminal: zsh, JetBrainsMono Nerd Font' if term else ''))
    os.makedirs(state_dir, exist_ok=True)
    with open(record_path, 'w') as f:
        json.dump(records, f, indent=2)


def remove(state_dir):
    record_path = os.path.join(state_dir, 'vscode.json')
    try:
        records = json.load(open(record_path))
    except (OSError, ValueError):
        return
    for path, rec in records.items():
        if not os.path.exists(path):
            continue
        text = open(path, encoding='utf-8-sig').read()
        try:
            settings = json.loads(strip_jsonc(text))
        except ValueError:
            print('  %s: could not be read, left alone' % path)
            continue
        new = text
        for key, value in rec.get('keys', {}).items():
            if settings.get(key) == value:
                new = remove_top_level(new, key)
        for key, change in rec.get('replaced', {}).items():
            if settings.get(key) == change['new']:
                new = set_top_level(new, key, change['old'])
        colours = dict(json.loads(strip_jsonc(new)).get('workbench.colorCustomizations') or {})
        changed = False
        for block, value in rec.get('blocks', {}).items():
            if colours.get(block) == value:
                del colours[block]
                changed = True
        if changed and not colours and rec.get('created_colours'):
            new = remove_top_level(new, 'workbench.colorCustomizations')
        elif changed:
            new = set_top_level(new, 'workbench.colorCustomizations', colours)
        if new != text:
            json.loads(strip_jsonc(new))  # never write a broken file
            write(path, new, os.stat(path).st_mode & 0o7777)
            print('  %s: macstyle colours and keys removed' % path)
    os.remove(record_path)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--remove':
        remove(sys.argv[2])
    elif len(sys.argv) in (2, 3) and not sys.argv[1].startswith('--'):
        apply(sys.argv[1], terminal=sys.argv[2:] == ['--terminal'])
    else:
        sys.exit(__doc__)
