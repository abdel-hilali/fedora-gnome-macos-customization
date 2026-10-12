"use strict";
/**
 * https://extensions.gnome.org/extension/7700/task-up-ultralite/
 * Not verified against a live instance (not installed) — kept for anyone
 * else using this fork who has it, on role-prefix matching only, since there
 * is no confirmed `creatorExtensionUuid` to match against.
 */
export const FAMILIES = [
    {
        id: "task-up-ultralite",
        displayName: "Task Up UltraLite",
        rolePrefixFallback: "task-button-",
        pruneStaleMembers: false,
        groupDescription: "Order Task Up UltraLite's items within their group.",
    },
    {
        // https://github.com/GSConnect/gnome-shell-extension-gsconnect
        // Roles are the paired device's D-Bus object path — stable across
        // restarts and reconnects for as long as the device stays paired, so
        // there's no benefit to pruning a device just because it's
        // temporarily offline.
        id: "gsconnect",
        displayName: "GSConnect",
        creatorExtensionUuid: "gsconnect@andyholmes.github.io",
        rolePrefixFallback: "/org/gnome/Shell/Extensions/GSConnect/Device/",
        pruneStaleMembers: false,
        formatMemberTitle: (role) => role.replace("/org/gnome/Shell/Extensions/GSConnect/Device/", ""),
        groupDescription: "Order GSConnect's paired devices within their group. Unlike the Item Order page, this list has no adjacent box to migrate into — moving a device only reorders it within this group.",
    },
    {
        // https://gitlab.com/fthx/tasks-in-panel
        // Roles are `taskButton${windowId}` — a new, never-repeating value
        // every time a window opens, so a member that stops being present
        // anywhere is gone for good; pruning is what keeps this family's
        // persisted order from growing without bound.
        id: "tasks-in-panel",
        displayName: "Tasks in Panel",
        creatorExtensionUuid: "tasks-in-panel@fthx",
        rolePrefixFallback: "taskButton",
        pruneStaleMembers: true,
        formatMemberTitle: (role) => `Window ${role.replace("taskButton", "")}`,
        groupDescription: "Order Tasks in Panel's window buttons within their group. Entries for closed windows are pruned automatically.",
    },
    {
        // Deliberately no `creatorExtensionUuid`/`rolePrefixFallback`:
        // AppIndicator/KStatusNotifierItem roles are dispatched to
        // `#handleFullModeAppIndicatorItem` before the generic per-role
        // family lookup ever runs (see `BoxOrderManager#saveNewTopBarItems`),
        // so this family is never matched that way.
        // `pruneStaleMembers` must stay `false`: unlike other families,
        // this family's persisted member order holds per-application
        // settings identifiers, not roles — the generic prune loop compares
        // persisted members against currently-present *roles*, which would
        // never match and would wipe every entry on the very next pass.
        id: "appindicator",
        displayName: "AppIndicator",
        pruneStaleMembers: false,
        formatMemberTitle: (memberSettingsId) => {
            const application = memberSettingsId
                .replace(/^appindicator-kstatusnotifieritem-/, "")
                .replace(/^legacy-/, "");
            return application;
        },
        groupDescription: "Order AppIndicator/KStatusNotifierItem (tray) items within their group. Only takes effect when appindicator-order-mode is \"full\".",
    },
];
/**
 * The settings key holding a family's persisted, independently-orderable
 * member list.
 */
export function familyOrderKey(familyId) {
    return `family-order-${familyId}`;
}
/**
 * The settings identifier a family's collapsed group occupies in a
 * `${box}-box-order` array.
 */
export function familyGroupSettingsId(familyId) {
    return `item-role-group-${familyId}`;
}
/**
 * Finds the family whose collapsed-group settings identifier matches the
 * given settings id, if any.
 */
export function findFamilyByGroupSettingsId(settingsId) {
    return FAMILIES.find(family => familyGroupSettingsId(family.id) === settingsId);
}
/**
 * Finds a family by its stable id.
 */
export function findFamilyById(familyId) {
    return FAMILIES.find(family => family.id === familyId);
}
