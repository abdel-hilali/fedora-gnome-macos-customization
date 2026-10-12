// SPDX-License-Identifier: GPL-2.0-or-later
//
// Downloads Fan: the dock icon shows the newest download in the Downloads folder icon.
//
// Shell.App.create_icon_texture() is patched for the launcher's id only, so every icon that
// GNOME Shell or a dock makes for the launcher is a NewestIcon: the launcher's own icon with
// the newest entry's thumbnail, else its file-type icon, placed by LOOK. All NewestIcons follow one NewestModel, which watches the folder and
// asks the thumbnail helper for a missing thumbnail. With the folder empty or unreadable, or
// after disable(), the icon is the launcher's own again. No dock code is replaced: icons made
// before the patch (a dock that was enabled first) are made again through their own update(),
// and every icon made later asks Shell.App anyway.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {findAppIcons} from './anchor.js';
import {
    THUMBNAIL_ATTRIBUTES, isCancelled, queryInfo, thumbnailIcon, wantsThumbnail,
} from './files.js';

const REFRESH_DELAY = 250; // ms from a change in the folder to a new listing

// Where the newest file goes on the launcher's own icon. Scale and pivot (fractions of the
// icon) place each part without knowing the icon's size. File icons bring their own margin,
// so they are drawn larger than thumbnails by fileIconGrow. Exported for tests: change it,
// then remakeIcons().
export const LOOK = {
    fileBehind: true, // the file sticks out of the folder; false: it sits on the folder
    folder: {scale: 0.86, pivot: [0.5, 0.86], angle: 0},
    file: {scale: 0.62, pivot: [0.5, 0.06], angle: 0},
    fileIconGrow: 1.12,
};

function place(actor, {scale, pivot: [x, y], angle}) {
    actor.set_pivot_point(x, y);
    actor.set_scale(scale, scale);
    actor.rotation_angle_z = angle;
}

function describe({file, info}) {
    const typeIcon = info.get_icon() ?? new Gio.ThemedIcon({name: 'text-x-generic'});
    const thumbnail = thumbnailIcon(info);
    return {
        uri: file.get_uri(),
        gicon: thumbnail ?? typeIcon,
        typeIcon,
        thumbnail: thumbnail !== null,
    };
}

/**
 * The newest entry for the dock icon, kept current while the folder changes.
 * Emits 'changed'; after destroy() there is none.
 */
export class NewestModel extends Signals.EventEmitter {
    constructor(source, thumbnailer) {
        super();
        this._source = source;
        this._thumbnailer = thumbnailer;
        this._newest = null;
        this._key = '';
        this._serial = 0;
        this._cancellable = null;
        this._refreshId = 0;
        this._destroyed = false;

        this._monitor = null;
        try {
            this._monitor = source.folder.monitor_directory(
                Gio.FileMonitorFlags.WATCH_MOVES, null);
            // Writes into a file that is still downloading do not change the order.
            this._monitor.connect('changed', (_monitor, _file, _other, event) => {
                if (event !== Gio.FileMonitorEvent.CHANGED &&
                    event !== Gio.FileMonitorEvent.ATTRIBUTE_CHANGED)
                    this._queueRefresh();
            });
        } catch (e) {
            console.warn(`Downloads Fan: cannot watch ${source.folder.get_path()}: ${e.message}`);
        }

        this._refresh();
    }

    /** {uri, gicon, typeIcon, thumbnail} of the newest entry, or null. */
    get newest() {
        return this._newest;
    }

    /** Called with every result of the thumbnail helper. */
    onThumbnail(uri, status) {
        if (status !== 'ok' || this._destroyed || !this._waitsForThumbnail(uri))
            return;
        queryInfo(Gio.File.new_for_uri(uri), THUMBNAIL_ATTRIBUTES).then(info => {
            const gicon = thumbnailIcon(info);
            if (gicon && !this._destroyed && this._waitsForThumbnail(uri))
                this._set({...this._newest, gicon, thumbnail: true});
        }).catch(() => {
            // the file went away; the next listing follows
        });
    }

