# herdr-lookout

A Herdr app layout that keeps watch over your agents.

The "board" layout puts an agent board on the left
(what needs you first, then one summary per machine), and the active tab on the
right under a context bar showing the focused machine and branch.

## Contents

```
layouts/board.json          the layout (theme: daylight light / graphite dark)
themes/daylight.json        light theme (graphite ships with the app)
mods/agent-board/           the board: attention groups, search, PR/ClickUp links, machine colors
mods/agent-board-menu/      right-click menu on a card: rename, pin
mods/context-bar/           focused machine + space + branch
```

## Install

Copy (do not symlink) everything into the Herdr app folder, then pick the
"board" layout in the app:

```sh
mkdir -p ~/.config/herdr-app
cp -R layouts themes mods ~/.config/herdr-app/
```

The app writes `jsconfig.json` and `.d.ts` files into each mod folder; that is
expected.

## Customize

- **Machine colors**: edit `ASSIGNED` at the top of `mods/agent-board/main.js`
  to pin a palette slot (0-7) to a machine name. Unlisted machines get a stable
  color from a hash of their name.
- **Load readout**: the board runs `/proc/loadavg` + `free -g` on each remote
  (Linux) machine every minute. Machines named `devvm-<x>` count as one host.
- **Remote links**: the board opens http(s) URLs a remote session publishes in
  its terminal's `open.url` label. Ignore it if you do not use remote machines.
- **Ticket links**: tickets that look like `CU-…` or `86…` link to ClickUp.
- UI strings are in Portuguese (pt-BR).

## License

MIT. See [LICENSE](LICENSE).
