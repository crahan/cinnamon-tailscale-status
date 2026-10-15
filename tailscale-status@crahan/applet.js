// Tailscale applet for Cinnamon.
//
// The behavior copies the tailscale-gnome-qs GNOME extension (https://github.com/tailscale-qs/tailscale-gnome-qs):
// turn Tailscale on or off, use or stop an exit node, copy a node IP, change settings, and switch profiles.
// The applet talks to the tailscaled local API and gets live updates from the IPN bus.
imports.gi.versions.Soup = "3.0";

const Applet = imports.ui.applet;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Soup = imports.gi.Soup;
const St = imports.gi.St;
const Tooltips = imports.ui.tooltips;

const SOCKET_PATH = "/var/run/tailscale/tailscaled.sock";
const API_URL = "http://local-tailscaled.sock/localapi/v0";
// IPN bus watch mask 1 << 12, the same mask as the GNOME extension.
const WATCH_MASK = 1 << 12;
const RETRY_MS = 5000;
const STATUS_DELAY_MS = 300;
const LONG_PRESS_MS = 500;
const NODES_MAX_HEIGHT = 200;

// Switches in the Settings submenu: label and tailscaled pref key.
const PREF_SWITCHES = [
    ["Accept routes", "RouteAll"],
    ["Accept DNS", "CorpDNS"],
    ["Allow LAN access", "ExitNodeAllowLANAccess"],
    ["Shields up", "ShieldsUp"],
    ["SSH", "RunSSH"],
];

// Text for a backend state other than "Running".
const STATE_TEXT = {
    NoState: "Not ready",
    NeedsLogin: "Needs login",
    NeedsMachineAuth: "Needs machine approval",
    Stopped: "Stopped",
    Starting: "Starting",
};

// Client for the tailscaled local API on the Unix socket.
class LocalApi {
    constructor() {
        this._session = new Soup.Session({
            remote_connectable: new Gio.UnixSocketAddress({ path: SOCKET_PATH }),
            timeout: 0,
            idle_timeout: 0,
        });
        this._decoder = new TextDecoder();
    }

    _message(method, path, body) {
        let message = Soup.Message.new(method, API_URL + path);
        if (body !== null) {
            let bytes = new TextEncoder().encode(JSON.stringify(body));
            message.set_request_body_from_bytes("application/json", new GLib.Bytes(bytes));
        }
        return message;
    }

    // Send one request. Resolve with the parsed JSON response.
    request(method, path, body = null) {
        let message = this._message(method, path, body);
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                try {
                    let data = session.send_and_read_finish(result).get_data();
                    let text = data ? this._decoder.decode(data) : "";
                    if (message.get_status() >= 300)
                        throw new Error(text.trim() || "HTTP status " + message.get_status());
                    resolve(text ? JSON.parse(text) : null);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    // Read a stream of JSON lines and call `onItem` for each one. Resolve when the stream ends.
    stream(path, cancellable, onItem) {
        let message = this._message("GET", path, null);
        return new Promise((resolve, reject) => {
            this._session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                let input;
                try {
                    input = new Gio.DataInputStream({ base_stream: session.send_finish(result) });
                    if (message.get_status() >= 300)
                        throw new Error("HTTP status " + message.get_status());
                } catch (e) {
                    reject(e);
                    return;
                }
                let finish = (error) => {
                    try {
                        input.close(null);
                    } catch (e) {
                        // The stream is already closed.
                    }
                    if (error)
                        reject(error);
                    else
                        resolve();
                };
                let readLine = () => {
                    input.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, res) => {
                        let line;
                        try {
                            [line] = stream.read_line_finish_utf8(res);
                        } catch (e) {
                            finish(e);
                            return;
                        }
                        if (line === null) {
                            finish(null);
                            return;
                        }
                        if (line.length) {
                            try {
                                onItem(JSON.parse(line));
                            } catch (e) {
                                global.logError("Tailscale applet: " + e.message);
                            }
                        }
                        readLine();
                    });
                };
                readLine();
            });
        });
    }

    destroy() {
        this._session.abort();
    }
}

// Return the host name part of the MagicDNS name, for example "chc-exit-us-thomas-central1".
function shortName(peer) {
    return (peer.DNSName || peer.HostName || "").split(".")[0] || peer.HostName || "";
}

