// SPDX-License-Identifier: GPL-2.0-or-later
//
// Downloads Fan thumbnail helper. Not loaded by GNOME Shell: the extension starts it as its
// own process for the files that have no thumbnail yet,
//
//   gjs -m thumbnailer.js URI MIME-TYPE MTIME [URI MIME-TYPE MTIME ...]
//
// and reads one line per file from it: "ok", "failed" or "skipped", a tab, the URI.
// It uses GNOME's thumbnail factory, as Files does: the thumbnailers run sandboxed, results
// go to ~/.cache/thumbnails (large size) and failures are recorded there, so a file is not
// tried again until it changes. org.gnome.desktop.thumbnailers (disable-all, disable) is
// honoured by the factory. Exit status 2: GnomeDesktop 4.0 is not installed.

import System from 'system';

let GnomeDesktop = null;
try {
    GnomeDesktop = (await import('gi://GnomeDesktop?version=4.0')).default;
} catch (e) {
    printerr(`downloads-fan thumbnailer: ${e.message}`);
    System.exit(2);
}

const factory = GnomeDesktop.DesktopThumbnailFactory.new(
    GnomeDesktop.DesktopThumbnailSize.LARGE);

function thumbnail(uri, mime, mtime) {
    if (factory.lookup(uri, mtime))
        return 'ok';
    if (factory.has_valid_failed_thumbnail(uri, mtime))
        return 'failed';
    if (!factory.can_thumbnail(uri, mime, mtime))
        return 'skipped';

    let pixbuf = null;
    try {
        pixbuf = factory.generate_thumbnail(uri, mime, null);
    } catch (e) {
        printerr(`downloads-fan thumbnailer: ${uri}: ${e.message}`);
    }
    if (!pixbuf) {
        factory.create_failed_thumbnail(uri, mtime, null);
        return 'failed';
    }
    factory.save_thumbnail(pixbuf, uri, mtime, null);
    return 'ok';
}

for (let i = 0; i + 2 < ARGV.length; i += 3) {
    const uri = ARGV[i];
    const mime = ARGV[i + 1];
    const mtime = Number.parseInt(ARGV[i + 2], 10);
    let status;
    try {
        status = Number.isFinite(mtime) ? thumbnail(uri, mime, mtime) : 'skipped';
    } catch (e) {
        printerr(`downloads-fan thumbnailer: ${uri}: ${e.message}`);
        status = 'failed';
    }
    // print() flushes each line, so the extension can update the fan file by file.
    print(`${status}\t${uri}`);
}
