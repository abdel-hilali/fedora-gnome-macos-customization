import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Logger from './logger.js';
import { _ } from './i18n.js';
import { MenuRegistrar } from './menuRegistrar.js';
import { GtkMenuBar } from './gtkMenuBar.js';
import { normalizeLabel as _normalizeLabel, keyLabel } from './menuText.js';

// dbusmenu is optional. Fedora minimal installations and GTK-action-only apps
// must still be able to load AppMenu without the typelib installed.
let Dbusmenu = null;
try {
    const GIRepository = imports.gi.GIRepository;
    GIRepository.Repository.dup_default().require('Dbusmenu', '0.4', 0);
    Dbusmenu = imports.gi.Dbusmenu;
} catch (_e) {
    Logger.debug('Dbusmenu typelib unavailable; using GTK actions and fallback menus.');
}

const REGISTRAR_BUS_NAME = 'com.canonical.AppMenu.Registrar';
const REGISTRAR_OBJECT_PATH = '/com/canonical/AppMenu/Registrar';
const REGISTRAR_INTERFACE = 'com.canonical.AppMenu.Registrar';
const GTK_ACTIONS_INTERFACE = 'org.gtk.Actions';
const DBUSMENU_INTERFACE = 'com.canonical.dbusmenu';
// An app's menu changes arrive in bursts; pass them on once, a moment later.
const CHANGE_DELAY_MS = 40;
const CHANGE_MAX_TRIES = 12;
// Windows whose GTK menu bar stays loaded, so that it is there at once when
// the window gets the focus again.
const MAX_GTK_MENU_BARS = 24;

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

// ── well-known action → human label ──────────────────────────────────────
const KNOWN_LABELS = new Map([
    // App menu
    ['about', 'About'],
    ['preferences', 'Settings'],
    ['options', 'Settings'],
    ['quit', 'Quit'],
    ['exit', 'Quit'],
    ['close', 'Close'],
    ['help', 'Help'],
    ['keyboard-shortcuts', 'Keyboard Shortcuts'],
    ['shortcuts', 'Keyboard Shortcuts'],
    ['make-default', 'Make Default'],
    ['show-diagnostics', 'Diagnostics'],

    // File menu
    ['new-window', 'New Window'],
    ['clone-window', 'New Window'],
    ['tepl-new-window', 'New Window'],
    ['new-tab', 'New Tab'],
    ['new-document', 'New Document'],
    ['open', 'Open…'],
    ['open-document', 'Open…'],
    ['open-recent', 'Open Recent'],
    ['save', 'Save'],
    ['save-as', 'Save As…'],
    ['save-copy', 'Save a Copy…'],
    ['save-all', 'Save All'],
    ['revert', 'Revert'],
    ['print', 'Print…'],
    ['print-preview', 'Print Preview'],
    ['page-setup', 'Page Setup…'],
    ['export', 'Export…'],
    ['export-as', 'Export As…'],
    ['import', 'Import…'],
    ['send-to', 'Send To…'],
    ['share', 'Share…'],
    ['close-tab', 'Close Tab'],
    ['close-window', 'Close Window'],
    ['close-all', 'Close All'],
    ['show-file-transfers', 'File Transfers'],
    ['search-settings', 'Search Settings'],
    ['properties', 'Properties'],

    // Edit menu
    ['undo', 'Undo'],
    ['redo', 'Redo'],
    ['cut', 'Cut'],
    ['copy', 'Copy'],
    ['paste', 'Paste'],
    ['paste-special', 'Paste Special'],
    ['delete', 'Delete'],
    ['select-all', 'Select All'],
    ['deselect', 'Deselect'],
    ['find', 'Find…'],
    ['find-replace', 'Find and Replace…'],
    ['find-next', 'Find Next'],
    ['find-previous', 'Find Previous'],
    ['replace', 'Replace…'],
    ['go-to-line', 'Go to Line…'],
    ['go-to', 'Go To…'],
    ['clear-history', 'Clear History'],
    ['remove-recent', 'Clear Recent'],
    ['insert-emoji', 'Emoji & Symbols'],
    ['insert-symbol', 'Insert Symbol'],

    // View menu
    ['zoom-in', 'Zoom In'],
    ['zoom-out', 'Zoom Out'],
    ['zoom-default', 'Actual Size'],
    ['zoom-normal', 'Actual Size'],
    ['zoom-reset', 'Actual Size'],
    ['fullscreen', 'Full Screen'],
    ['toggle-fullscreen', 'Full Screen'],
    ['reload', 'Reload'],
    ['refresh', 'Refresh'],
    ['show-menubar', 'Show Menu Bar'],
    ['show-toolbar', 'Show Toolbar'],
    ['show-statusbar', 'Show Status Bar'],
    ['show-sidebar', 'Show Sidebar'],
    ['show-side-panel', 'Show Side Panel'],
    ['show-tabs', 'Show Tabs'],
    ['show-hidden-files', 'Show Hidden Files'],
    ['show-details', 'Show Details'],
    ['show-grid', 'Show as Grid'],
    ['show-list', 'Show as List'],
    ['sort-ascending', 'Sort Ascending'],
    ['sort-descending', 'Sort Descending'],
    ['sort-by-name', 'Sort by Name'],
    ['sort-by-date', 'Sort by Date'],
    ['sort-by-size', 'Sort by Size'],
    ['sort-by-type', 'Sort by Type'],
    ['filter', 'Filter…'],
    ['style-scheme', 'Color Scheme'],

    // Format / Text
    ['bold', 'Bold'],
    ['italic', 'Italic'],
    ['underline', 'Underline'],
    ['strikethrough', 'Strikethrough'],
    ['font', 'Font…'],
    ['text-direction', 'Text Direction'],
    ['align-left', 'Align Left'],
    ['align-center', 'Align Center'],
    ['align-right', 'Align Right'],
    ['align-justify', 'Justify'],
    ['indent', 'Indent'],
    ['unindent', 'Unindent'],
    ['increase-indent', 'Increase Indent'],
    ['decrease-indent', 'Decrease Indent'],
    ['bullet-list', 'Bullet List'],
    ['numbered-list', 'Numbered List'],
    ['toggle-list', 'Toggle List'],

    // Tools
    ['spell-check', 'Spell Check'],
    ['check-spelling', 'Spell Check'],
    ['word-count', 'Word Count'],
    ['document-statistics', 'Document Statistics'],
    ['highlight-mode', 'Highlight Mode'],
    ['comment', 'Comment'],
]);