// Sort order of the Nodes list: active exit node, exit nodes, online nodes, then name.
function compareNodes(a, b) {
    return (b.exitNode - a.exitNode) ||
        (b.exitNodeOption - a.exitNodeOption) ||
        (b.online - a.online) ||
        a.name.localeCompare(b.name);
}

function nodeIconName(node) {
    if (!node.online)
        return "network-offline-symbolic";
    if (node.os === "android" || node.os === "iOS")
        return "phone-symbolic";
    if (node.mullvad)
        return "network-vpn-symbolic";
    return "computer-symbolic";
}

function nodeSubtitle(node, selfIsExitNode) {
    if (node.exitNode)
        return "disable exit node";
    if (selfIsExitNode && node.exitNodeOption)
        return "exit node";
    if (node.exitNodeOption)
        return "use as exit node";
    return "";
}

// A horizontal row that fills the menu item. All items use one row, so that their right edges align.
function makeRow(item) {
    let row = new St.BoxLayout({ style_class: "tailscale-row", x_expand: true });
    item.addActor(row, { span: -1, expand: true });
    return row;
}

function makeSubtitle(text = "") {
    return new St.Label({
        text: text,
        style_class: "popup-inactive-menu-item tailscale-subtitle",
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// Menu header: icon, title, exit node name, a button to disable the exit node, and the Tailscale switch.
// A click on the row turns Tailscale on or off.
class HeaderItem extends PopupMenu.PopupBaseMenuItem {
    _init(gicon) {
        super._init.call(this);
        this.actor.add_style_class_name("tailscale-header");
        let row = makeRow(this);

        this.icon = new St.Icon({ gicon: gicon, style_class: "tailscale-header-icon" });
        let text = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        text.add_child(new St.Label({ text: "Tailscale", style_class: "tailscale-title" }));
        this._subtitle = makeSubtitle();
        text.add_child(this._subtitle);

        this.exitButton = new St.Button({
            style_class: "tailscale-exit-button",
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({ icon_name: "network-vpn-symbolic", icon_type: St.IconType.SYMBOLIC,
                style_class: "popup-menu-icon" }),
        });
        this._exitTooltip = new Tooltips.Tooltip(this.exitButton, "Disable exit node");

        this._switch = new PopupMenu.Switch(false);
        this._switch.actor.y_align = Clutter.ActorAlign.CENTER;

        row.add_child(this.icon);
        row.add_child(text);
        row.add_child(this.exitButton);
        row.add_child(this._switch.actor);
    }

    update(running, subtitle, exitNodeActive, enabled) {
        this._switch.setToggleState(running);
        this._subtitle.text = subtitle;
        this._subtitle.visible = subtitle !== "";
        this.exitButton.reactive = exitNodeActive;
        this.exitButton.opacity = exitNodeActive ? 255 : 90;
        this.setSensitive(enabled);
    }

    activate(event) {
        this._switch.toggle();
        this.emit("toggled", this._switch.state);
        PopupMenu.PopupBaseMenuItem.prototype.activate.call(this, event, true);
    }

    destroy() {
        this._exitTooltip.destroy();
        PopupMenu.PopupBaseMenuItem.prototype.destroy.call(this);
    }
}

// Label with a switch at the right edge. A click toggles the switch and keeps the menu open.
class SwitchItem extends PopupMenu.PopupBaseMenuItem {
    _init(text) {
        super._init.call(this);
        let row = makeRow(this);
        row.add_child(new St.Label({ text: text, x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        this._switch = new PopupMenu.Switch(false);
        this._switch.actor.y_align = Clutter.ActorAlign.CENTER;
        row.add_child(this._switch.actor);
    }

    setToggleState(state) {
        this._switch.setToggleState(state);
    }

    activate(event) {
        this._switch.toggle();
        this.emit("toggled", this._switch.state);
        PopupMenu.PopupBaseMenuItem.prototype.activate.call(this, event, true);
    }
}

// One node in the Nodes list. A click runs `onClick` (only exit nodes have one).
// A long press runs `onLongPress` (copy the IP address).
class NodeItem extends PopupMenu.PopupBaseMenuItem {
    _init(iconName, text, subtitle, onClick, onLongPress) {
        super._init.call(this, { activate: onClick !== null });
        let row = makeRow(this);
        row.add_child(new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC,
            style_class: "popup-menu-icon", y_align: Clutter.ActorAlign.CENTER }));
        row.add_child(new St.Label({ text: text, x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        row.add_child(makeSubtitle(subtitle));

        this._onLongPress = onLongPress;
        this._pressTimer = 0;
        this._longPressed = false;
        this.actor.connect("button-press-event", (actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY)
                this._startPress();
            return false;
        });
        this.actor.connect("leave-event", () => this._cancelPress());
        // The base class connects the release handler only for items that can be activated.
        if (onClick === null)
            this.actor.connect("button-release-event", (actor, event) => this._onButtonReleaseEvent(actor, event));
        else
            this.connect("activate", () => onClick());
    }

    _startPress() {
        this._cancelPress();
        this._longPressed = false;
        this.actor.add_style_pseudo_class("active");
        this._pressTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
            this._pressTimer = 0;
            this._longPressed = true;
            this._onLongPress();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPress() {
        if (this._pressTimer) {
            GLib.source_remove(this._pressTimer);
            this._pressTimer = 0;
        }
        if (!this._activatable)
            this.actor.remove_style_pseudo_class("active");
    }

    _onButtonReleaseEvent(actor, event) {
        let longPressed = this._longPressed;
        this._longPressed = false;
        this._cancelPress();
        if (!longPressed && this._activatable)
            this.activate(event, false);
        return true;
    }

    destroy() {
        this._cancelPress();
        PopupMenu.PopupBaseMenuItem.prototype.destroy.call(this);
    }
}

// One profile in the Profiles list, with a check mark on the current profile.
class ProfileItem extends PopupMenu.PopupBaseMenuItem {
    _init(title, subtitle, current, onClick) {
        super._init.call(this);
        let row = makeRow(this);
        row.add_child(new St.Label({ text: title, x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        row.add_child(makeSubtitle(subtitle));
        let check = new St.Icon({ icon_name: "object-select-symbolic", icon_type: St.IconType.SYMBOLIC,
            style_class: "popup-menu-icon", y_align: Clutter.ActorAlign.CENTER });
        check.opacity = current ? 255 : 0;
        row.add_child(check);
        this.connect("activate", () => onClick());
    }
}

class TailscaleApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this._iconDir = metadata.path + "/icons/";
        this._api = new LocalApi();
        this._cancellable = new Gio.Cancellable();
        this._sources = new Set();
        this._statusPending = false;
        this._available = false;
        this._status = null;
        this._prefs = null;
        this._profiles = [];
        this._nodesKey = null;
        this._profilesKey = null;

        // Second panel icon: shows when an exit node is in use. Cinnamon gives symbolic panel icons the
        // "system-status-icon" class. The "applet-icon" class is for full color icons and is brighter in some themes.
        this._exitIcon = new St.Icon({ icon_name: "network-vpn-symbolic", icon_type: St.IconType.SYMBOLIC,
            style_class: "system-status-icon", visible: false });
        this.actor.add_child(this._exitIcon);

        this._buildMenu(orientation);
        this._render();
        this._run();
    }

    _gicon(name) {
        return Gio.icon_new_for_string(this._iconDir + name + "-symbolic.svg");
    }

    _buildMenu(orientation) {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this.menu.connect("open-state-changed", (menu, open) => {
            if (open)
                this._fixMenuWidth();
        });
        // If the content gets wider while the menu is open, keep the new width.
        this.menu.actor.connect("notify::width", () => {
            if (this.menu.isOpen && this.menu.box.width > this.menu.box.min_width)
                this.menu.box.min_width = this.menu.box.width;
        });

        this._header = new HeaderItem(this._gicon("ts-on"));
        this._header.connect("toggled", (item, state) => this._setPrefs({ WantRunning: state }));
        this._header.exitButton.connect("clicked", () => this._setPrefs({ ExitNodeID: "" }));
        this.menu.addMenuItem(this._header);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // The Nodes list always has a scroll bar and a maximum height, as in the GNOME extension.
        this._nodesMenu = new PopupMenu.PopupSubMenuMenuItem("Nodes");
        this._nodesMenu.menu._needsScrollbar = () => true;
        this._nodesMenu.menu.actor.set_style("max-height: " + NODES_MAX_HEIGHT + "px;");
        this.menu.addMenuItem(this._nodesMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._settingsMenu = new PopupMenu.PopupSubMenuMenuItem("Settings");
        this._prefSwitches = PREF_SWITCHES.map(([text, key]) => {
            let item = new SwitchItem(text);
            item.connect("toggled", (it, state) => this._setPrefs({ [key]: state }));
            this._settingsMenu.menu.addMenuItem(item);
            return [key, item];
        });
        this.menu.addMenuItem(this._settingsMenu);

        this._profilesMenu = new PopupMenu.PopupSubMenuMenuItem("Profiles");
        this.menu.addMenuItem(this._profilesMenu);
    }

    _subMenus() {
        return [this._nodesMenu.menu, this._settingsMenu.menu, this._profilesMenu.menu];
    }

    // Submenu items have a larger left indent than main menu items, and Cinnamon ignores closed submenus when
    // it calculates the menu width. So the menu gets wider when a submenu opens. To stop this, measure the width
    // with all submenus open, then keep the menu at least that wide. The submenus open and close in one step,
    // so they are never drawn. The measurement must run while the menu is shown, else the theme is not applied.
    // Cinnamon moves the menu when its size changes.
    _fixMenuWidth() {
        let box = this.menu.box;
        let subMenus = this._subMenus();
        let closed = subMenus.filter((menu) => !menu.isOpen);
        // The column widths are calculated in the width request of the wrapper around the box.
        let measure = () => this.menu._boxWrapper.get_preferred_width(-1)[1];
        box.min_width_set = false;
        closed.forEach((menu) => menu.open(false));
        // The first request sets the new column widths. Clutter keeps the old size requests of the items,
        // so drop them before the second request.
        measure();
        for (let menu of [this.menu, ...subMenus])
            menu.box.get_children().forEach((actor) => actor.queue_relayout());
        let width = measure();
        closed.forEach((menu) => menu.close(false));
        box.min_width = width;
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_panel_icon_size_changed(size) {
        this._exitIcon.icon_size = size;
    }

    on_applet_removed_from_panel() {
        this._cancellable.cancel();
        for (let id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        this._api.destroy();
        this.menu.destroy();
    }

    // Run `callback` once after `ms` milliseconds. Return a promise that resolves after the callback.
    _delay(ms, callback = () => {}) {
        return new Promise((resolve) => {
            let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._sources.delete(id);
                callback();
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._sources.add(id);
        });
    }

    // Load the full state, then follow the IPN bus. Connect again after an error or when the stream ends.
    async _run() {
        while (!this._cancellable.is_cancelled()) {
            try {
                let [status, prefs, profiles] = await Promise.all([
                    this._api.request("GET", "/status"),
                    this._api.request("GET", "/prefs"),
                    this._api.request("GET", "/profiles/"),
                ]);
                this._status = status;
                this._prefs = prefs;
                this._profiles = profiles || [];
                this._available = true;
                this._render();
                await this._api.stream("/watch-ipn-bus?mask=" + WATCH_MASK, this._cancellable,
                    (notify) => this._onNotify(notify));
            } catch (e) {
                if (this._cancellable.is_cancelled())
                    return;
                global.logError("Tailscale applet: " + e.message);
            }
            if (this._cancellable.is_cancelled())
                return;
            this._available = false;
            this._render();
            await this._delay(RETRY_MS);
        }
    }

    _onNotify(notify) {
        if (notify.Prefs) {
            this._prefs = notify.Prefs;
            this._render();
            this._loadProfiles();
        }
        if (notify.Prefs || notify.State !== undefined || notify.NetMap || notify.SelfChange ||
            notify.PeersChanged || notify.PeersRemoved)
            this._scheduleStatus();
    }

    // Read the status again after a short delay, so that a burst of bus messages causes only one request.
    _scheduleStatus() {
        if (this._statusPending)
            return;
        this._statusPending = true;
        this._delay(STATUS_DELAY_MS, () => {
            this._statusPending = false;
            this._api.request("GET", "/status").then((status) => {
                this._status = status;
                this._render();
            }, (e) => global.logError("Tailscale applet: " + e.message));
        });
    }

    _loadProfiles() {
        this._api.request("GET", "/profiles/").then((profiles) => {
            this._profiles = profiles || [];
            this._render();
        }, (e) => global.logError("Tailscale applet: " + e.message));
    }

    // Change tailscaled prefs. The response holds the new prefs.
    _setPrefs(values) {
        let body = {};
        for (let [key, value] of Object.entries(values)) {
            body[key] = value;
            body[key + "Set"] = true;
        }
        this._api.request("PATCH", "/prefs", body).then((prefs) => {
            this._prefs = prefs;
            this._render();
            this._scheduleStatus();
        }, (e) => {
            Main.notifyError("Tailscale", e.message);
            this._render();
        });
    }

    _switchProfile(id) {
        this._api.request("POST", "/profiles/" + id, {}).then(() => this._loadProfiles(),
            (e) => Main.notifyError("Tailscale", e.message));
    }

    _copyIp(node) {
        if (!node.ips.length)
            return;
        let clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, node.ips[0]);
        clipboard.set_text(St.ClipboardType.PRIMARY, node.ips[0]);
        Main.osdWindowManager.show(-1, this._gicon("ts-on"), "IP address has been copied to the clipboard");
    }

    _peers() {
        return Object.values((this._status && this._status.Peer) || {});
    }

    _render() {
        let available = this._available && this._prefs !== null;
        let prefs = this._prefs || {};
        let running = available && !!prefs.WantRunning;
        let exitPeer = prefs.ExitNodeID ? this._peers().find((p) => p.ID === prefs.ExitNodeID) : null;
        let exitName = exitPeer ? shortName(exitPeer) : "";
        let state = this._status ? this._status.BackendState : "";

        let subtitle = exitName;
        if (!available)
            subtitle = "Not available";
        else if (running && state && state !== "Running")
            subtitle = STATE_TEXT[state] || state;

        this.set_applet_icon_symbolic_path(this._iconDir + (running ? "ts-on" : "ts-off") + "-symbolic.svg");
        this._exitIcon.icon_size = this._applet_icon.icon_size;
        this._exitIcon.visible = running && !!prefs.ExitNodeID;
        let tooltip = "Tailscale: " + (!available ? "not available" : running ? "on" : "off");
        if (running && exitName)
            tooltip += "\nExit node: " + exitName;
        this.set_applet_tooltip(tooltip);

        this._header.update(running, subtitle, available && !!prefs.ExitNodeID, available);
        for (let menuItem of [this._nodesMenu, this._settingsMenu, this._profilesMenu])
            menuItem.setSensitive(available);
        if (!available)
            return;

        for (let [key, item] of this._prefSwitches)
            item.setToggleState(!!prefs[key]);
        this._updateNodes(prefs);
        this._updateProfiles(prefs);
    }

    // Rebuild the Nodes list only when it changes, so that an open list does not flicker.
    _updateNodes(prefs) {
        let selfIsExitNode = !!(this._status && this._status.Self && this._status.Self.ExitNodeOption);
        let nodes = this._peers().map((peer) => ({
            id: peer.ID,
            name: shortName(peer),
            os: peer.OS,
            exitNode: peer.ID === prefs.ExitNodeID,
            exitNodeOption: !!peer.ExitNodeOption,
            online: !!peer.Online,
            ips: peer.TailscaleIPs || [],
            mullvad: (peer.Tags || []).includes("tag:mullvad-exit-node"),
        })).sort(compareNodes);
        let key = JSON.stringify([selfIsExitNode, nodes]);
        if (key === this._nodesKey)
            return;
        this._nodesKey = key;

        let menu = this._nodesMenu.menu;
        menu.removeAll();
        for (let node of nodes) {
            let onClick = null;
            if (!selfIsExitNode && node.exitNodeOption)
                onClick = () => this._setPrefs({ ExitNodeID: node.exitNode ? "" : node.id });
            menu.addMenuItem(new NodeItem(nodeIconName(node), node.name, nodeSubtitle(node, selfIsExitNode),
                onClick, () => this._copyIp(node)));
        }
    }

    // Rebuild the Profiles list only when it changes.
    _updateProfiles(prefs) {
        let user = prefs.Config && prefs.Config.UserProfile ? prefs.Config.UserProfile.ID : null;
        let profiles = this._profiles
            .filter((p) => p.NetworkProfile && p.NetworkProfile.DomainName)
            .map((p) => ({
                id: p.ID,
                title: p.NetworkProfile.DisplayName || p.Name,
                subtitle: p.NetworkProfile.DomainName,
                current: prefs.ControlURL === p.ControlURL && p.UserProfile && user === p.UserProfile.ID,
            }));
        let key = JSON.stringify(profiles);
        if (key === this._profilesKey)
            return;
        this._profilesKey = key;

        let menu = this._profilesMenu.menu;
        menu.removeAll();
        for (let profile of profiles) {
            menu.addMenuItem(new ProfileItem(profile.title, profile.subtitle, profile.current, () => {
                if (!profile.current)
                    this._switchProfile(profile.id);
            }));
        }
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new TailscaleApplet(metadata, orientation, panelHeight, instanceId);
}
