// SPDX-License-Identifier: GPL-2.0-or-later
//
// Downloads Fan, entry point.
//
// The dock is not touched. The Downloads launcher (downloads-folder.desktop) runs
//   gdbus call --session --dest org.macstyle.DownloadsFan \
//       --object-path /org/macstyle/DownloadsFan --method org.macstyle.DownloadsFan.Toggle
// and opens the folder itself when nobody owns that name, i.e. when this extension is off.
// The launcher's icon shows the newest download while this extension is on (stack.js).

import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FanController, LAUNCHER_ID} from './fan.js';
import {patchLauncherIcon} from './stack.js';

const BUS_NAME = 'org.macstyle.DownloadsFan';
const OBJECT_PATH = '/org/macstyle/DownloadsFan';
const INTERFACE_XML = `<node>
  <interface name="org.macstyle.DownloadsFan">
    <method name="Toggle"/>
    <method name="Close"/>
  </interface>
</node>`;

export default class DownloadsFanExtension extends Extension {
    enable() {
        this._controller = new FanController(this.path);
        this._unpatchIcon = patchLauncherIcon(LAUNCHER_ID, this._controller.dockIcon);

        this._service = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, {
            Toggle: () => this._controller?.toggle(),
            Close: () => this._controller?.close(),
        });
        // Export first, then own the name, so a caller that sees the name also finds
        // the object.
        this._service.export(Gio.DBus.session, OBJECT_PATH);
        this._nameId = Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME,
            Gio.BusNameOwnerFlags.NONE, null,
            () => console.warn(`Downloads Fan: ${BUS_NAME} is not ours (lost or owned elsewhere)`));
    }

    disable() {
        // Give up the name first: from here on the launcher falls back to opening the folder.
        if (this._nameId) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = 0;
        }

        try {
            this._service?.unexport();
        } catch (e) {
            console.warn(`Downloads Fan: unexport: ${e.message}`);
        }
        this._service = null;

        this._unpatchIcon?.();
        this._unpatchIcon = null;
        this._controller?.destroy();
        this._controller = null;
    }
}
