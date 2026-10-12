// SPDX-License-Identifier: GPL-2.0-or-later
//
// Downloads Fan: where the fan opens, and keeping the dock up while it is open.
//
// The anchor is the dock's icon for the launcher: any mapped actor whose .app has the
// launcher's id. GNOME Shell's AppIcon, Dash to Dock's DockAppIcon and Dash2Dock Motion's
// copy of it all carry .app, so nothing here depends on a particular dock.
//
// While the fan is open the icon emits 'menu-state-changed' (true, later false), the signal
// GNOME Shell's AppIcon emits around its own right-click menu. The docks listen to it: the
// dash hides the icon's tooltip and emits 'menu-opened' / 'menu-closed', on which Dash to Dock
// ignores hover changes (so autohide keeps the dock up under our modal grab) and Dash2Dock
// Motion freezes its magnification. No dock code is replaced or patched.

import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

function contains(rect, x, y) {
    return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export function extentsOf(actor) {
    const box = actor.get_transformed_extents();
    return {x: box.get_x(), y: box.get_y(), width: box.get_width(), height: box.get_height()};
}

export function monitorIndexAt(x, y) {
    const index = Main.layoutManager.monitors.findIndex(monitor => contains(monitor, x, y));
    return index >= 0 ? index : Main.layoutManager.primaryIndex;
}

function appIdOf(actor) {
    try {
        const app = actor.app;
        return app && typeof app.get_id === 'function' ? app.get_id() : null;
    } catch {
        return null;
    }
}

// Every actor below uiGroup that stands for the app; unless all is set, only visible, mapped
// ones. Window actors are skipped (they never carry .app and can be many).
export function findAppIcons(appId, {all = false} = {}) {
    const skip = new Set([global.window_group, global.top_window_group]);
    const found = [];
    const stack = [Main.layoutManager.uiGroup];
    while (stack.length > 0) {
        const actor = stack.pop();
        if (skip.has(actor) || (!all && (!actor.visible || !actor.is_mapped())))
            continue;
        if (appIdOf(actor) === appId) {
            found.push(actor);
            continue;
        }
        stack.push(...actor.get_children());
    }
    return found;
}

// Which screen edge the dock is on: the first long, thin ancestor of the icon says whether
// the dock is horizontal or vertical; the icon's half of the monitor then says which edge.
function dockSide(icon, rect, monitor) {
    for (let actor = icon.get_parent(); actor && actor !== Main.layoutManager.uiGroup;
        actor = actor.get_parent()) {
        const box = extentsOf(actor);
        if (box.width >= 2.5 * box.height && box.width >= 2 * rect.width)
            return rect.y + rect.height / 2 > monitor.y + monitor.height / 2 ? 'bottom' : 'top';
        if (box.height >= 2.5 * box.width && box.height >= 2 * rect.height)
            return rect.x + rect.width / 2 < monitor.x + monitor.width / 2 ? 'left' : 'right';
    }
    const gaps = {
        bottom: monitor.y + monitor.height - (rect.y + rect.height),
        top: rect.y - monitor.y,
        left: rect.x - monitor.x,
        right: monitor.x + monitor.width - (rect.x + rect.width),
    };
    return Object.keys(gaps).reduce((best, side) => (gaps[side] < gaps[best] ? side : best));
}

// A click on the launcher is an app launch to the dock, and Dash2Dock Motion bounces a
// launching icon (its own translation across the dock, up and back over 800 ms). Stop the
// bounce, so the fan opens from the icon at rest and nothing bounces under it. Only the axis
// across the dock: Motion's magnifier slides icons along the dock.
function stopLaunchBounce(icon, side) {
    const property = side === 'left' || side === 'right' ? 'translation_x' : 'translation_y';
    const transition = property.replace('_', '-');
    if (!icon.get_transition(transition) && icon[property] === 0)
        return false;
    icon.remove_transition(transition);
    icon[property] = 0;
    return true;
}

/**
 * Where to open: the launcher's icon on the monitor under the pointer (the one nearest the
 * pointer if there are several), else the pointer itself.
 *
 * @param {string} appId desktop file id of the launcher
 * @param {number[]} pointer [x, y] in stage coordinates
 * @returns {object|null} {icon, rect, monitorIndex, side}; icon is null for the pointer
 */
export function findAnchor(appId, pointer) {
    const [px, py] = pointer;
    const monitorIndex = monitorIndexAt(px, py);
    const monitor = Main.layoutManager.monitors[monitorIndex];
    if (!monitor)
        return null;

    let best = null;
    for (const icon of findAppIcons(appId)) {
        const rect = extentsOf(icon);
        if (rect.width < 4 || rect.height < 4)
            continue;
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        // A dock slid out of view leaves its icons outside the monitor.
        if (!contains(monitor, cx, cy))
            continue;
        const distance = Math.hypot(cx - px, cy - py);
        if (!best || distance < best.distance)
            best = {icon, rect, distance};
    }

    if (best) {
        const side = dockSide(best.icon, best.rect, monitor);
        if (stopLaunchBounce(best.icon, side))
            best.rect = extentsOf(best.icon);
        return {icon: best.icon, rect: best.rect, monitorIndex, side};
    }
    return {
        icon: null,
        rect: {x: px, y: py, width: 0, height: 0},
        monitorIndex,
        side: py > monitor.y + monitor.height / 2 ? 'bottom' : 'top',
    };
}

function hasSignal(object, name) {
    try {
        return GObject.signal_lookup(name, object.constructor.$gtype) !== 0;
    } catch {
        return false;
    }
}

/**
 * Tells the dock that its icon has a popup open, and later that it closed. open() and
 * close() pair up; close() runs at most once per open(), also from destroy().
 */
export class DockLink {
    constructor(icon) {
        this._icon = null;
        this._dash = null;
        this._iconDestroyId = 0;
        this._dashDestroyId = 0;
        this._isOpen = false;

        if (!icon || !hasSignal(icon, 'menu-state-changed'))
            return;

        this._icon = icon;
        this._iconDestroyId = icon.connect('destroy', () => {
            this._icon = null;
            this._iconDestroyId = 0;
        });

        // The dash, for the rare case that the icon goes away while the fan is open:
        // then 'menu-closed' goes to the dash directly, so the dock does not keep
        // ignoring hover.
        for (let actor = icon.get_parent(); actor; actor = actor.get_parent()) {
            if (hasSignal(actor, 'menu-closed')) {
                this._dash = actor;
                this._dashDestroyId = actor.connect('destroy', () => {
                    this._dash = null;
                    this._dashDestroyId = 0;
                });
                break;
            }
        }
    }

    open() {
        if (!this._icon || this._isOpen)
            return;
        try {
            this._icon.emit('menu-state-changed', true);
            this._isOpen = true;
        } catch (e) {
            console.warn(`Downloads Fan: could not tell the dock: ${e.message}`);
        }
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        try {
            if (this._icon)
                this._icon.emit('menu-state-changed', false);
            else if (this._dash)
                this._dash.emit('menu-closed');
        } catch (e) {
            console.warn(`Downloads Fan: could not tell the dock: ${e.message}`);
        }
    }

    destroy() {
        this.close();
        if (this._icon && this._iconDestroyId)
            this._icon.disconnect(this._iconDestroyId);
        if (this._dash && this._dashDestroyId)
            this._dash.disconnect(this._dashDestroyId);
        this._icon = null;
        this._dash = null;
        this._iconDestroyId = 0;
        this._dashDestroyId = 0;
    }
}