// ── action category matchers ─────────────────────────────────────────────
function _categoryForAction(name) {
    const n = name.toLowerCase();

    // App menu actions — exclude help/about (those go to Help menu)
    if (/^(preferences|options|quit|exit|close$|make-default|show-diagnostics|diagnostics)$/.test(n))
        return 'app';

    // File actions — prefix-based
    if (/^(new-|clone-|tepl-|open|save|print|export|import|revert|send-|share|close-tab|close-window|close-all|page-setup|show-file|search-settings|properties)/.test(n))
        return 'file';

    // Edit actions
    if (/^(undo|redo|cut|copy|paste|delete|select-all|deselect|find|replace|go-to|clear-history|remove-recent|insert-)/.test(n))
        return 'edit';

    // View actions
    if (/^(zoom-|fullscreen|toggle-fullscreen|reload|refresh|show-|sort-|filter|style-scheme)/.test(n))
        return 'view';

    // Format actions
    if (/^(bold|italic|underline|strikethrough|font|text-direction|align-|indent|unindent|increase-indent|decrease-indent|bullet-|numbered-|toggle-list)/.test(n))
        return 'format';

    // Tools
    if (/^(spell|check-spelling|word-count|document-statistics|highlight-|comment)/.test(n))
        return 'tools';

    // Help (only when not already in app menu)
    if (/^(help|about|shortcuts|keyboard-shortcuts)/.test(n))
        return 'help';

    return 'other';
}

// ── label helpers ─────────────────────────────────────────────────────────
function _labelForAction(name) {
    const known = KNOWN_LABELS.get(name);
    if (known)
        return _(known);
    return _humanizeActionName(name);
}

