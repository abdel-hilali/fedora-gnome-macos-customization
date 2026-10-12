// Reader for a menu bar that a GTK program publishes on the session bus.
//
// Programs with a classic menu bar that are built on GTK (LibreOffice, GIMP,
// Inkscape …) export it as org.gtk.Menus and the commands behind it as
// org.gtk.Actions. The window tells the compositor the bus name and the object
// paths, so nothing has to register: the window says where its menu is.
// LibreOffice takes its own menu bar out of the window as soon as a menu
// registrar is on the bus, and expects the desktop to show this one instead.
//
// A menu like that has many hundreds of entries and changes while one works
// (LibreOffice renames "Undo" with every word typed). So the reader keeps the
// whole menu loaded and watched, which is cheap, and makes the entries of one
// menu only when asked: the top-level menus and every submenu come with a
// function that lists their entries as they are at that moment.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Logger from './logger.js';
import { _ } from './i18n.js';
import { normalizeLabel, acceleratorLabel } from './menuText.js';

// A submenu that stays silent this long after it was asked for is empty.
const LOAD_WAIT_MS = 400;
const MAX_NESTING = 16;
const MAX_ROWS = 2000;      // entries of one menu
const MAX_MODELS = 6000;    // menus and sections of one menu bar
const COMPACT_AT = 1024;
const STRING = new GLib.VariantType('s');

function _now() {
    return GLib.get_monotonic_time() / 1000;
}

function _text(model, index, attribute) {
    const value = model.get_item_attribute_value(index, attribute, STRING);
    return value ? value.get_string()[0] : '';
}

export class GtkMenuBar {
    // where: { busName, menubarPath, windowPath, applicationPath }
    // onChanged() is called whenever the menu or one of its commands changed.
    constructor(where, onChanged) {
        this.busName = where.busName;
        this.menubarPath = where.menubarPath;
        this._onChanged = onChanged;
        this._models = new Map();   // menu model -> { signalId, askedAt, arrived, nesting }
        this._groups = new Map();   // action prefix -> { group, signalIds }
        this._opened = new Map();   // place of a submenu -> the command that was told "open"
        this._asked = new Set();    // commands of empty submenus that were asked for entries
        this._compactAt = COMPACT_AT;

        this._root = Gio.DBusMenuModel.get(Gio.DBus.session, where.busName, where.menubarPath);
        this._addGroup('win', where.windowPath);
        this._addGroup('app', where.applicationPath);
        this._follow(this._root, 0, false);
    }

    // The top-level menus: [{ label, children(), onOpen(), onClose() }].
    buildMenus() {
        const menus = [];
        if (!this._root)
            return menus;

        const seen = new Map();
        for (const { model, index } of this._rows(this._root, 0)) {
            if (!model.get_item_link(index, 'submenu'))
                continue;

            const label = normalizeLabel(_text(model, index, 'label'));
            const nth = seen.get(label) ?? 0;
            seen.set(label, nth + 1);
            if (label)
                menus.push(this._submenuEntry(label, [{ label, nth }]));
        }
        return menus;
    }

    destroy() {
        for (const action of this._opened.values())
            this._tell(action, false);
        this._opened.clear();

        for (const [model, entry] of this._models) {
            try { model.disconnect(entry.signalId); } catch (_e) { /* ignore */ }
        }
        this._models.clear();
        for (const entry of this._groups.values()) {
            for (const id of entry.signalIds) {
                try { entry.group.disconnect(id); } catch (_e) { /* ignore */ }
            }
        }
        this._groups.clear();
        this._root = null;
        this._onChanged = null;
    }

    // ── loading and watching ──────────────────────────────────────────

    _addGroup(prefix, path) {
        if (!path)
            return;

        try {
            const group = Gio.DBusActionGroup.get(Gio.DBus.session, this.busName, path);
            const signalIds = ['action-added', 'action-removed', 'action-enabled-changed', 'action-state-changed']
                .map(signal => group.connect(signal, () => this._changed()));
            // The first question starts the subscription; the answer comes as signals.
            group.list_actions();
            this._groups.set(prefix, { group, signalIds });
        } catch (e) {
            Logger.debug(`No actions at ${this.busName}${path}: ${e}`);
        }
    }

