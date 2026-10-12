// SPDX-License-Identifier: GPL-2.0-or-later
//
// Downloads Fan: the newest entries of the Downloads folder, and thumbnails for them.
//
// The folder is listed in GIO's worker threads. A listing is kept until the folder's own
// modification time changes (a download finishing renames *.part to its real name, which
// changes it), so opening the fan again is instant.
//
// Thumbnails: the shell only ever loads finished PNGs from ~/.cache/thumbnails. Missing
// ones are made by thumbnailer.js in a separate gjs process with GNOME's thumbnail factory
// (the one Files uses, with sandboxed thumbnailers), so no image, PDF or video decoder runs
// inside gnome-shell and Files reuses the results.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Hidden and backup files are skipped too (standard::is-hidden, standard::is-backup).
const PARTIAL_SUFFIXES = ['.part', '.crdownload', '.tmp'];

const FOLDER_ATTRIBUTES = 'standard::type,time::modified,time::modified-usec';
const LIST_ATTRIBUTES = [
    'standard::name', 'standard::type', 'standard::is-hidden', 'standard::is-backup',
    'time::modified', 'time::modified-usec', 'time::changed', 'time::changed-usec',
].join(',');
const ROW_ATTRIBUTES = [
    'standard::display-name', 'standard::content-type', 'standard::icon', 'standard::type',
    'time::modified', 'thumbnail::path', 'thumbnail::is-valid', 'thumbnail::failed',
].join(',');
export const THUMBNAIL_ATTRIBUTES = 'thumbnail::path,thumbnail::is-valid,thumbnail::failed';

const ENUMERATE_BATCH = 128;
const KEEP_NEWEST = 24;
const HELPER_BATCH = 12;
const HELPER_TIMEOUT_S = 30;
const HELPER_NO_FACTORY = 2; // exit status of thumbnailer.js without GnomeDesktop 4.0

export function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export function downloadsFolder() {
    const path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
    return Gio.File.new_for_path(path);
}

