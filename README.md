# Tailscale applet for Cinnamon

A Cinnamon panel applet to control [Tailscale](https://tailscale.com). Use it to:

- Turn Tailscale on or off.
- Use an exit node, or stop the exit node.
- Copy the Tailscale IP address of a node.
- Change Tailscale settings.
- Switch profiles.

The behavior copies the [tailscale-gnome-qs](https://github.com/tailscale-qs/tailscale-gnome-qs) GNOME extension.

## How it works

The applet talks to the `tailscaled` local API on the Unix socket `/var/run/tailscale/tailscaled.sock`. It does not
run the `tailscale` command.

1. The applet reads the status, the prefs, and the profiles.
2. The applet follows the IPN bus (`/watch-ipn-bus`) to get live updates.
3. If the connection fails or the stream ends, the applet tries again after 5 seconds.

## Requirements

- The Cinnamon desktop.
- libsoup 3 with GObject introspection data (`Soup 3.0`).
- `tailscaled` must run and use the socket `/var/run/tailscale/tailscaled.sock`.
- Your user must have permission to change Tailscale prefs. Set your user as the Tailscale operator:

  ```sh
  sudo tailscale set --operator=$USER
  ```

  If you do not do this, the applet can show the state, but changes fail with an error notification.

## Installation

1. Copy the applet directory to your local Cinnamon applets directory:

   ```sh
   cp -r tailscale-status@crahan ~/.local/share/cinnamon/applets/
   ```

2. Right-click the panel and select **Applets**.
3. Find **Tailscale** in the list and add it to the panel.

You can add only one instance of the applet.

## Usage

### Panel icon

| Item | Meaning |
| --- | --- |
| Tailscale dot grid, logo dots bright | Tailscale is on. |
| Tailscale dot grid, all dots dim | Tailscale is off or not available. |
| VPN icon next to the Tailscale icon | An exit node is in use. |
| Tooltip | Shows the state and the name of the exit node. |

Click the icon to open the menu.

### Menu header

- Click the header row to turn Tailscale on or off.
- The subtitle shows the exit node name. If the backend is not ready, the subtitle shows the state, for example
  "Needs login" or "Starting".
- Click the VPN button in the header to stop the exit node.

### Nodes

The **Nodes** submenu shows all peers in your tailnet. The sort order is:

1. The active exit node.
2. Other exit nodes.
3. Online nodes.
4. Name.

Actions:

- **Click** an exit node to use it. Click the active exit node to stop it.
- **Press and hold** a node for 0.5 seconds to copy its first Tailscale IP address to the clipboard.

If this machine is an exit node, you cannot select an exit node.

The node icon shows the node type:

| Icon | Node |
| --- | --- |
| Computer | Online computer or server. |
| Phone | Online Android or iOS device. |
| VPN | Online Mullvad exit node. |
| Offline | Node is offline. |

### Settings

The **Settings** submenu has a switch for each of these prefs:

| Switch | `tailscaled` pref |
| --- | --- |
| Accept routes | `RouteAll` |
| Accept DNS | `CorpDNS` |
| Allow LAN access | `ExitNodeAllowLANAccess` |
| Shields up | `ShieldsUp` |
| SSH | `RunSSH` |

### Profiles

The **Profiles** submenu shows your Tailscale profiles. A check mark shows the current profile. Click a different
profile to switch to it.

## Files

| File | Purpose |
| --- | --- |
| `tailscale-status@crahan/applet.js` | Applet code. |
| `tailscale-status@crahan/metadata.json` | Applet metadata. |
| `tailscale-status@crahan/stylesheet.css` | Menu styles. |
| `tailscale-status@crahan/icons/` | Panel icons for the on and off states. |

## Troubleshooting

- **The menu shows "Not available".** The applet cannot connect to `tailscaled`. Make sure that `tailscaled` runs and
  that the socket `/var/run/tailscale/tailscaled.sock` exists.
- **A change shows an error notification.** Your user does not have permission to change prefs. See
  [Requirements](#requirements).
- **Other errors.** The applet writes errors to the Cinnamon log with the prefix `Tailscale applet:`. To see the log,
  press <kbd>Alt</kbd>+<kbd>F2</kbd>, type `lg`, and open the **Log** tab in Looking Glass.

## Credits

This applet is based on [tailscale-gnome-qs](https://github.com/tailscale-qs/tailscale-gnome-qs), a Tailscale Quick
Settings extension for GNOME Shell. The applet copies the behavior of that extension. Thanks to its authors and
contributors.

## License

This project uses the MIT License. See [LICENSE](LICENSE).
