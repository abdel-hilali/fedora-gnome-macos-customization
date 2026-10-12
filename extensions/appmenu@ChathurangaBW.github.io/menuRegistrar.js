// In-shell registrar for application menus.
//
// Apps that can show their menu outside the window (Electron, Chromium, Firefox
// and Qt, when they run as X11 clients) look for com.canonical.AppMenu.Registrar
// on the session bus and register one com.canonical.dbusmenu object per window,
// under the X11 window id. Nothing in a stock GNOME session owns that name, so
// AppMenu owns it while real menus are enabled, and keeps a loaded dbusmenu
// client per registered window so that a menu is ready when its window gets
// the focus.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Logger from './logger.js';

const BUS_NAME = 'com.canonical.AppMenu.Registrar';
const OBJECT_PATH = '/com/canonical/AppMenu/Registrar';
const DBUSMENU_INTERFACE = 'com.canonical.dbusmenu';
const MAX_WINDOWS = 512;
const FILL_WAIT_MS = 400;

const INTERFACE_XML = `
<node>
  <interface name="com.canonical.AppMenu.Registrar">
    <method name="RegisterWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="o" name="menuObjectPath" direction="in"/>
    </method>
    <method name="UnregisterWindow">
      <arg type="u" name="windowId" direction="in"/>
    </method>
    <method name="GetMenuForWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="s" name="service" direction="out"/>
      <arg type="o" name="menuObjectPath" direction="out"/>
    </method>
    <method name="GetMenus">
      <arg type="a(uso)" name="menus" direction="out"/>
    </method>
    <signal name="WindowRegistered">
      <arg type="u" name="windowId"/>
      <arg type="s" name="service"/>
      <arg type="o" name="menuObjectPath"/>
    </signal>
    <signal name="WindowUnregistered">
      <arg type="u" name="windowId"/>
    </signal>
  </interface>
</node>`;

class RegisteredMenu {
    constructor(Dbusmenu, windowId, service, path) {
        this.windowId = windowId;
        this.service = service;
        this.path = path;
        this._asked = new Map();    // item id -> when its submenu was asked for, in ms
        this.client = new Dbusmenu.Client({ dbus_name: service, dbus_object: path });
        this._signalIds = [
            this.client.connect(Dbusmenu.CLIENT_SIGNAL_ROOT_CHANGED, () => {
                this._asked.clear();
                this._fillSubmenus();
            }),
            this.client.connect(Dbusmenu.CLIENT_SIGNAL_LAYOUT_UPDATED, () => this._fillSubmenus()),
        ];
    }

    // Electron builds a submenu only once it is told that the submenu is about
    // to show. Ask for every empty submenu once, so that menus open complete.
    _fillSubmenus() {
        const root = this.client?.get_root();
        if (!root)
            return;

        const visit = item => {
            const children = item.get_children();
            const id = item.get_id();
            if (children.length === 0
                && item.property_get('children-display') === 'submenu'
                && !this._asked.has(id)) {
                this._asked.set(id, GLib.get_monotonic_time() / 1000);
                this.aboutToShow(id);
            }
            children.forEach(visit);
        };
        root.get_children().forEach(visit);
    }

    // True while a submenu that was asked for a moment ago is still empty.
    get filling() {
        const root = this.client?.get_root();
        if (!root)
            return false;

        const now = GLib.get_monotonic_time() / 1000;
        const waiting = item => {
            const children = item.get_children();
            if (children.length > 0)
                return children.some(waiting);
            const askedAt = this._asked.get(item.get_id());
            return askedAt !== undefined && now - askedAt < FILL_WAIT_MS;
        };
        return root.get_children().some(waiting);
    }

    aboutToShow(id) {
        Gio.DBus.session.call(
            this.service, this.path, DBUSMENU_INTERFACE, 'AboutToShow',
            new GLib.Variant('(i)', [id]), null, Gio.DBusCallFlags.NO_AUTO_START, 2000, null,
            (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch (e) {
                    Logger.debug(`AboutToShow(${id}) failed for ${this.service}${this.path}: ${e.message}`);
                }
            });
    }

    destroy() {
        for (const id of this._signalIds) {
            try { this.client.disconnect(id); } catch (_e) { /* ignore */ }
        }
        this._signalIds = [];
        this.client = null;
    }
}

export class MenuRegistrar {
    // onChanged(windowId) is called when a window gains or loses its menu.
    constructor(Dbusmenu, onChanged) {
        this._Dbusmenu = Dbusmenu;
        this._onChanged = onChanged;
        this._menus = new Map();        // window id -> RegisteredMenu
        this._watches = new Map();      // bus name of an app -> watch id
        this._exported = null;
        this._ownerId = 0;
        this._isOwner = false;
    }