function _humanizeActionName(name) {
    return String(name ?? '')
        .replace(/_/g, ' ')
        .split(/[-.]/g)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

// ── dbusmenu helpers ──────────────────────────────────────────────────────
function _isVisible(item) {
    return !item.property_exist(Dbusmenu.MENUITEM_PROP_VISIBLE)
        || item.property_get_bool(Dbusmenu.MENUITEM_PROP_VISIBLE);
}

function _visibleChildren(item) {
    return item.get_children().filter(child => _isVisible(child));
}

// X11 clients register their menu under the X11 window id, which mutter keeps
// in the window description ("0x1a00004"). A Wayland window has no such id.
function _x11WindowId(window) {
    try {
        if (window?.get_client_type?.() !== Meta.WindowClientType.X11)
            return 0;
        const match = /0x[0-9a-f]+/i.exec(window.get_description() ?? '');
        return match ? parseInt(match[0], 16) : 0;
    } catch (_e) {
        return 0;
    }
}

// The windows whose menu serves a window: itself, and for a dialog the window
// it belongs to, since a dialog has no menu of its own. Not for a modal
// dialog: the app takes no commands while one is open, though some (LibreOffice)
// leave every entry of the menu enabled.
function _menuWindows(window) {
    const windows = [];
    try {
        for (let w = window, depth = 0; w && depth < 5; depth++) {
            windows.push(w);
            if (w.get_window_type() === Meta.WindowType.MODAL_DIALOG)
                break;
            w = w.get_transient_for?.() ?? null;
        }
    } catch (_e) {
        // A window that is going away.
    }
    return windows;
}

function _menuWindowIds(window) {
    return _menuWindows(window).map(_x11WindowId).filter(Boolean);
}

// A GTK program names its menu bar on the window.
function _gtkMenuBarWindow(window) {
    return _menuWindows(window).find(w =>
        w.get_gtk_menubar_object_path?.() && w.get_gtk_unique_bus_name?.()) ?? null;
}

// The "shortcut" property lists key combinations, each a list of key names:
// [['Control', 'Shift', 'n']]. Shown next to the item, like in the app.
function _shortcutText(item) {
    try {
        const keys = item.property_get_variant(Dbusmenu.MENUITEM_PROP_SHORTCUT)?.deepUnpack()?.[0];
        if (!Array.isArray(keys) || keys.length === 0)
            return '';
        return keys.map(keyLabel).join('+');
    } catch (_e) {
        return '';
    }
}

// Electron cannot give a two-step shortcut as a shortcut, so VS Code writes it
// into the label: "Open Folder... [Ctrl+K Ctrl+O]". Split it off again.
function _splitLabelHint(rawLabel) {
    const match = /^(.*\S)\s+\[([^\[\]]+)\]$/.exec(String(rawLabel ?? ''));
    return match ? [match[1], match[2]] : [rawLabel, ''];
}

// What a menu model shows, without the callbacks. Two models with the same
// signature look the same on screen.
function _modelSignature(model) {
    return JSON.stringify(model ?? null, (_key, value) => typeof value === 'function' ? undefined : value);
}

function _unpackGtkActionDetails(details) {
    if (Array.isArray(details)) {
        return {
            enabled: Boolean(details[0]),
            parameterType: String(details[1] ?? ''),
            state: details[2],
        };
    }

    return {
        enabled: details?.enabled !== false,
        parameterType: String(details?.['parameter-type'] ?? ''),
        state: details?.state,
    };
}

function _isEnabled(item) {
    return !item.property_exist(Dbusmenu.MENUITEM_PROP_ENABLED)
        || item.property_get_bool(Dbusmenu.MENUITEM_PROP_ENABLED);
}

function _isSeparator(item) {
    return item.property_exist(Dbusmenu.MENUITEM_PROP_TYPE)
        && item.property_get(Dbusmenu.MENUITEM_PROP_TYPE) === Dbusmenu.CLIENT_TYPES_SEPARATOR;
}

function _getOrnament(item) {
    if (!item.property_exist(Dbusmenu.MENUITEM_PROP_TOGGLE_TYPE))
        return 'none';

    const toggleType = item.property_get(Dbusmenu.MENUITEM_PROP_TOGGLE_TYPE);
    const toggleState = item.property_exist(Dbusmenu.MENUITEM_PROP_TOGGLE_STATE)
        ? item.property_get_int(Dbusmenu.MENUITEM_PROP_TOGGLE_STATE)
        : Dbusmenu.MENUITEM_TOGGLE_STATE_UNKNOWN;

    if (toggleState !== Dbusmenu.MENUITEM_TOGGLE_STATE_CHECKED)
        return 'none';

    if (toggleType === Dbusmenu.MENUITEM_TOGGLE_RADIO)
        return 'dot';
    if (toggleType === Dbusmenu.MENUITEM_TOGGLE_CHECK)
        return 'check';
    return 'none';
}

// ── GTK action state → ornament ──────────────────────────────────────────
function _gtkActionOrnament(action) {
    // GTK action state: a GLib.Variant with the current state value.
    // Boolean true  → check ornament,  a string → radio ornament.
    if (action.state === undefined || action.state === null)
        return 'none';

    const typeString = action.state.get_type_string?.() ?? '';
    if (typeString === 'b') {
        return action.state.get_boolean() ? 'check' : 'none';
    }
    if (typeString === 's') {
        // radio-like: state is a string (e.g. the selected style scheme)
        return 'dot';
    }
    return 'none';
}

function _isAppMenuLabel(label, appName) {
    const normalized = _normalizeLabel(label).toLowerCase();
    const normalizedAppName = _normalizeLabel(appName).toLowerCase();
    if (!normalized)
        return false;

    return normalized === normalizedAppName
        || normalized === 'application'
        || normalized === 'app'
        || normalized === 'menu';
}

function _desktopIdToBusName(appId) {
    if (!appId)
        return null;

    const normalized = String(appId).replace(/\.desktop$/i, '').trim();
    return normalized.length > 0 ? normalized : null;
}

function _busNameToObjectPath(busName) {
    if (!busName)
        return null;
    return `/${busName.replace(/\./g, '/')}`;
}

// Probe only an already-owned application bus. Activating an app just to
// inspect its menu is surprising, and synchronous probes freeze GNOME Shell.
async function _probeGtkActions(busName, objectPath, cancellable) {
    try {
        const result = await Gio.DBus.session.call(
            busName, objectPath,
            GTK_ACTIONS_INTERFACE, 'DescribeAll',
            null, null, Gio.DBusCallFlags.NONE, 2000, cancellable
        );
        const [descriptions] = result.deepUnpack();
        if (!descriptions || Object.keys(descriptions).length === 0)
            return null;
        return Object.entries(descriptions)
            .map(([name, details]) => ({name, objectPath, ..._unpackGtkActionDetails(details)}))
            .filter(a => a.parameterType === '');
    } catch (_e) {
        return null;
    }
}

// ── RealMenuManager ──────────────────────────────────────────────────────
export class RealMenuManager {
    // onChanged() is called when the bar has to show other menus, and
    // onContentChanged() when only entries inside the menus changed.
    constructor(settings, onChanged, onContentChanged = null) {
        this._settings = settings;
        this._onChanged = onChanged;
        this._onContentChanged = onContentChanged;
        this._client = null;
        this._clientSignalIds = [];
        this._currentKey = null;
        this._currentRegistration = null;
        this._currentAppName = '';
        this._backendType = null;
        this._currentGtkContext = null;
        this._cachedActions = null;
        this._cachedWinActions = null;
        this._currentWindow = null;
        this._requestGeneration = 0;
        this._requestCancellable = null;
        this._registrarFailed = false;
        this._isWayland = (GLib.getenv('XDG_SESSION_TYPE') ?? '').toLowerCase() === 'wayland';
        this._currentDetectedApp = null;
        this._currentWmClass = '';
        this._shownSignature = null;
        this._changeTimeoutId = 0;
        this._changeTries = 0;
        this._gtkMenuBars = new Map();      // window -> { window, bar, unmanagedId }
        this._watchedWindow = null;
        this._watchedWindowIds = [];
        this._registrar = new MenuRegistrar(Dbusmenu, windowId => this._onRegistrationChanged(windowId));
        this._syncRegistrar();
    }

    // The window whose menu is shown. While one of the menus is open the shell
    // may report no focused window, so updates should go to this one.
    get currentWindow() {
        return this._currentWindow;
    }

    // Be the registrar only while real menus are wanted.
    _syncRegistrar() {
        if (this.enabled)
            this._registrar.start();
        else
            this._registrar.stop();
    }

    get enabled() {
        try {
            return this._settings?.get_boolean('use-real-menus') ?? true;
        } catch (_e) {
            return true;
        }
    }

    invalidate() {
        this._cancelRequest();
        this._unwatchWindow();
        this._currentWindow = null;
        this._cachedActions = null;
        this._cachedWinActions = null;
        this._registrarFailed = false;
        this._setBackend(null, null);
        this._dropGtkMenuBars();
        this._syncRegistrar();
    }

    destroy() {
        this._cancelRequest();
        this._unwatchWindow();
        this._currentWindow = null;
        this._cachedActions = null;
        this._cachedWinActions = null;
        this._registrarFailed = false;
        this._setBackend(null, null);
        this._dropGtkMenuBars();
        this._registrar.destroy();
        this._currentDetectedApp = null;
        this._settings = null;
        this._onChanged = null;
        this._onContentChanged = null;
    }

    updateForWindow(window, appName = '', detectedApp = null, wmClass = '') {
        this._currentAppName = appName;

        if (!this.enabled || !window) {
            this._cancelRequest();
            this._unwatchWindow();
            this._currentWindow = null;
            this._cachedActions = null;
            this._setBackend(null, null);
            return null;
        }

        if (window !== this._currentWindow)
            this._startLookup(window, detectedApp, wmClass);
        return this.buildCurrentMenuModel(appName);
    }

    _cancelRequest() {
        this._requestGeneration++;
        this._requestCancellable?.cancel();
        this._requestCancellable = null;
    }

    _isCurrentRequest(generation, window) {
        return !this._requestCancellable?.is_cancelled()
            && generation === this._requestGeneration
            && window === this._currentWindow;
    }

    _startLookup(window, detectedApp, wmClass) {
        this._cancelRequest();
        this._currentWindow = window;
        this._currentDetectedApp = detectedApp;
        this._currentWmClass = wmClass;
        this._cachedActions = null;
        this._cachedWinActions = null;
        this._setBackend(null, null);

        const generation = this._requestGeneration;
        this._requestCancellable = new Gio.Cancellable();
        const cancellable = this._requestCancellable;

        this._watchWindow(window);
        this._requestRegistration(window, generation, cancellable);
        if (this._backendType !== 'dbusmenu')
            this._useGtkMenuBar(window);
        this._requestGtkActions(detectedApp, wmClass, generation, cancellable);
    }

    // A window names its GTK menu bar a moment after it appears, which can be
    // after it got the focus.
    _watchWindow(window) {
        this._unwatchWindow();
        try {
            this._watchedWindowIds = ['notify::gtk-menubar-object-path', 'notify::gtk-unique-bus-name']
                .map(signal => window.connect(signal, () => this._onWindowMenuBarChanged(window)));
            this._watchedWindow = window;
        } catch (_e) {
            this._watchedWindowIds = [];
        }
    }

    _unwatchWindow() {
        for (const id of this._watchedWindowIds) {
            try { this._watchedWindow.disconnect(id); } catch (_e) { /* ignore */ }
        }
        this._watchedWindowIds = [];
        this._watchedWindow = null;
    }

    _onWindowMenuBarChanged(window) {
        if (window !== this._currentWindow || !this.enabled)
            return;

        this._startLookup(window, this._currentDetectedApp, this._currentWmClass);
        this._emitChanged();
    }

    // A menu arrived or left after its window got the focus: apps register a
    // moment after they show the window, and again when they replace the menu.
    _onRegistrationChanged(windowId) {
        const window = this._currentWindow;
        if (!window || !this.enabled || !_menuWindowIds(window).includes(windowId))
            return;

        this._startLookup(window, this._currentDetectedApp, this._currentWmClass);
        this._emitChanged();
    }

    async _requestRegistration(window, generation, cancellable) {
        if (!Dbusmenu)
            return;

        const windowIds = _menuWindowIds(window);
        if (windowIds.length === 0)
            return;

        // Our own registrar answers from memory, with the menu already loaded.
        for (const id of windowIds) {
            const menu = this._registrar.lookup(id);
            if (menu) {
                this._setBackend('dbusmenu', { service: menu.service, path: menu.path, menu });
                return;
            }
        }
        if (this._registrar.isOwner)
            return;

        // Another program is the registrar: ask it.
        try {
            const result = await Gio.DBus.session.call(
                REGISTRAR_BUS_NAME, REGISTRAR_OBJECT_PATH, REGISTRAR_INTERFACE,
                'GetMenuForWindow', new GLib.Variant('(u)', [windowIds[0]]),
                new GLib.VariantType('(so)'), Gio.DBusCallFlags.NONE, 1000, cancellable
            );
            if (!this._isCurrentRequest(generation, window))
                return;

            const [service, path] = result.deepUnpack();
            if (!service || !path || path === '/')
                return;

            this._setBackend('dbusmenu', { service, path });
            this._emitChanged();
        } catch (_e) {
            // No registrar, or no menu for this window.
        }
    }

    async _requestGtkActions(detectedApp, wmClass, generation, cancellable) {
        const appId = detectedApp?.get_id?.() ?? wmClass;
        const busName = _desktopIdToBusName(appId);
        const objectPath = _busNameToObjectPath(busName);
        if (!busName || !objectPath)
            return;

        const actions = await _probeGtkActions(busName, objectPath, cancellable);
        if (!actions || !this._isCurrentRequest(generation, this._currentWindow))
            return;
        if (this._backendType === 'dbusmenu')
            return;

        const context = { busName, objectPath, appId };
        // Next to a GTK menu bar the actions only stand in while that is empty.
        if (this._backendType === 'gtk-menus')
            this._currentGtkContext = context;
        else
            this._setBackend('gtk-actions', context);
        this._cachedActions = actions;

        const winActions = await _probeGtkActions(busName, `${objectPath}/window/1`, cancellable);
        if (!this._isCurrentRequest(generation, this._currentWindow))
            return;
        if (this._backendType === 'dbusmenu')
            return;

        this._cachedWinActions = winActions;
        this._emitChanged();
    }

    buildCurrentMenuModel(appName = '') {
        if (this._backendType === 'dbusmenu' || this._backendType === 'gtk-menus') {
            const model = this._buildExportedMenuModel(appName);
            this._shownSignature = _modelSignature(model);
            if (model || this._backendType === 'dbusmenu')
                return model;
        }
        if (this._backendType === 'gtk-actions' || this._backendType === 'gtk-menus')
            return this._buildGtkActionMenuModel();
        return null;
    }

    // The menu as the app itself publishes it.
    _buildExportedMenuModel(appName = '') {
        return this._backendType === 'gtk-menus'
            ? this._buildGtkMenuBarModel(appName)
            : this._buildDbusMenuModel(appName);
    }

    // ── GTK menu bar backend ──────────────────────────────────────────

    _useGtkMenuBar(window) {
        const owner = _gtkMenuBarWindow(window);
        const entry = owner ? this._gtkMenuBarFor(owner) : null;
        if (entry)
            this._setBackend('gtk-menus', entry);
    }

    // One reader per window, kept while the window lives.
    _gtkMenuBarFor(window) {
        const where = {
            busName: window.get_gtk_unique_bus_name(),
            menubarPath: window.get_gtk_menubar_object_path(),
            windowPath: window.get_gtk_window_object_path(),
            applicationPath: window.get_gtk_application_object_path(),
        };

        let entry = this._gtkMenuBars.get(window);
        if (entry && (entry.bar.busName !== where.busName || entry.bar.menubarPath !== where.menubarPath)) {
            this._dropGtkMenuBar(window);
            entry = null;
        }
        // The most recently used one goes last.
        this._gtkMenuBars.delete(window);

        if (!entry) {
            try {
                entry = { window, bar: null, unmanagedId: 0 };
                entry.bar = new GtkMenuBar(where, () => this._onGtkMenuBarChanged(entry));
                entry.unmanagedId = window.connect('unmanaged', () => this._dropGtkMenuBar(window));
            } catch (e) {
                Logger.error(`Could not read the GTK menu bar ${where.busName}${where.menubarPath}: ${e}`);
                entry?.bar?.destroy();
                return null;
            }
        }
        this._gtkMenuBars.set(window, entry);

        while (this._gtkMenuBars.size > MAX_GTK_MENU_BARS)
            this._dropGtkMenuBar(this._gtkMenuBars.keys().next().value);
        return entry;
    }

    _dropGtkMenuBar(window) {
        const entry = this._gtkMenuBars.get(window);
        if (!entry)
            return;

        this._gtkMenuBars.delete(window);
        if (this._currentRegistration === entry)
            this._setBackend(null, null);
        try { window.disconnect(entry.unmanagedId); } catch (_e) { /* ignore */ }
        entry.bar.destroy();
    }

    _dropGtkMenuBars() {
        for (const window of [...this._gtkMenuBars.keys()])
            this._dropGtkMenuBar(window);
    }

    _onGtkMenuBarChanged(entry) {
        if (this._currentRegistration === entry)
            this._onClientChanged();
    }

    _buildGtkMenuBarModel(appName = '') {
        const entry = this._currentRegistration;
        if (!entry?.bar)
            return null;

        const menus = entry.bar.buildMenus();
        if (menus.length === 0)
            return null;

        let appMenuChildren = null;
        const topLevelMenus = [];
        for (const menu of menus) {
            if (!appMenuChildren && _isAppMenuLabel(menu.label, appName))
                appMenuChildren = menu.children();
            else
                topLevelMenus.push(menu);
        }

        return {
            registrationKey: this._currentKey,
            appMenuChildren,
            topLevelMenus,
        };
    }

    // ── dbusmenu (registrar) backend ──────────────────────────────────

    _buildDbusMenuModel(appName = '') {
        if (!this._client)
            return null;

        const root = this._client.get_root();
        if (!root)
            return null;

        const descriptors = _visibleChildren(root)
            .map((item, index) => this._buildTopLevelDescriptor(item, [index]))
            .filter(Boolean);

        if (descriptors.length === 0)
            return null;

        let appMenuChildren = null;
        const topLevelMenus = [];

        for (const descriptor of descriptors) {
            // The app menu is merged with ours, so its entries are listed now.
            if (!appMenuChildren && _isAppMenuLabel(descriptor.label, appName))
                appMenuChildren = descriptor.children();
            else
                topLevelMenus.push(descriptor);
        }

        return {
            registrationKey: this._currentKey,
            appMenuChildren,
            topLevelMenus,
        };
    }

    // ── GTK actions backend ───────────────────────────────────────────

    _buildGtkActionMenuModel() {
        if (!this._currentGtkContext)
            return null;

        const actions = this._cachedActions ?? [];
        if (actions.length === 0)
            return null;

        // Categorize every action
        const buckets = {
            app: [],
            file: [],
            edit: [],
            view: [],
            format: [],
            tools: [],
            help: [],
            other: [],
        };

        for (const action of actions) {
            const cat = _categoryForAction(action.name);
            buckets[cat].push(action);
        }

        // Build items from each bucket
        const build = (arr) => this._buildGtkActionItems(arr);

        const appItems = build(buckets.app);
        const fileItems = build(buckets.file);
        const editItems = build(buckets.edit);
        const viewItems = build(buckets.view);
        const formatItems = build(buckets.format);
        const toolsItems = build(buckets.tools);
        const helpItems = build(buckets.help);
        const otherItems = build(buckets.other);

        // Assemble app menu children: app-category items + any unrecognised + per-window actions
        const appChildren = [...appItems];
        if (otherItems.length > 0) {
            if (appChildren.length > 0)
                appChildren.push({ type: 'separator' });
            appChildren.push(...otherItems);
        }
        // Add per-window actions (e.g. "Read Only" tab toggle in Ptyxis)
        if (this._cachedWinActions && this._cachedWinActions.length > 0) {
            if (appChildren.length > 0)
                appChildren.push({ type: 'separator' });
            appChildren.push(...this._buildGtkActionItems(this._cachedWinActions));
        }

        // Assemble top-level menus
        const topLevelMenus = [];
        if (fileItems.length > 0) topLevelMenus.push({ label: 'File', children: fileItems });
        if (editItems.length > 0) topLevelMenus.push({ label: 'Edit', children: editItems });
        if (viewItems.length > 0) topLevelMenus.push({ label: 'View', children: viewItems });
        if (formatItems.length > 0) topLevelMenus.push({ label: 'Format', children: formatItems });
        if (toolsItems.length > 0) topLevelMenus.push({ label: 'Tools', children: toolsItems });
        if (helpItems.length > 0) topLevelMenus.push({ label: 'Help', children: helpItems });

        if (appChildren.length === 0 && topLevelMenus.length === 0)
            return null;

        Logger.debug(`gtk-actions: app=${appChildren.length} file=${fileItems.length} edit=${editItems.length} view=${viewItems.length} format=${formatItems.length} tools=${toolsItems.length} help=${helpItems.length} other=${otherItems.length}`);

        return {
            registrationKey: this._currentKey,
            appMenuChildren: appChildren.length > 0 ? appChildren : null,
            topLevelMenus,
        };
    }

    // ── backend lifecycle ──────────────────────────────────────────────

    _setBackend(kind, registration) {
        this._disposeCurrentBackend();

        this._backendType = kind;
        this._currentRegistration = registration;
        this._shownSignature = null;
        if (!kind || !registration) {
            this._currentKey = null;
            this._currentGtkContext = null;
            return;
        }

        if (kind === 'dbusmenu') {
            this._currentKey = `dbusmenu:${registration.service}|${registration.path}`;
            this._setDbusmenuClient(registration);
            return;
        }

        if (kind === 'gtk-menus') {
            this._currentKey = `gtk-menus:${registration.bar.busName}|${registration.bar.menubarPath}`;
            return;
        }

        if (kind === 'gtk-actions') {
            this._currentKey = `gtk:${registration.busName}|${registration.objectPath}`;
            this._currentGtkContext = registration;
        }
    }

    _disposeCurrentBackend() {
        if (this._changeTimeoutId) {
            GLib.source_remove(this._changeTimeoutId);
            this._changeTimeoutId = 0;
        }
        if (this._client) {
            this._clientSignalIds.forEach(id => {
                try { this._client.disconnect(id); } catch (_e) { /* ignore */ }
            });
            this._clientSignalIds = [];
            this._client = null;
        }
        this._currentGtkContext = null;
    }

    _setDbusmenuClient(registration) {
        try {
            // A menu from our own registrar comes with its client, already loaded.
            this._client = registration.menu?.client ?? new Dbusmenu.Client({
                dbus_name: registration.service,
                dbus_object: registration.path,
            });

            this._clientSignalIds = [
                this._client.connect(Dbusmenu.CLIENT_SIGNAL_ROOT_CHANGED, () => this._onClientChanged()),
                this._client.connect(Dbusmenu.CLIENT_SIGNAL_LAYOUT_UPDATED, () => this._onClientChanged()),
            ];
        } catch (e) {
            Logger.error(`Failed to create Dbusmenu client for ${registration.service}${registration.path}: ${e}`);
            this._client = null;
            this._backendType = null;
            this._currentRegistration = null;
            this._currentKey = null;
        }
    }

    // ── GTK action helpers ─────────────────────────────────────────────
    _buildGtkActionItems(actions) {
        return actions
            .map(action => this._buildGtkActionItem(action))
            .filter(Boolean);
    }

    _buildGtkActionItem(action) {
        if (!action)
            return null;

        const ornament = _gtkActionOrnament(action);

        return {
            label: _labelForAction(action.name),
            sensitive: action.enabled,
            ornament,
            activate: () => this._activateGtkAction(action.name, action.objectPath),
        };
    }

    async _activateGtkAction(name, objectPath = null) {
        if (!this._currentGtkContext)
            return;
        const context = this._currentGtkContext;
        try {
            await Gio.DBus.session.call(
                context.busName,
                objectPath ?? context.objectPath,
                GTK_ACTIONS_INTERFACE,
                'Activate',
                new GLib.Variant('(sav@a{sv})', [name, [], new GLib.Variant('a{sv}', {})]),
                null,
                Gio.DBusCallFlags.NONE,
                5000,
                null,
            );
        } catch (e) {
            Logger.error(`GTK action activation failed for ${name}: ${e}`);
        }
    }

    // ── signals ────────────────────────────────────────────────────────

    _emitChanged() {
        try {
            this._onChanged?.();
        } catch (e) {
            Logger.error(`Real menu change callback failed: ${e}`);
        }
    }

    _emitContentChanged() {
        try {
            this._onContentChanged?.();
        } catch (e) {
            Logger.error(`Real menu content callback failed: ${e}`);
        }
    }

    // The app changed its menu, or says so: Electron resends an unchanged
    // submenu each time it is about to show, and LibreOffice changes entries
    // while one types. So wait a moment, let submenus that were asked for
    // arrive, and then redo the bar only if other menus have to show; changes
    // inside the menus matter only to a menu that is open.
    _onClientChanged() {
        if (this._changeTimeoutId)
            return;

        this._changeTries = 0;
        this._changeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHANGE_DELAY_MS, () => {
            if (this._currentRegistration?.menu?.filling && ++this._changeTries < CHANGE_MAX_TRIES)
                return GLib.SOURCE_CONTINUE;

            this._changeTimeoutId = 0;
            if (this._backendType !== 'dbusmenu' && this._backendType !== 'gtk-menus')
                return GLib.SOURCE_REMOVE;

            if (_modelSignature(this._buildExportedMenuModel(this._currentAppName)) !== this._shownSignature)
                this._emitChanged();
            else
                this._emitContentChanged();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── dbusmenu tree builders ─────────────────────────────────────────
    // An item is remembered by its position (the indexes of the visible
    // children on the way down from the root), not by its object: the app may
    // replace every item at any time, and the old objects then point nowhere.
    // The entries of a menu are listed when it is about to open: `children` is
    // a function, for the top-level menus and for every submenu.

    _buildTopLevelDescriptor(item, path) {
        const label = _normalizeLabel(_splitLabelHint(item.property_get(Dbusmenu.MENUITEM_PROP_LABEL))[0]);
        if (!label)
            return null;

        return {
            label,
            children: () => this._childrenAt(path, label),
            onOpen: () => this._aboutToShow(path, label),
        };
    }

    _childrenAt(path, label) {
        const item = this._findItem(path, label);
        return item ? this._buildChildren(item, path) : [];
    }

    _buildChildren(parentItem, parentPath) {
        return _visibleChildren(parentItem)
            .map((item, index) => this._buildMenuItem(item, [...parentPath, index]))
            .filter(Boolean);
    }

    // Whether an item would show as an entry: a separator, a label or a submenu.
    _isEntry(item) {
        return _isSeparator(item)
            || Boolean(_normalizeLabel(_splitLabelHint(item.property_get(Dbusmenu.MENUITEM_PROP_LABEL))[0]))
            || _visibleChildren(item).some(child => this._isEntry(child));
    }

    _buildMenuItem(item, path) {
        if (_isSeparator(item))
            return { type: 'separator' };

        const [rawLabel, labelHint] = _splitLabelHint(item.property_get(Dbusmenu.MENUITEM_PROP_LABEL));
        const label = _normalizeLabel(rawLabel);
        const hasSubmenu = _visibleChildren(item).some(child => this._isEntry(child));

        if (!label && !hasSubmenu)
            return null;

        if (hasSubmenu) {
            const submenuLabel = label || _('More');
            return {
                type: 'submenu',
                label: submenuLabel,
                children: () => this._childrenAt(path, label),
                onOpen: () => this._aboutToShow(path, label),
            };
        }

        // A submenu with nothing in it, for example an empty "Open Recent".
        if (item.property_get(Dbusmenu.MENUITEM_PROP_CHILD_DISPLAY) === Dbusmenu.MENUITEM_CHILD_DISPLAY_SUBMENU)
            return { label: label || _('More'), sensitive: false };

        return {
            label: label || _('Untitled'),
            sensitive: _isEnabled(item),
            ornament: _getOrnament(item),
            shortcut: _shortcutText(item) || labelHint,
            activate: () => this._activateItem(path, label),
        };
    }

    // The item at a position, if it still carries the label it was drawn with.
    // If the menu changed in between, a sibling with that label is used, and
    // nothing at all rather than a different command.
    _findItem(path, label) {
        let parent = this._client?.get_root() ?? null;
        for (const index of path.slice(0, -1))
            parent = parent ? _visibleChildren(parent)[index] ?? null : null;
        if (!parent)
            return null;

        const hasLabel = item =>
            _normalizeLabel(_splitLabelHint(item.property_get(Dbusmenu.MENUITEM_PROP_LABEL))[0]) === label;
        const siblings = _visibleChildren(parent);
        const item = siblings[path.at(-1)];
        if (item && hasLabel(item))
            return item;
        return siblings.find(hasLabel) ?? null;
    }

    _aboutToShow(path, label) {
        const item = this._findItem(path, label);
        const registration = this._currentRegistration;
        if (!item || !registration)
            return;

        if (registration.menu) {
            registration.menu.aboutToShow(item.get_id());
        } else {
            Gio.DBus.session.call(
                registration.service, registration.path, DBUSMENU_INTERFACE, 'AboutToShow',
                new GLib.Variant('(i)', [item.get_id()]), null, Gio.DBusCallFlags.NO_AUTO_START, 2000, null
            ).catch(e => Logger.debug(`Dbusmenu about-to-show failed: ${e}`));
        }
        // Check marks and greyed-out items can change without a new layout.
        this._onClientChanged();
    }

    _activateItem(path, label) {
        const item = this._findItem(path, label);
        if (!item) {
            Logger.debug(`Menu item "${label}" is gone; nothing activated.`);
            return;
        }

        try {
            item.handle_event(
                Dbusmenu.MENUITEM_EVENT_ACTIVATED,
                new GLib.Variant('i', 0),
                global.get_current_time(),
            );
        } catch (e) {
            Logger.error(`Dbusmenu activation failed: ${e}`);
        }
    }
}
