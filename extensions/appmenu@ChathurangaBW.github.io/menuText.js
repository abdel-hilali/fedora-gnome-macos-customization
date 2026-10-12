// Text helpers shared by the readers of application menus.

const KEY_NAMES = new Map([
    ['Control', 'Ctrl'], ['Primary', 'Ctrl'], ['Return', 'Enter'], ['Escape', 'Esc'], ['Delete', 'Del'],
    ['space', 'Space'], ['plus', '+'], ['minus', '-'], ['equal', '='], ['comma', ','],
    ['period', '.'], ['slash', '/'], ['backslash', '\\'], ['grave', '`'],
    ['semicolon', ';'], ['apostrophe', "'"], ['bracketleft', '['], ['bracketright', ']'],
    ['Page_Up', 'PgUp'], ['Page_Down', 'PgDn'], ['BackSpace', 'Backspace'],
    ['Mod1', 'Alt'], ['Mod4', 'Super'],
]);

// A menu label without its mnemonic mark: "_File" is File, "__" is a real underscore.
export function normalizeLabel(label) {
    return String(label ?? '')
        .replace(/_(_?)/g, '$1')
        .replace(/\.\.\.$/g, '…')
        .replace(/\s+/g, ' ')
        .trim();
}

// A key or modifier name as apps send it ("Control", "n", "Page_Up"), for display.
export function keyLabel(key) {
    const name = String(key ?? '');
    return KEY_NAMES.get(name) ?? (name.length === 1 ? name.toUpperCase() : name.replace(/^KP_/, 'Num '));
}

// A GTK accelerator ("<Primary><Shift>n") as the app shows it: Ctrl+Shift+N.
export function acceleratorLabel(accel) {
    let rest = String(accel ?? '');
    const keys = [];
    for (let match = /^<([^<>]+)>/.exec(rest); match; match = /^<([^<>]+)>/.exec(rest)) {
        keys.push(match[1]);
        rest = rest.slice(match[0].length);
    }
    if (!rest)
        return '';
    return [...keys, rest].map(keyLabel).join('+');
}