// Small promise wrappers with explicit callbacks, so no Gio prototype gets changed.
export function queryInfo(file, attributes, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.query_info_async(attributes, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT,
            cancellable, (source, result) => {
                try {
                    resolve(source.query_info_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function enumerateChildren(folder, attributes, cancellable) {
    return new Promise((resolve, reject) => {
        folder.enumerate_children_async(attributes, Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                try {
                    resolve(source.enumerate_children_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function nextFiles(enumerator, count, cancellable) {
    return new Promise((resolve, reject) => {
        enumerator.next_files_async(count, GLib.PRIORITY_DEFAULT, cancellable,
            (source, result) => {
                try {
                    resolve(source.next_files_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function closeQuietly(stream) {
    stream.close_async(GLib.PRIORITY_LOW, null, (source, result) => {
        try {
            source.close_finish(result);
        } catch {
            // nothing to do
        }
    });
}

function isListed(info) {
    if (info.get_is_hidden() || info.get_is_backup())
        return false;
    const name = info.get_name().toLowerCase();
    if (name.startsWith('.') || PARTIAL_SUFFIXES.some(suffix => name.endsWith(suffix)))
        return false;
    const type = info.get_file_type();
    return type === Gio.FileType.REGULAR || type === Gio.FileType.DIRECTORY;
}

// When the entry arrived in the folder, as well as a file system can tell: the later of
// modification and status change. The status-change time (ctime) moves when a file is
// renamed into the folder, moved there, extracted or copied with its old modification time,
// which matches macOS's "Date Added" better than the modification time alone.
function arrivalTime(info) {
    const modified = info.get_attribute_uint64('time::modified') * 1e6 +
        info.get_attribute_uint32('time::modified-usec');
    const changed = info.get_attribute_uint64('time::changed') * 1e6 +
        info.get_attribute_uint32('time::changed-usec');
    return Math.max(modified, changed);
}

/** A valid thumbnail as a GIcon, or null. */
export function thumbnailIcon(info) {
    const path = info.get_attribute_byte_string('thumbnail::path');
    if (!path || info.get_attribute_boolean('thumbnail::failed'))
        return null;
    if (info.has_attribute('thumbnail::is-valid') &&
        !info.get_attribute_boolean('thumbnail::is-valid'))
        return null;
    return new Gio.FileIcon({file: Gio.File.new_for_path(path)});
}

/** Whether to ask the helper: a regular file with no thumbnail and no current failure. */
export function wantsThumbnail(info) {
    if (info.get_file_type() !== Gio.FileType.REGULAR || thumbnailIcon(info))
        return false;
    const failedBefore = info.get_attribute_boolean('thumbnail::failed') &&
        info.get_attribute_boolean('thumbnail::is-valid');
    return !failedBefore;
}

export class DownloadsSource {
    constructor() {
        this.folder = downloadsFolder();
        this._cache = null;
    }

    /**
     * The newest entries, newest first.
     *
     * @param {number} limit how many rows at most
     * @param {Gio.Cancellable} cancellable cancels the whole load
     * @returns {Promise<object>} {total, entries: [{file, info}]}
     */
    async newest(limit, cancellable) {
        const folderInfo = await queryInfo(this.folder, FOLDER_ATTRIBUTES, cancellable);
        if (folderInfo.get_file_type() !== Gio.FileType.DIRECTORY)
            throw new Error(`${this.folder.get_path()} is not a folder`);

        const stamp = `${folderInfo.get_attribute_uint64('time::modified')}.` +
            `${folderInfo.get_attribute_uint32('time::modified-usec')}`;
        if (this._cache?.stamp !== stamp) {
            const scan = await this._scan(cancellable);
            this._cache = {stamp, ...scan};
        }

        const picked = this._cache.newest.slice(0, limit);
        const infos = await Promise.all(picked.map(file =>
            queryInfo(file, ROW_ATTRIBUTES, cancellable).catch(e => {
                if (isCancelled(e))
                    throw e;
                return null; // gone since the listing
            })));
        return {
            total: this._cache.total,
            entries: picked.map((file, i) => ({file, info: infos[i]}))
                .filter(entry => entry.info !== null),
        };
    }

    async _scan(cancellable) {
        const enumerator = await enumerateChildren(this.folder, LIST_ATTRIBUTES, cancellable);
        const found = [];
        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const infos = await nextFiles(enumerator, ENUMERATE_BATCH, cancellable);
                if (infos.length === 0)
                    break;
                for (const info of infos) {
                    if (isListed(info))
                        found.push({file: enumerator.get_child(info), time: arrivalTime(info)});
                }
            }
        } finally {
            closeQuietly(enumerator);
        }
        found.sort((a, b) => b.time - a.time);
        return {total: found.length, newest: found.slice(0, KEEP_NEWEST).map(entry => entry.file)};
    }
}

/**
 * Runs thumbnailer.js for files without a thumbnail, one process at a time, and reports
 * each file as it is done: onResult(uri, 'ok' | 'failed' | 'skipped').
 * A file is tried at most once per session and modification time.
 */
export class Thumbnailer {
    constructor(scriptPath, onResult) {
        this._script = scriptPath;
        this._onResult = onResult;
        this._gjs = GLib.find_program_in_path('gjs');
        this._disabled = !this._gjs;
        this._queue = new Map();
        this._tried = new Set();
        this._proc = null;
        this._cancellable = null;
        this._timeoutId = 0;
    }

    /** @param {object[]} items [{uri, mime, mtime}] */
    request(items) {
        if (this._disabled)
            return;
        for (const item of items) {
            const key = `${item.mtime}:${item.uri}`;
            if (this._tried.has(key))
                continue;
            this._tried.add(key);
            this._queue.set(item.uri, item);
        }
        this._next();
    }

    _next() {
        if (this._proc || this._disabled || this._queue.size === 0)
            return;

        const batch = [...this._queue.values()].slice(0, HELPER_BATCH);
        for (const item of batch)
            this._queue.delete(item.uri);
        const argv = [this._gjs, '-m', this._script];
        for (const item of batch)
            argv.push(item.uri, item.mime, String(item.mtime));

        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`Downloads Fan: no thumbnail helper: ${e.message}`);
            this._disabled = true;
            return;
        }

        const cancellable = new Gio.Cancellable();
        this._proc = proc;
        this._cancellable = cancellable;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, HELPER_TIMEOUT_S, () => {
            this._timeoutId = 0;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });

        const stream = new Gio.DataInputStream({
            base_stream: proc.get_stdout_pipe(),
            close_base_stream: true,
        });
        this._readLine(proc, stream, cancellable);
    }

    _readLine(proc, stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_LOW, cancellable, (source, result) => {
            let line = null;
            try {
                [line] = source.read_line_finish_utf8(result);
            } catch (e) {
                if (!isCancelled(e))
                    console.warn(`Downloads Fan: thumbnail helper: ${e.message}`);
            }
            if (line === null) {
                this._reap(proc, stream);
                return;
            }
            const [status, uri] = line.split('\t');
            if (uri && this._proc === proc)
                this._onResult?.(uri, status);
            this._readLine(proc, stream, cancellable);
        });
    }

    _reap(proc, stream) {
        closeQuietly(stream);
        proc.wait_async(null, (source, result) => {
            try {
                source.wait_finish(result);
            } catch {
                // the process is gone either way
            }
            if (this._proc !== proc)
                return; // destroyed meanwhile
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
            this._proc = null;
            this._cancellable = null;
            if (source.get_if_exited() && source.get_exit_status() === HELPER_NO_FACTORY) {
                console.warn('Downloads Fan: GnomeDesktop 4.0 is missing, no new thumbnails');
                this._disabled = true;
            }
            this._next();
        });
    }

    destroy() {
        this._onResult = null;
        this._disabled = true;
        this._queue.clear();
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._cancellable?.cancel();
        this._proc?.force_exit();
        this._proc = null;
        this._cancellable = null;
    }
}
