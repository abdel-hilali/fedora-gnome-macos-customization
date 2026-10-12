// SPDX-License-Identifier: GPL-2.0-or-later
//
// Downloads Fan: the fan.
//
// FanController holds the state (closed, loading, open, closing), the modal grab and the
// dock link, and releases each of them exactly once on every way out: Escape, a press
// outside the rows (which includes a second click on the dock icon), opening an entry,
// Toggle or Close over D-Bus, the overview opening, a monitor change, disable().
// FanView builds, places and animates the actors and holds no grab of its own.
//
// Actions that start inside one of the view's own event handlers (a press, a key, a click)
// run from an idle callback right after it, so the fan is never torn down while Clutter or
// St is still delivering that event to it.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DockLink, findAnchor} from './anchor.js';
import {
    DownloadsSource, THUMBNAIL_ATTRIBUTES, Thumbnailer, isCancelled, queryInfo,
    thumbnailIcon, wantsThumbnail,
} from './files.js';
import {NewestModel} from './stack.js';

export const LAUNCHER_ID = 'downloads-folder.desktop';

const MAX_FILES = 10;

// Geometry, logical pixels.
const ICON_SIZE = 48;     // file icons and thumbnails
const ICON_SLOT = 52;     // the square an icon sits in; the curve runs through its centre
const LABEL_SPACING = 8;  // keep in step with .downloads-fan-item-box in stylesheet.css
const LABEL_MAX = 260;    // longer names are shortened in the middle
const STEP = 58;          // from one file row to the next
const OPEN_STEP = 50;     // from the last file row to the "Open in Files" row
const DOCK_GAP = 10;      // between the dock icon and the first row
const EDGE_MARGIN = 10;   // kept free along the work area's edges
const BEND_SPAN = 600;    // over this distance the fan bends BEND_SHIFT to the side
const BEND_SHIFT = 54;

// Motion, milliseconds. ease() scales these by the slow-down factor and drops them when
// org.gnome.desktop.interface enable-animations is off.
const OPEN_TIME = 210;
const OPEN_STAGGER = 8;
const CLOSE_TIME = 150;
const START_SCALE = 0.35;
const THUMB_FADE = 140;
const OVERVIEW_WAIT_MS = 1500;

const State = Object.freeze({
    CLOSED: 'closed',
    LOADING: 'loading',
    OPEN: 'open',
    CLOSING: 'closing',
});

function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
}

function bendShift(distance) {
    return BEND_SHIFT * (distance / BEND_SPAN) ** 2;
}

// Slope of the curve at that distance, in degrees. A positive rotation_angle_z turns an
// actor's top to the right on screen.
function bendTilt(distance) {
    return Math.atan(2 * BEND_SHIFT * distance / BEND_SPAN ** 2) * 180 / Math.PI;
}

function workArea(monitorIndex) {
    const area = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
    return {x: area.x, y: area.y, width: area.width, height: area.height};
}

function cancelledError() {
    return new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Cancelled');
}

/**
 * How many file rows fit between the anchor and the far edge of the work area, with the
 * "Open in Files" row beyond them.
 *
 * @param {object} anchor from findAnchor()
 * @returns {number} between 1 and MAX_FILES
 */
export function fanCapacity(anchor) {
    const area = workArea(anchor.monitorIndex);
    const {rect} = anchor;
    let room;
    if (anchor.side === 'bottom')
        room = rect.y - DOCK_GAP - (area.y + EDGE_MARGIN);
    else if (anchor.side === 'top')
        room = area.y + area.height - EDGE_MARGIN - (rect.y + rect.height + DOCK_GAP);
    else
        room = area.height - 2 * EDGE_MARGIN;
    return clamp(Math.floor((room - ICON_SLOT - OPEN_STEP) / STEP) + 1, 1, MAX_FILES);
}

function launchContext(time) {
    return global.create_app_launch_context(time ?? 0, -1);
}

