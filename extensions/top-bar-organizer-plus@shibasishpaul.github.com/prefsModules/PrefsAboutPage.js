"use strict";
import GObject from "gi://GObject";
import Adw from "gi://Adw";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";
import { getPrefsMetadata, getPrefsDir } from "./prefsContext.js";
const UPSTREAM_PROJECT_URL = "https://gitlab.gnome.org/june/top-bar-organizer";
export default class PrefsAboutPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass({
            GTypeName: "PrefsAboutPage",
            Template: GLib.uri_resolve_relative(import.meta.url, "../ui/prefs-about-page.ui", GLib.UriFlags.NONE),
            InternalChildren: [
                "name-label",
                "version-label",
                "description-label",
            ],
        }, this);
    }
    // The extension's homepage, as declared in metadata.json - the only
    // link metadata.json actually has a recognized field for (see
    // `loadExtensionMetadata` in GNOME Shell's own extensionUtils.js, which
    // only requires/reads uuid/name/description/shell-version; "url" is a
    // separately-established convention, not a distinct "repository"/
    // "bugs" field). "Report an Issue" and "Source Code" below are derived
    // from it rather than stored separately.
    #homepageUrl;
    constructor(params = {}) {
        super(params);
        const metadata = getPrefsMetadata();
        this.#homepageUrl = metadata.url;
        this._name_label.set_label(metadata.name);
        this._version_label.set_label(`Version ${metadata["version-name"] ?? metadata.version}`);
        this._description_label.set_label(metadata.description);
    }
    onHomepageActivated() {
        this.#launchUri(this.#homepageUrl);
    }
    onIssuesActivated() {
        this.#launchUri(`${this.#homepageUrl}/issues`);
    }
    onUpstreamActivated() {
        this.#launchUri(UPSTREAM_PROJECT_URL);
    }
    onLicenseActivated() {
        // Shipped verbatim as COPYING alongside the rest of the extension's
        // files (see package.sh) - opened locally instead of linking out,
        // so what's shown is always exactly what this specific version was
        // distributed under.
        const copyingFile = getPrefsDir().get_child("COPYING");
        const launcher = new Gtk.FileLauncher({ file: copyingFile });
        launcher.launch(this.get_root(), null, (_source, result) => {
            try {
                launcher.launch_finish(result);
            }
            catch (e) {
                console.error(`top-bar-organizer-plus: failed to open COPYING: ${e}`);
            }
        });
    }
    #launchUri(uri) {
        const launcher = new Gtk.UriLauncher({ uri });
        launcher.launch(this.get_root(), null, (_source, result) => {
            try {
                launcher.launch_finish(result);
            }
            catch (e) {
                console.error(`top-bar-organizer-plus: failed to open "${uri}": ${e}`);
            }
        });
    }
}