    // Loads and watches every menu below `model`. A menu is sent when it is
    // first asked for, one answer per submenu, so the walk goes on from each
    // answer (_onItemsChanged). A section travels with the menu it is part
    // of: it is there when that menu is, also when it is empty and silent.
    _follow(model, nesting, arrivedWithParent) {
        const entry = this._track(model, nesting);
        if (!entry || nesting > MAX_NESTING)
            return;
        if (arrivedWithParent)
            entry.arrived = true;

        const count = model.get_n_items();
        for (let index = 0; index < count; index++) {
            const section = model.get_item_link(index, 'section');
            if (section) {
                this._follow(section, nesting + 1, entry.arrived);
                continue;
            }
            const submenu = model.get_item_link(index, 'submenu');
            if (submenu && !this._models.has(submenu))
                this._follow(submenu, nesting + 1, false);
        }
    }

    _track(model, nesting) {
        let entry = this._models.get(model);
        if (entry)
            return entry;
        if (this._models.size >= MAX_MODELS)
            return null;

        entry = { signalId: 0, askedAt: _now(), arrived: false, nesting };
        entry.signalId = model.connect('items-changed', () => this._onItemsChanged(model, entry));
        // As for the actions: asking starts the subscription.
        entry.arrived = model.get_n_items() > 0;
        this._models.set(model, entry);
        return entry;
    }

    _onItemsChanged(model, entry) {
        entry.arrived = true;
        this._follow(model, entry.nesting, false);
        if (this._models.size > this._compactAt)
            this._compact();
        this._changed();
    }

    // The program replaces parts of its menu; let go of the parts that left.
    _compact() {
        const reachable = new Set();
        const visit = (model, nesting) => {
            if (reachable.has(model) || !this._models.has(model) || nesting > MAX_NESTING)
                return;

            reachable.add(model);
            const count = model.get_n_items();
            for (let index = 0; index < count; index++) {
                for (const link of ['section', 'submenu']) {
                    const linked = model.get_item_link(index, link);
                    if (linked)
                        visit(linked, nesting + 1);
                }
            }
        };
        visit(this._root, 0);

        for (const [model, entry] of this._models) {
            if (reachable.has(model))
                continue;
            try { model.disconnect(entry.signalId); } catch (_e) { /* ignore */ }
            this._models.delete(model);
        }
        this._compactAt = Math.max(COMPACT_AT, this._models.size * 2);
    }

    _changed() {
        try {
            this._onChanged?.();
        } catch (e) {
            Logger.error(`GTK menu bar callback failed: ${e}`);
        }
    }

    // ── menu tree ─────────────────────────────────────────────────────

    // The rows of a menu in the order they show. A menu is a row of sections,
    // each a menu of its own; the separators go between the sections.
    *_rows(model, nesting, state = { section: 0, count: 0 }) {
        if (nesting > MAX_NESTING)
            return;

        const count = model.get_n_items();
        for (let index = 0; index < count && state.count < MAX_ROWS; index++) {
            const section = model.get_item_link(index, 'section');
            if (!section) {
                state.count++;
                yield { model, index, section: state.section, heading: '' };
                continue;
            }

            state.section++;
            let heading = normalizeLabel(_text(model, index, 'label'));
            for (const row of this._rows(section, nesting + 1, state)) {
                row.heading ||= heading;
                heading = '';
                yield row;
            }
            state.section++;
        }
    }

    _children(model, path) {
        const children = [];
        const seen = new Map();
        let section = null;
        for (const row of this._rows(model, path.length)) {
            const entry = this._entry(row, path, seen);
            if (!entry)
                continue;

            if (row.section !== section) {
                if (children.length > 0)
                    children.push({ type: 'separator' });
                if (row.heading)
                    children.push({ type: 'section-header', label: row.heading });
                section = row.section;
            }
            children.push(entry);
        }
        return children;
    }

    _entry({ model, index }, path, seen) {
        const label = normalizeLabel(_text(model, index, 'label'));
        const submenu = model.get_item_link(index, 'submenu');
        if (!submenu)
            return label ? this._commandEntry(model, index, label) : null;

        const nth = seen.get(label) ?? 0;
        seen.set(label, nth + 1);
        if (!this._hasEntries(submenu, path.length + 1)) {
            this._askOnce(submenu, _text(model, index, 'submenu-action'));
            return { label: label || _('More'), sensitive: false };
        }
        return this._submenuEntry(label || _('More'), [...path, { label, nth }]);
    }

    // A submenu is known by its place: the labels on the way down from the
    // menu bar (and which one, if a label comes twice). The program may put
    // new objects there at any time, so the place is looked up when needed.
    _submenuEntry(label, path) {
        return {
            type: 'submenu',
            label,
            children: () => this._childrenAt(path),
            onOpen: () => this._setOpenAt(path, true),
            onClose: () => this._setOpenAt(path, false),
        };
    }

