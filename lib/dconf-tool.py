#!/usr/bin/python3 -I
"""Small dconf jobs for install.sh and uninstall.sh.

  dconf-tool.py enable UUID... [--disable UUID...]
        add the UUIDs to org.gnome.shell enabled-extensions (and take them out of
        disabled-extensions); move the --disable ones the other way, if they are enabled
  dconf-tool.py add-favorite APP_ID
        add a launcher to the end of the dock's favourites, once
  dconf-tool.py add-to-list KEY ITEM
        add ITEM to the string list at the dconf KEY, once
  dconf-tool.py restore ORIGINAL.ini SETTINGS.dconf KEY...
        put back the extension folders named in SETTINGS.dconf and the KEYs as they were
        in ORIGINAL.ini (a `dconf dump /` taken before the first install); a key or folder
        that was not there is reset
"""
import ast
import configparser
import subprocess
import sys


def dconf(*args, stdin=None):
    return subprocess.run(['dconf', *args], input=stdin, capture_output=True, text=True,
                          check=True).stdout


def read_list(key):
    # The value in effect, so a default that Fedora sets (e.g. background-logo enabled) counts.
    name = key.rsplit('/', 1)[1]
    text = subprocess.run(['gsettings', 'get', 'org.gnome.shell', name], capture_output=True,
                          text=True, check=True).stdout.strip()
    if not text:
        return []
    if text.startswith('@as '):
        text = text[4:]
    return list(ast.literal_eval(text))


def write_list(key, items):
    dconf('write', key, '[' + ', '.join(repr(str(i)) for i in items) + ']' if items else '@as []')


def cmd_enable(args):
    enable, disable, target = [], [], None
    for a in args:
        if a == '--disable':
            target = disable
        else:
            (enable if target is None else target).append(a)
    was_on = read_list('/org/gnome/shell/enabled-extensions')
    off = read_list('/org/gnome/shell/disabled-extensions')
    on = [u for u in was_on if u not in disable] + [u for u in enable if u not in was_on]
    off = [u for u in off if u not in enable]
    off += [u for u in disable if u not in off and u in was_on]
    write_list('/org/gnome/shell/enabled-extensions', on)
    write_list('/org/gnome/shell/disabled-extensions', off)


def cmd_add_favorite(args):
    app = args[0]
    fav = read_list('/org/gnome/shell/favorite-apps')
    if app not in fav:
        write_list('/org/gnome/shell/favorite-apps', fav + [app])


def cmd_add_to_list(args):
    key, item = args
    text = dconf('read', key).strip()
    if text.startswith('@as '):
        text = text[4:]
    items = list(ast.literal_eval(text)) if text else []
    if item not in items:
        write_list(key, items + [item])


def load_ini(path):
    cp = configparser.ConfigParser(interpolation=None, strict=False, delimiters=('=',))
    cp.optionxform = str
    with open(path, encoding='utf-8') as f:
        cp.read_file(f)
    return cp


def extension_folders(settings_path):
    """Top-level dconf folder of each extension the settings file writes to."""
    folders = []
    for section in load_ini(settings_path).sections():
        parts = section.strip('/').split('/')
        # org/gnome/shell/extensions/NAME[/sub...]; reverse-DNS names keep their whole path
        depth = len(parts) if parts[4] in ('com', 'org', 'io', 'net') else 5
        folder = '/' + '/'.join(parts[:depth]) + '/'
        if folder not in folders:
            folders.append(folder)
    return folders


def cmd_restore(args):
    original, settings, keys = load_ini(args[0]), args[1], args[2:]
    for folder in extension_folders(settings):
        dconf('reset', '-f', folder)
        rel = folder.strip('/')
        lines = []
        for section in original.sections():
            if section == rel or section.startswith(rel + '/'):
                sub = section[len(rel):].strip('/') or '/'
                lines.append('[%s]' % sub)
                lines += ['%s=%s' % (k, v) for k, v in original.items(section)]
                lines.append('')
        if lines:
            dconf('load', folder, stdin='\n'.join(lines) + '\n')
    for key in keys:
        section, name = key.strip('/').rsplit('/', 1)
        if original.has_option(section, name):
            dconf('write', key, original.get(section, name))
        else:
            dconf('reset', key)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd, rest = sys.argv[1], sys.argv[2:]
    {'enable': cmd_enable, 'add-favorite': cmd_add_favorite, 'add-to-list': cmd_add_to_list,
     'restore': cmd_restore}[cmd](rest)
