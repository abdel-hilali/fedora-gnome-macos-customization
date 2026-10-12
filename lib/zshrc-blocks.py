#!/usr/bin/python3 -I
"""The macstyle terminal's lines in ~/.zshrc, as marked blocks that can be taken out again.

  zshrc-blocks.py add ZSHRC
        an existing file gets the Fedora logo block at the top and the prompt block at the end;
        a new file gets those and Powerlevel10k's instant prompt; a file with the blocks is kept
  zshrc-blocks.py remove ZSHRC [--created]
        take the blocks out, leaving every other line; with --created (install.sh made the
        file), a file left empty is deleted
"""
import os
import re
import sys

MARK = '# >>> macstyle terminal'
LOGO = '''# >>> macstyle terminal: Fedora logo and system info in each new terminal window >>>
if [[ -o interactive && -t 1 && $TERM_PROGRAM != vscode && -z $CLAUDECODE ]] &&
   (( SHLVL == 1 && $+commands[fastfetch] )); then
  fastfetch
fi
# <<< macstyle terminal <<<
'''
INSTANT = '''# >>> macstyle terminal: Powerlevel10k instant prompt (the first prompt shows at once) >>>
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi
# <<< macstyle terminal <<<
'''
PROMPT = '''# >>> macstyle terminal: round pills prompt and zsh extras >>>
if [[ -r "${XDG_CONFIG_HOME:-$HOME/.config}/macstyle/zsh/macstyle.zsh" ]]; then
  source "${XDG_CONFIG_HOME:-$HOME/.config}/macstyle/zsh/macstyle.zsh"
fi
# <<< macstyle terminal <<<
'''
BLOCK = r'# >>> macstyle terminal.*?# <<< macstyle terminal <<<\n'


def write(path, text, mode):
    tmp = path + '.macstyle-tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def add(path):
    if os.path.exists(path):
        text = open(path, encoding='utf-8').read()
        if MARK in text:
            print('    ~/.zshrc: macstyle lines are there already')
            return
        if text and not text.endswith('\n'):
            text += '\n'
        write(path, LOGO + '\n' + text + '\n' + PROMPT, os.stat(path).st_mode & 0o7777)
        print('    ~/.zshrc: macstyle lines added (your own lines stay)')
    else:
        write(path, LOGO + '\n' + INSTANT + '\n' + PROMPT, 0o644)
        print('    ~/.zshrc: new')


def remove(path, created):
    if not os.path.exists(path):
        return
    text = open(path, encoding='utf-8').read()
    new = text
    while True:                                   # blocks at the top, with the blank line after
        stripped = re.sub(r'\A' + BLOCK + r'\n?', '', new, count=1, flags=re.S)
        if stripped == new:
            break
        new = stripped
    new = re.sub(r'\n?' + BLOCK, '', new, flags=re.S)   # the others, with the blank line before
    if new == text:
        return
    if created and not new.strip():
        os.remove(path)
    else:
        write(path, new, os.stat(path).st_mode & 0o7777)


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'add':
        add(sys.argv[2])
    elif len(sys.argv) >= 3 and sys.argv[1] == 'remove':
        remove(sys.argv[2], '--created' in sys.argv[3:])
    else:
        sys.exit(__doc__)