    _waitsForThumbnail(uri) {
        return this._newest?.uri === uri && !this._newest.thumbnail;
    }

    _queueRefresh() {
        if (this._refreshId || this._destroyed)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        const serial = ++this._serial;
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        this._source.newest(1, cancellable).then(({entries: [entry]}) => {
            if (serial !== this._serial)
                return;
            this._set(entry ? describe(entry) : null);
            if (entry && wantsThumbnail(entry.info)) {
                this._thumbnailer.request([{
                    uri: entry.file.get_uri(),
                    mime: entry.info.get_content_type() ?? 'application/octet-stream',
                    mtime: entry.info.get_attribute_uint64('time::modified'),
                }]);
            }
        }).catch(e => {
            if (isCancelled(e) || serial !== this._serial)
                return;
            console.warn('Downloads Fan: cannot list ' +
                `${this._source.folder.get_path()} for the dock icon: ${e.message}`);
            this._set(null);
        });
    }

    _set(newest) {
        const key = newest ? `${newest.uri}\n${newest.gicon.to_string() ?? ''}` : '';
        if (key === this._key)
            return;
        this._key = key;
        this._newest = newest;
        this.emit('changed');
    }

    destroy() {
        this._destroyed = true;
        this._serial++;
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._monitor?.cancel();
        this._monitor = null;
        // Icons still on screen go back to the launcher's own icon.
        this._set(null);
    }
}

const NewestIcon = GObject.registerClass(
class DownloadsNewestIcon extends St.Widget {
    _init(model, launcherIcon, size) {
        super._init({layout_manager: new Clutter.BinLayout()});
        this._model = model;
        this._launcherIcon = launcherIcon;
        this._size = size;
        model.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        this.destroy_all_children();
        const folder = this._launcherIcon(this._size);
        const newest = this._model.newest;
        if (!newest) {
            this.add_child(folder);
            return;
        }
        const file = new St.Icon({
            gicon: newest.gicon,
            fallback_gicon: newest.typeIcon,
            icon_size: this._size,
        });
        place(folder, LOOK.folder);
        const grow = newest.thumbnail ? 1 : LOOK.fileIconGrow;
        place(file, {...LOOK.file, scale: LOOK.file.scale * grow});
        for (const actor of LOOK.fileBehind ? [file, folder] : [folder, file])
            this.add_child(actor);
    }
});

// Has every icon of the launcher made again, also those off screen (the overview's app grid).
// GNOME Shell's AppIcon and the docks' copies of it hold a BaseIcon whose update() asks
// Shell.App again; Dash to Dock's copies only listen to notify::icon on location icons.
export function remakeIcons(appId) {
    for (const icon of findAppIcons(appId, {all: true})) {
        try {
            icon.icon?.update?.();
        } catch (e) {
            console.warn(`Downloads Fan: cannot remake an icon: ${e.message}`);
        }
    }
    Shell.AppSystem.get_default().lookup_app(appId)?.notify('icon');
}

/**
 * From now on the launcher's icon is a NewestIcon wherever it is made; the icons made
 * already are made again at once.
 *
 * @param {string} appId desktop file id of the launcher
 * @param {NewestModel} model what the icons show
 * @returns {Function} undoes it, and the launcher's own icon is made again
 */
export function patchLauncherIcon(appId, model) {
    const proto = Shell.App.prototype;
    const original = proto.create_icon_texture;
    let active = true;
    const patched = function (size) {
        if (active && this.get_id() === appId)
            return new NewestIcon(model, iconSize => original.call(this, iconSize), size);
        return original.call(this, size);
    };
    proto.create_icon_texture = patched;
    remakeIcons(appId);

    return () => {
        // If another extension wrapped it meanwhile, keep its wrapper; ours passes through.
        active = false;
        if (proto.create_icon_texture === patched)
            proto.create_icon_texture = original;
        remakeIcons(appId);
    };
}
