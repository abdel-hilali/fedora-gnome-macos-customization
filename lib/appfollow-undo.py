#!/usr/bin/python3 -I
"""Undo what macstyle-appfollow did: its launcher copies and the settings it wrote.

  appfollow-undo.py
A setting it only found (already set by you) stays. Chrome-like browsers must be closed for
their Preferences to change; for one that is open, the step is skipped and named.
"""
import importlib.util
import json
import os
import sys

HOME = os.path.expanduser('~')
DATA_HOME = os.environ.get('XDG_DATA_HOME') or os.path.join(HOME, '.local', 'share')
STATE_HOME = os.environ.get('XDG_STATE_HOME') or os.path.join(HOME, '.local', 'state')
STATE_FILE = os.path.join(STATE_HOME, 'macstyle-appfollow', 'state.json')
MARK = '# macstyle-appfollow: copy of '

spec = importlib.util.spec_from_file_location(
    'vscode_colors', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vscode-colors.py'))
vsc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vsc)


def chrome_running(prefs_path):
    profile_root = os.path.dirname(os.path.dirname(prefs_path))
    return os.path.lexists(os.path.join(profile_root, 'SingletonLock'))


def main():
    apps = os.path.join(DATA_HOME, 'applications')
    removed = 0
    for name in sorted(os.listdir(apps)) if os.path.isdir(apps) else []:
        path = os.path.join(apps, name)
        if not name.endswith('.desktop') or not os.path.isfile(path):
            continue
        with open(path, encoding='utf-8', errors='replace') as f:
            if any(line.startswith(MARK) for line in f):
                os.remove(path)
                removed += 1
    print('  launcher copies removed: %d' % removed)
    try:
        state = json.load(open(STATE_FILE))
    except (OSError, ValueError):
        return
    for item, what in state.get('settings', {}).items():
        if not what.startswith('set '):
            continue
        path, key = item.rsplit('#', 1)
        value = json.JSONDecoder().raw_decode(what[4:])[0]   # 'set false (new file), DATE'
        if not os.path.exists(path):
            continue
        if path.endswith('settings.json'):
            text = open(path, encoding='utf-8-sig').read()
            if json.loads(vsc.strip_jsonc(text)).get(key) == value:
                new = vsc.remove_top_level(text, key)
                json.loads(vsc.strip_jsonc(new))
                vsc.write(path, new, os.stat(path).st_mode & 0o7777)
                print('  %s: %s removed' % (path, key))
        elif path.endswith('Preferences'):
            if chrome_running(path):
                print('  %s: browser open, close it and set "Use system title bar and borders" off by hand' % path)
                continue
            data = json.load(open(path))
            section, _, leaf = key.partition('.')
            if data.get(section, {}).get(leaf) == value:
                del data[section][leaf]
                if not data[section]:
                    del data[section]
                if data:
                    vsc.write(path, json.dumps(data, separators=(',', ':')), os.stat(path).st_mode & 0o7777)
                else:   # the file held only this setting (made before the browser's first start)
                    os.remove(path)
                print('  %s: %s removed' % (path, key))


if __name__ == '__main__':
    main()
    sys.exit(0)