function openUri(uri, what, time) {
    Gio.AppInfo.launch_default_for_uri_async(uri, launchContext(time), null,
        (_source, result) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(result);
            } catch (e) {
                Main.notifyError(`Could not open “${what}”`, e.message);
            }
        });
}

// Like GNOME Shell's own "Show in Files": the folder handler gets the file, and Files opens
// its folder with the file selected.
function showInFiles(file, what, time) {
    const app = Gio.AppInfo.get_default_for_type('inode/directory', false);
    if (!app) {
        openUri(file.get_parent()?.get_uri() ?? file.get_uri(), what, time);
        return;
    }
    app.launch_uris_async([file.get_uri()], launchContext(time), null, (_app, result) => {
        try {
            app.launch_uris_finish(result);
        } catch (e) {
            Main.notifyError(`Could not show “${what}” in Files`, e.message);
        }
    });
}

class FanView {
    /**
     * @param {object} anchor from findAnchor()
     * @param {object[]} rows {kind: 'file'|'message'|'open', name, gicon, file, uri, info}
     * @param {object} params {dark, onActivate(index, {reveal, time})}
     */
    constructor(anchor, rows, {dark, onActivate}) {
        this.side = anchor.side;
        this.selected = -1;
        this._anchor = anchor;
        this._onActivate = onActivate;
        this._pendingOpen = 0;
        this._settled = false;
        this._closing = false;
        this._destroyed = false;

        const area = workArea(anchor.monitorIndex);
        this._labelSide = this._chooseLabelSide(area);

        // One transparent layer over the whole stage. Rows sit on it in stage coordinates;
        // a press that is not on a row lands on this layer or outside it.
        this.root = new St.Widget({
            name: 'downloadsFan',
            style_class: 'downloads-fan popup-menu',
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        this.setDark(dark);
        Main.layoutManager.uiGroup.add_child(this.root);

        this._rows = rows.map((row, index) => this._buildRow(row, index));
        this._useFallbackColoursIfNeeded();
        this._place(area);
    }

    // Up leaves a bottom dock; for a top dock and for the side lists it is Down.
    get olderKeys() {
        return this.side === 'bottom'
            ? [Clutter.KEY_Up, Clutter.KEY_KP_Up]
            : [Clutter.KEY_Down, Clutter.KEY_KP_Down];
    }

    get newerKeys() {
        return this.side === 'bottom'
            ? [Clutter.KEY_Down, Clutter.KEY_KP_Down]
            : [Clutter.KEY_Up, Clutter.KEY_KP_Up];
    }

    get rows() {
        return this._rows;
    }

    rowAt(index) {
        return this._rows[index] ?? null;
    }

    isRowActor(actor) {
        return !!actor &&
            this._rows.some(row => row.kind !== 'message' && row.button.contains(actor));
    }

    setDark(dark) {
        if (dark)
            this.root.add_style_class_name('dark');
        else
            this.root.remove_style_class_name('dark');
    }

    _chooseLabelSide(area) {
        if (this.side === 'left')
            return 'right';
        if (this.side === 'right')
            return 'left';
        // Labels to the left of the icons, as on macOS, unless the icon is too close to
        // the left edge for the longest label.
        const {rect} = this._anchor;
        const iconLeft = rect.x + rect.width / 2 - ICON_SLOT / 2;
        return iconLeft - LABEL_SPACING - LABEL_MAX - EDGE_MARGIN >= area.x ? 'left' : 'right';
    }

    _buildRow(row, index) {
        const interactive = row.kind !== 'message';
        const button = new St.Button({
            style_class: `downloads-fan-item downloads-fan-${row.kind}`,
            reactive: interactive,
            can_focus: interactive,
            track_hover: interactive,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            accessible_name: row.name,
        });
        const box = new St.BoxLayout({style_class: 'downloads-fan-item-box'});
        button.set_child(box);

        // The pill takes its colours from the theme's popup menus.
        const label = new St.Label({
            style_class: 'popup-menu-content downloads-fan-label',
            text: row.name,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        button.label_actor = label;

        const slot = new St.Widget({
            style_class: 'downloads-fan-slot',
            layout_manager: new Clutter.BinLayout(),
            width: ICON_SLOT,
            height: ICON_SLOT,
            y_align: Clutter.ActorAlign.CENTER,
        });
        let icon;
        if (row.kind === 'open') {
            icon = new St.Icon({
                style_class: 'downloads-fan-open-icon',
                icon_name: 'go-next-symbolic',
                fallback_icon_name: 'folder-open-symbolic',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            slot.add_child(new St.Bin({
                style_class: 'popup-menu-content downloads-fan-open-circle',
                child: icon,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        } else {
            icon = new St.Icon({
                style_class: 'downloads-fan-icon',
                gicon: row.gicon,
                fallback_icon_name: 'text-x-generic',
                icon_size: ICON_SIZE,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            slot.add_child(icon);
        }

        if (this._labelSide === 'left') {
            box.add_child(label);
            box.add_child(slot);
        } else {
            box.add_child(slot);
            box.add_child(label);
        }
        this.root.add_child(button);

        if (interactive) {
            button.connect('notify::hover', () => this._onHover(index));
            button.connect('clicked', (_button, clickedButton) =>
                this._onClicked(index, clickedButton));
        }
        return {...row, index, button, label, icon};
    }

    // A theme whose popup menus draw their background somewhere else (on the old box
    // pointer) would leave the pills see-through; then the stylesheet's own colours apply.
    _useFallbackColoursIfNeeded() {
        const label = this._rows[0]?.label;
        if (label && label.get_theme_node().get_background_color().alpha < 60)
            this.root.add_style_class_name('downloads-fan-fallback');
    }

    _place(area) {
        const {rect} = this._anchor;
        const rows = this._rows;

        for (const row of rows) {
            const [, labelWidth] = row.label.get_preferred_width(-1);
            if (labelWidth > LABEL_MAX)
                row.label.width = LABEL_MAX;
            const [, , width, height] = row.button.get_preferred_size();
            row.width = Math.ceil(width);
            row.height = Math.ceil(height);
            row.button.set_size(row.width, row.height);
        }

        // Distance of each row's icon centre from the first one, along the fan.
        let distance = 0;
        rows.forEach((row, i) => {
            if (i > 0)
                distance += row.kind === 'open' ? OPEN_STEP : STEP;
            row.distance = distance;
        });

        const anchorX = rect.x + rect.width / 2;
        const anchorY = rect.y + rect.height / 2;
        const isFan = this.side === 'bottom' || this.side === 'top';

        // macOS bends its fan to the right; bend left only when that would run off the
        // monitor.
        let bend = 1;
        if (isFan && this._labelSide === 'left' &&
            anchorX + bendShift(distance) + ICON_SLOT / 2 + EDGE_MARGIN > area.x + area.width)
            bend = -1;

        const listHeight = distance + ICON_SLOT;
        const listTop = clamp(anchorY - listHeight / 2, area.y + EDGE_MARGIN,
            area.y + area.height - EDGE_MARGIN - listHeight);

        for (const row of rows) {
            let cx, cy;
            let angle = 0;
            if (this.side === 'bottom') {
                cx = anchorX + bend * bendShift(row.distance);
                cy = rect.y - DOCK_GAP - ICON_SLOT / 2 - row.distance;
                angle = bend * bendTilt(row.distance);
            } else if (this.side === 'top') {
                cx = anchorX + bend * bendShift(row.distance);
                cy = rect.y + rect.height + DOCK_GAP + ICON_SLOT / 2 + row.distance;
                angle = -bend * bendTilt(row.distance);
            } else {
                cx = this.side === 'left'
                    ? rect.x + rect.width + DOCK_GAP + ICON_SLOT / 2
                    : rect.x - DOCK_GAP - ICON_SLOT / 2;
                cy = listTop + ICON_SLOT / 2 + row.distance;
            }

            // Each row turns and grows around its icon's centre.
            const pivotX = this._labelSide === 'left' ? row.width - ICON_SLOT / 2 : ICON_SLOT / 2;
            const pivotY = row.height / 2;
            row.x = cx - pivotX;
            row.y = cy - pivotY;
            row.angle = angle;
            // Translation that puts the icon's centre on the dock icon's centre.
            row.fromX = anchorX - cx;
            row.fromY = anchorY - cy;
            row.button.set_pivot_point(pivotX / row.width, pivotY / row.height);
        }

        // Sideways, keep the whole fan inside the work area; the row count already makes
        // it fit the other way.
        const left = Math.min(...rows.map(row => row.x));
        const right = Math.max(...rows.map(row => row.x + row.width));
        let shift = 0;
        if (right > area.x + area.width - EDGE_MARGIN)
            shift = area.x + area.width - EDGE_MARGIN - right;
        if (left + shift < area.x + EDGE_MARGIN)
            shift = area.x + EDGE_MARGIN - left;

        for (const row of rows) {
            row.x = Math.round(row.x + shift);
            row.y = Math.round(row.y);
            row.fromX -= shift;
            row.button.set_position(row.x, row.y);
        }
    }

    // Rows rise out of the dock icon: from its centre, small and clear, to their place on
    // the curve; the nearest row starts first.
    animateIn() {
        this._pendingOpen = this._rows.length;
        this._rows.forEach((row, i) => {
            row.button.set({
                opacity: 0,
                scale_x: START_SCALE,
                scale_y: START_SCALE,
                translation_x: row.fromX,
                translation_y: row.fromY,
                rotation_angle_z: 0,
            });
            row.button.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                translation_x: 0,
                translation_y: 0,
                rotation_angle_z: row.angle,
                delay: i * OPEN_STAGGER,
                duration: OPEN_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onStopped: () => this._onRowOpened(),
            });
        });
    }

    _onRowOpened() {
        this._pendingOpen--;
        if (this._pendingOpen > 0 || this._destroyed || this._closing)
            return;
        this._settled = true;
        // Hover is ignored while rows fly past the pointer; pick it up now.
        for (const row of this._rows) {
            if (row.button.reactive)
                row.button.sync_hover();
        }
        const hovered = this._rows.findIndex(row => row.button.reactive && row.button.hover);
        if (hovered >= 0)
            this.select(hovered);
    }

    // Back into the dock icon. onDone runs once, when every row has stopped.
    animateOut(onDone) {
        this._closing = true;
        this.root.reactive = false;
        const rows = [...this._rows];
        let pending = rows.length;
        if (pending === 0) {
            onDone();
            return;
        }
        for (const row of rows) {
            row.button.reactive = false;
            row.button.ease({
                opacity: 0,
                scale_x: START_SCALE,
                scale_y: START_SCALE,
                translation_x: row.fromX,
                translation_y: row.fromY,
                rotation_angle_z: 0,
                duration: CLOSE_TIME,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onStopped: () => {
                    pending--;
                    if (pending === 0)
                        onDone();
                },
            });
        }
    }

    // One highlighted row at most, whether the pointer or the keyboard chose it.
    select(index) {
        if (index === this.selected || this._destroyed)
            return;
        this._rows[this.selected]?.button.remove_style_pseudo_class('selected');
        this.selected = index;
        const row = this._rows[index];
        if (row) {
            row.button.add_style_pseudo_class('selected');
            row.button.grab_key_focus();
        } else {
            this.root.grab_key_focus();
        }
    }

    _choices() {
        return this._rows.filter(row => row.kind !== 'message').map(row => row.index);
    }

    // +1 goes to older entries (away from the dock), -1 to newer ones. The first key press
    // selects the newest entry.
    move(delta) {
        const choices = this._choices();
        if (choices.length === 0)
            return;
        const at = choices.indexOf(this.selected);
        const next = at < 0 ? 0 : clamp(at + delta, 0, choices.length - 1);
        this.select(choices[next]);
    }

    selectEnd(last) {
        const choices = this._choices();
        if (choices.length > 0)
            this.select(last ? choices[choices.length - 1] : choices[0]);
    }

    setThumbnail(uri, gicon) {
        if (this._destroyed || this._closing)
            return;
        const row = this._rows.find(r => r.kind === 'file' && r.uri === uri);
        if (!row)
            return;
        const {icon} = row;
        icon.ease({
            opacity: 0,
            duration: THUMB_FADE / 2,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                icon.gicon = gicon;
                icon.ease({
                    opacity: 255,
                    duration: THUMB_FADE,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            },
        });
    }

    _onHover(index) {
        if (!this._settled || this._closing || this._destroyed)
            return;
        const {button} = this._rows[index];
        if (button.hover)
            this.select(index);
        else if (this.selected === index)
            this.select(-1);
    }

    _onClicked(index, clickedButton) {
        if (this._closing || this._destroyed)
            return;
        const event = Clutter.get_current_event();
        const control = event
            ? (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0
            : false;
        this._onActivate(index, {
            reveal: clickedButton === Clutter.BUTTON_SECONDARY || control,
            time: event?.get_time() ?? 0,
        });
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this.root.destroy();
        this._rows = [];
    }
}

export class FanController {
    constructor(extensionPath) {
        this._state = State.CLOSED;
        this._serial = 0;
        this._view = null;
        this._grab = null;
        this._dockLink = null;
        this._cancellable = null;
        this._abortOverviewWait = null;
        this._deferredId = 0;
        this._overviewShowingId = 0;
        this._monitorsChangedId = 0;
        this._destroyed = false;

        this._source = new DownloadsSource();
        this._thumbnailer = new Thumbnailer(
            GLib.build_filenamev([extensionPath, 'thumbnailer.js']),
            (uri, status) => this._onThumbnail(uri, status));
        // What the dock icon shows (stack.js); shares the listing and the helper.
        this.dockIcon = new NewestModel(this._source, this._thumbnailer);

        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._colorSchemeId = this._interface.connect('changed::color-scheme',
            () => this._view?.setDark(this._isDark()));
    }

    // For tests and debugging.
    get state() {
        return this._state;
    }

    get view() {
        return this._view;
    }

    toggle() {
        if (this._destroyed)
            return;
        if (this._state === State.OPEN) {
            this.close();
            return;
        }
        if (this._state === State.LOADING) {
            // A second click before the fan appeared: forget the first.
            this._cancelLoading();
            return;
        }
        if (this._state === State.CLOSING)
            this._finishClosing();

        const serial = ++this._serial;
        this._load(serial).catch(e => this._loadFailed(e, serial));
    }

    close({animate = true} = {}) {
        this._cancelDeferred();
        if (this._state === State.LOADING) {
            this._cancelLoading();
            return;
        }
        if (this._state !== State.OPEN)
            return;

        this._state = State.CLOSING;
        this._disconnectWhileOpen();
        this._releaseGrab();
        this._dockLink?.destroy(); // after the grab, so the dock sees the real hover
        this._dockLink = null;

        const view = this._view;
        const finish = () => {
            if (this._view === view) {
                this._view = null;
                this._state = State.CLOSED;
            }
            view.destroy();
        };
        if (animate)
            view.animateOut(finish);
        else
            finish();
    }

    destroy() {
        this.close({animate: false});
        if (this._state === State.CLOSING)
            this._finishClosing();
        this._destroyed = true;
        this._cancelDeferred();
        this.dockIcon.destroy();
        this._thumbnailer.destroy();
        if (this._colorSchemeId) {
            this._interface.disconnect(this._colorSchemeId);
            this._colorSchemeId = 0;
        }
        this._interface = null;
    }

    async _load(serial) {
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._state = State.LOADING;
        const pointer = global.get_pointer();

        // A click on the dock inside the overview: let the overview close first.
        if (Main.overview.visible)
            await this._overviewHidden();

        const anchor = findAnchor(LAUNCHER_ID, pointer);
        if (!anchor)
            throw new Error('no monitor to show the fan on');

        let listing;
        try {
            listing = await this._source.newest(fanCapacity(anchor), cancellable);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            console.warn(`Downloads Fan: cannot list ${this._source.folder.get_path()}: ${e.message}`);
            listing = {total: 0, entries: [], failed: true};
        }

        if (serial !== this._serial || this._state !== State.LOADING)
            return;
        this._cancellable = null;
        this._show(anchor, listing);
    }

    _overviewHidden() {
        return new Promise((resolve, reject) => {
            if (!Main.overview.visible) {
                resolve();
                return;
            }
            let hiddenId = 0;
            let timeoutId = 0;
            const done = error => {
                this._abortOverviewWait = null;
                if (hiddenId)
                    Main.overview.disconnect(hiddenId);
                if (timeoutId)
                    GLib.source_remove(timeoutId);
                hiddenId = 0;
                timeoutId = 0;
                if (error)
                    reject(error);
                else
                    resolve();
            };
            hiddenId = Main.overview.connect('hidden', () => done(null));
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OVERVIEW_WAIT_MS, () => {
                timeoutId = 0;
                done(new Error('the overview did not close'));
                return GLib.SOURCE_REMOVE;
            });
            this._abortOverviewWait = () => done(cancelledError());
            if (Main.overview.visibleTarget)
                Main.overview.hide();
        });
    }

    _loadFailed(error, serial) {
        if (isCancelled(error) || serial !== this._serial)
            return;
        console.warn(`Downloads Fan: ${error.message}`);
        if (this._state === State.LOADING) {
            this._state = State.CLOSED;
            this._cancellable = null;
        }
        // What the launcher does when the extension is off.
        openUri(this._source.folder.get_uri(), 'Downloads');
    }

    _cancelLoading() {
        this._serial++;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._abortOverviewWait?.();
        this._state = State.CLOSED;
    }

    _finishClosing() {
        const view = this._view;
        this._view = null;
        this._state = State.CLOSED;
        view?.destroy();
    }

    _rowsFor(listing) {
        const rows = listing.entries.map(({file, info}) => ({
            kind: 'file',
            file,
            uri: file.get_uri(),
            name: info.get_display_name(),
            gicon: thumbnailIcon(info) ?? info.get_icon() ??
                new Gio.ThemedIcon({name: 'text-x-generic'}),
            info,
        }));
        if (rows.length === 0) {
            rows.push({
                kind: 'message',
                name: listing.failed ? 'Cannot read the Downloads folder' : 'No files in Downloads',
                gicon: new Gio.ThemedIcon({name: 'folder-download'}),
            });
        }
        const more = listing.total - listing.entries.length;
        rows.push({kind: 'open', name: more > 0 ? `+${more} more in Files` : 'Open in Files'});
        return rows;
    }

    _show(anchor, listing) {
        const rows = this._rowsFor(listing);
        const dockLink = new DockLink(anchor.icon);
        let view = null;
        try {
            // Before the grab: the dock must already ignore the hover it loses to it.
            dockLink.open();
            view = new FanView(anchor, rows, {
                dark: this._isDark(),
                onActivate: (index, options) => this._defer(() => this._activate(index, options)),
            });
            this._grab = Main.pushModal(view.root, {actionMode: Shell.ActionMode.POPUP});
        } catch (e) {
            this._releaseGrab();
            view?.destroy();
            dockLink.destroy();
            this._state = State.CLOSED;
            throw e;
        }

        this._view = view;
        this._dockLink = dockLink;
        this._state = State.OPEN;
        view.root.connect('captured-event', (_actor, event) => this._onCapturedEvent(event));
        view.root.connect('destroy', () => this._onViewDestroyed(view));
        this._overviewShowingId = Main.overview.connect('showing', () => this.close());
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed',
            () => this.close({animate: false}));
        view.animateIn();
        this._requestThumbnails(view.rows);
    }

    _disconnectWhileOpen() {
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
    }

    // Only when something else destroyed the fan while it was open. Main.pushModal() has
    // already dropped the grab then (it watches the actor), so it must not be popped again.
    _onViewDestroyed(view) {
        if (this._view !== view || this._state !== State.OPEN)
            return;
        this._grab = null;
        this._cancelDeferred();
        this._disconnectWhileOpen();
        this._dockLink?.destroy();
        this._dockLink = null;
        this._view = null;
        this._state = State.CLOSED;
    }

    _releaseGrab() {
        const grab = this._grab;
        this._grab = null;
        if (!grab)
            return;
        try {
            Main.popModal(grab);
        } catch (e) {
            console.warn(`Downloads Fan: ${e.message}`);
        }
    }

    _onCapturedEvent(event) {
        if (this._state !== State.OPEN)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS)
            return this._onKeyPress(event);
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            if (!this._view.isRowActor(global.stage.get_event_actor(event))) {
                // Anywhere else, the dock icon included: close, and keep the press from
                // reaching what is underneath.
                this._defer(() => this.close());
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onKeyPress(event) {
        const view = this._view;
        const symbol = event.get_key_symbol();
        switch (symbol) {
        case Clutter.KEY_Escape:
            this._defer(() => this.close());
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab:
            view.move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_ISO_Left_Tab:
            view.move(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Home:
        case Clutter.KEY_KP_Home:
            view.selectEnd(false);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_End:
        case Clutter.KEY_KP_End:
            view.selectEnd(true);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
        case Clutter.KEY_space:
        case Clutter.KEY_Menu: {
            const index = view.selected;
            if (index >= 0) {
                const control = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
                const options = {
                    reveal: symbol === Clutter.KEY_Menu || control,
                    time: event.get_time(),
                };
                this._defer(() => this._activate(index, options));
            }
            return Clutter.EVENT_STOP;
        }
        }
        if (view.olderKeys.includes(symbol)) {
            view.move(1);
            return Clutter.EVENT_STOP;
        }
        if (view.newerKeys.includes(symbol)) {
            view.move(-1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _activate(index, {reveal = false, time = 0} = {}) {
        if (this._state !== State.OPEN)
            return;
        const row = this._view.rowAt(index);
        if (!row || row.kind === 'message')
            return;
        if (row.kind === 'open')
            openUri(this._source.folder.get_uri(), 'Downloads', time);
        else if (reveal)
            showInFiles(row.file, row.name, time);
        else
            openUri(row.file.get_uri(), row.name, time);
        this.close();
    }

    _defer(callback) {
        this._cancelDeferred();
        this._deferredId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._deferredId = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelDeferred() {
        if (this._deferredId) {
            GLib.source_remove(this._deferredId);
            this._deferredId = 0;
        }
    }

    _requestThumbnails(rows) {
        const wanted = rows
            .filter(row => row.kind === 'file' && wantsThumbnail(row.info))
            .map(row => ({
                uri: row.uri,
                mime: row.info.get_content_type() ?? 'application/octet-stream',
                mtime: row.info.get_attribute_uint64('time::modified'),
            }));
        if (wanted.length > 0)
            this._thumbnailer.request(wanted);
    }

    _onThumbnail(uri, status) {
        this.dockIcon.onThumbnail(uri, status);
        const view = this._view;
        if (status !== 'ok' || !view || this._state !== State.OPEN)
            return;
        queryInfo(Gio.File.new_for_uri(uri), THUMBNAIL_ATTRIBUTES).then(info => {
            const icon = thumbnailIcon(info);
            if (icon && this._view === view && this._state === State.OPEN)
                view.setThumbnail(uri, icon);
        }).catch(() => {
            // the file went away; keep its type icon
        });
    }

    _isDark() {
        return this._interface?.get_string('color-scheme') === 'prefer-dark';
    }
}