    // False while another program is the registrar; that one is asked instead.
    get isOwner() {
        return this._isOwner;
    }

    start() {
        if (this._ownerId || !this._Dbusmenu)
            return;

        try {
            this._exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
            this._exported.export(Gio.DBus.session, OBJECT_PATH);
        } catch (e) {
            Logger.error(`Could not export the menu registrar: ${e}`);
            this._exported = null;
            return;
        }

        // Queued, not forced: an existing registrar keeps the name.
        this._ownerId = Gio.bus_own_name_on_connection(
            Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
            () => {
                this._isOwner = true;
                Logger.debug('Menu registrar: name acquired.');
            },
            () => {
                this._isOwner = false;
                Logger.debug('Menu registrar: name held by another program.');
            });
    }

    stop() {
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = 0;
        }
        this._isOwner = false;

        try { this._exported?.unexport(); } catch (_e) { /* ignore */ }
        this._exported = null;

        for (const menu of this._menus.values())
            menu.destroy();
        this._menus.clear();
        for (const watchId of this._watches.values())
            Gio.bus_unwatch_name(watchId);
        this._watches.clear();
    }

    destroy() {
        this.stop();
        this._onChanged = null;
    }

    lookup(windowId) {
        return this._menus.get(windowId) ?? null;
    }

    // ── D-Bus methods ─────────────────────────────────────────────────
    // The Async forms receive the invocation, which names the calling app.

    RegisterWindowAsync([windowId, path], invocation) {
        const service = invocation.get_sender();
        invocation.return_value(null);
        this._add(windowId, service, path);
    }

    UnregisterWindowAsync([windowId], invocation) {
        const service = invocation.get_sender();
        invocation.return_value(null);
        if (this._menus.get(windowId)?.service === service)
            this._remove(windowId);
    }

    GetMenuForWindow(windowId) {
        const menu = this._menus.get(windowId);
        return new GLib.Variant('(so)', menu ? [menu.service, menu.path] : ['', '/']);
    }

    GetMenus() {
        return new GLib.Variant('(a(uso))',
            [[...this._menus.values()].map(menu => [menu.windowId, menu.service, menu.path])]);
    }

    // ── bookkeeping ───────────────────────────────────────────────────

    _add(windowId, service, path) {
        if (!windowId || !service || !path)
            return;

        // An app registers again when it replaces its menu.
        this._menus.get(windowId)?.destroy();
        this._menus.delete(windowId);

        if (this._menus.size >= MAX_WINDOWS) {
            Logger.error(`Menu registrar is full; ignoring window ${windowId} of ${service}.`);
            return;
        }

        try {
            this._menus.set(windowId, new RegisteredMenu(this._Dbusmenu, windowId, service, path));
        } catch (e) {
            Logger.error(`Could not load the menu ${service}${path}: ${e}`);
            return;
        }

        if (!this._watches.has(service)) {
            this._watches.set(service, Gio.bus_watch_name_on_connection(
                Gio.DBus.session, service, Gio.BusNameWatcherFlags.NONE,
                null, () => this._removeService(service)));
        }

        Logger.debug(`Menu registered for window 0x${windowId.toString(16)}: ${service}${path}`);
        this._emit('WindowRegistered', new GLib.Variant('(uso)', [windowId, service, path]));
        this._notify(windowId);
    }

    _remove(windowId) {
        const menu = this._menus.get(windowId);
        if (!menu)
            return;

        menu.destroy();
        this._menus.delete(windowId);
        Logger.debug(`Menu unregistered for window 0x${windowId.toString(16)}.`);
        this._emit('WindowUnregistered', new GLib.Variant('(u)', [windowId]));
        this._notify(windowId);
    }

    // The app left the bus without unregistering its windows.
    _removeService(service) {
        const watchId = this._watches.get(service);
        if (watchId) {
            Gio.bus_unwatch_name(watchId);
            this._watches.delete(service);
        }
        for (const menu of [...this._menus.values()]) {
            if (menu.service === service)
                this._remove(menu.windowId);
        }
    }

    _emit(signal, parameters) {
        try {
            this._exported?.emit_signal(signal, parameters);
        } catch (e) {
            Logger.debug(`Could not emit ${signal}: ${e}`);
        }
    }

    _notify(windowId) {
        try {
            this._onChanged?.(windowId);
        } catch (e) {
            Logger.error(`Menu registrar callback failed: ${e}`);
        }
    }
}