    _commandEntry(model, index, label) {
        const action = _text(model, index, 'action');
        const target = model.get_item_attribute_value(index, 'target', null);
        const command = this._command(action, target);
        const hiddenWhen = _text(model, index, 'hidden-when');
        if ((hiddenWhen === 'action-missing' && !command.exists)
            || (hiddenWhen === 'action-disabled' && !command.enabled))
            return null;

        return {
            label,
            sensitive: command.enabled,
            ornament: command.ornament,
            shortcut: acceleratorLabel(_text(model, index, 'accel')),
            activate: () => this._activate(action, target),
        };
    }

    _hasEntries(model, nesting) {
        for (const { model: menu, index } of this._rows(model, nesting)) {
            if (menu.get_item_link(index, 'submenu'))
                return true;
            const label = normalizeLabel(_text(menu, index, 'label'));
            if (label && this._commandEntry(menu, index, label))
                return true;
        }
        return false;
    }

    // The submenu at a place, with the command it wants to hear from: { submenu, action }.
    _submenuAt(path) {
        let model = this._root;
        let found = null;
        for (let depth = 0; depth < path.length && model; depth++) {
            const step = path[depth];
            found = null;
            let fallback = null;
            let nth = 0;
            for (const { model: menu, index } of this._rows(model, depth)) {
                const submenu = menu.get_item_link(index, 'submenu');
                if (!submenu || normalizeLabel(_text(menu, index, 'label')) !== step.label)
                    continue;

                const candidate = { submenu, action: _text(menu, index, 'submenu-action') };
                fallback ??= candidate;
                if (nth++ === step.nth) {
                    found = candidate;
                    break;
                }
            }
            found ??= fallback;
            model = found?.submenu ?? null;
        }
        return found;
    }

    _childrenAt(path) {
        const found = this._submenuAt(path);
        return found ? this._children(found.submenu, path) : [];
    }

    // ── commands ──────────────────────────────────────────────────────

    // "win.save" is the command "save" of the window, "app.quit" one of the program.
    _resolve(action) {
        const dot = String(action ?? '').indexOf('.');
        if (dot <= 0)
            return [null, ''];
        return [this._groups.get(action.slice(0, dot))?.group ?? null, action.slice(dot + 1)];
    }

    // Whether a command can be used now, and the mark its entry carries. The
    // rules are GTK's own: a command with a true/false state is a check box, and
    // an entry with a target value is a radio button, on when the state equals it.
    _command(action, target) {
        const none = { exists: false, enabled: false, ornament: 'none' };
        const [group, name] = this._resolve(action);
        if (!group)
            return none;

        try {
            const [exists, enabled, parameterType, , , state] = group.query_action(name);
            if (!exists)
                return none;

            let usable;
            let ornament = 'none';
            if (target) {
                usable = parameterType !== null && target.is_of_type(parameterType);
                if (state && state.get_type_string() === target.get_type_string())
                    ornament = state.equal(target) ? 'dot' : 'none';
            } else {
                usable = parameterType === null;
                if (state?.get_type_string() === 'b')
                    ornament = state.get_boolean() ? 'check' : 'none';
            }
            return { exists: true, enabled: enabled && usable, ornament };
        } catch (e) {
            Logger.debug(`Could not read the command ${action}: ${e}`);
            return none;
        }
    }

    _activate(action, target) {
        const [group, name] = this._resolve(action);
        if (!group) {
            Logger.debug(`Menu command "${action}" is gone; nothing activated.`);
            return;
        }

        try {
            group.activate_action(name, target);
        } catch (e) {
            Logger.error(`GTK menu activation failed for ${action}: ${e}`);
        }
    }

    // A submenu can name a command that the program wants to hear from while
    // the submenu is open; the program brings the entries up to date then.
    _setOpenAt(path, open) {
        const place = path.map(step => `${step.nth}:${step.label}`).join('\n');
        const action = open ? this._submenuAt(path)?.action : this._opened.get(place);
        if (!action)
            return;

        if (open)
            this._opened.set(place, action);
        else
            this._opened.delete(place);
        this._tell(action, open);
    }

    _tell(action, open) {
        const [group, name] = this._resolve(action);
        if (!group)
            return;

        try {
            group.change_action_state(name, GLib.Variant.new_boolean(open));
        } catch (e) {
            Logger.debug(`Could not tell ${action} that its menu is ${open ? 'open' : 'closed'}: ${e}`);
        }
    }

    // A submenu that has arrived empty may be filled only when it is about to show.
    _askOnce(submenu, action) {
        if (!action || this._asked.has(action))
            return;

        const entry = this._models.get(submenu);
        if (!entry || (!entry.arrived && _now() - entry.askedAt < LOAD_WAIT_MS))
            return;

        this._asked.add(action);
        this._tell(action, true);
        this._tell(action, false);
    }
}
