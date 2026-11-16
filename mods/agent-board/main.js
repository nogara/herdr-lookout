// An attention queue: what needs a person first, then one summary per machine.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, checking, exec, machines, notify, openOverlay, panes, run, setAgentOrder, spaces, terminals, theme } from "herdr";

// One muted color per machine, so a card says where its agent runs.
// Every hue has the same OKLCH lightness and chroma (light 0.50/0.075, dark
// 0.78/0.075), so no machine shouts. Red and the accent blue are left out:
// they mean "needs you" and "focused". Each color reads as text at 5:1 or
// more on the card background of `daylight` and `graphite`.

const PALETTE = [
  { light: "#347158", dark: "#89c7ab" }, // sage
  { light: "#835935", dark: "#dcad87" }, // clay
  { light: "#2b6c83", dark: "#82c2dc" }, // steel
  { light: "#635c8b", dark: "#b6b0e5" }, // lavender
  { light: "#71632d", dark: "#c6b780" }, // ochre
  { light: "#7c5378", dark: "#d3a6ce" }, // mauve
  { light: "#556c3d", dark: "#a8c28f" }, // olive
  { light: "#207070", dark: "#7bc7c6" }, // teal
];

// Fixed palette slots per machine name; `null` is this computer.
// Add your own, e.g. "my-server": 1. Unlisted machines get a stable color by hash.
const ASSIGNED = {
  local: 0,
};

// FNV-1a, so an unknown machine keeps the same color across restarts.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// How much of the machine's color shows in a card's background. At 5% the
// card text, the links and the label lose under a tenth of their contrast.
const TINT = 0.05;

function isDark(background) {
  const hex = /^#([0-9a-f]{6})/i.exec(background ?? "")?.[1];
  if (!hex) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

// The machine's color for the theme `t`, picked by its card background.
function machineColor(name, t) {
  const key = name ?? "local";
  const index = ASSIGNED[key] ?? hash(key) % PALETTE.length;
  return PALETTE[index][isDark(t.background) ? "dark" : "light"];
}

// The card background with a faint wash of the machine's color, as one opaque
// color, so hover and focus still draw over it as before.
function machineTint(name, t) {
  const base = /^#([0-9a-f]{6})/i.exec(t.background ?? "")?.[1];
  if (!base) return t.background;
  const color = machineColor(name, t).slice(1);
  const channel = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
  return "#" + [0, 2, 4].map((i) => Math.round(channel(color, i) * TINT + channel(base, i) * (1 - TINT))
    .toString(16).padStart(2, "0")).join("");
}

// --- open-url: begin
// Links a session on another machine asked to open here.
//
// A remote machine can replace `open`/`xdg-open` with a script that sets the
// label `open.url` on the caller's terminal to "<epoch seconds> <url>" (for
// example `hc label "$HC_TERMINAL_ID" "open.url=$(date +%s) $1"`). This finds
// the values not handled yet, so the board can open them with macOS `open`.
//
// Only http(s) URLs pass, checked here again whatever the remote sent. A value
// older than MAX_AGE_S is dropped, so a label left behind does not open again
// after a restart. The first scan only records what is already there.

const OPEN_LABEL = "open.url";
const MAX_AGE_S = 120;
const MAX_LEN = 4096;
// No whitespace or control characters: one argument, nothing a shell could split.
const URL_RE = /^https?:\/\/[^\s\x00-\x1f\x7f]+$/;

/** "<epoch seconds> <url>" as { at, url }, or null when it is anything else. */
function parseRequest(value) {
  const m = /^(\d{1,12}) (\S+)$/.exec(typeof value === "string" ? value : "");
  if (!m) return null;
  const url = m[2];
  if (url.length > MAX_LEN || !URL_RE.test(url)) return null;
  return { at: Number(m[1]), url };
}

/** The URLs to open now. `seen` (address → value) is updated in place.
 *  `first`: record what is there without opening any of it. */
function linksToOpen(terminals, seen, nowS, first) {
  const urls = [];
  for (const t of terminals ?? []) {
    const value = t?.labels?.[OPEN_LABEL];
    if (!value || !t.address || seen.get(t.address) === value) continue;
    seen.set(t.address, value);
    if (first) continue;
    const req = parseRequest(value);
    if (req && Math.abs(nowS - req.at) <= MAX_AGE_S) urls.push(req.url);
  }
  return urls;
}
// --- open-url: end

const PINNED = { status: "pinned", label: "Fixadas", color: "accent" };

// Red means the person must act. A red section hides while it is empty.
const SECTIONS = [
  { status: "blocked", label: "Precisa de você", urgent: true },
  { status: "inbox", label: "Responder no inbox", color: "blocked", urgent: true },
  { status: "done", label: "Feito, não visto" },
  { status: "waiting", label: "Esperando", color: "accent" },
  { status: "cooling", label: "Cache esfriando", color: "working" },
  { status: "working", label: "Trabalhando" },
];

const TICKET = /\b(CU-[a-z0-9]+|86[a-z0-9]{7}|[A-Z]{2,6}-\d+)\b/;
const LOCAL = "Este Mac";

// The prompt cache's lifetime is a guess at 1 hour; set it to what the sessions use.
const CACHE_TTL_MS = 60 * 60000;
const CACHE_WARN_MS = 50 * 60000;

const LOAD_COMMAND = "cut -d' ' -f1 /proc/loadavg; free -g | awk 'NR==2 { print $3 \"/\" $2 }'";

const cardUrl = (ticket) => {
  const id = ticket?.replace(/^CU-/, "");
  return id && /^(CU-|86)/.test(ticket) ? `https://app.clickup.com/t/${id}` : null;
};

function ticketOf(...texts) {
  for (const text of texts) {
    const found = text?.match(TICKET);
    if (found) return found[1];
  }
  return null;
}

const machineLabel = (name) => (name ?? LOCAL).replace(/^devvm-/, "");

// A thin bar on a card's left edge in its machine's color. The card's own
// border stays free for focus and selection.
const machineStripe = (name, t) => div().absolute().left(0).top(0).bottom(0).w(3)
  .rounded_l(5).bg(machineColor(name, t));

// A pinned card stays in "Fixadas", so a small pill names its status with the
// label and color of the section it would sit in. Red only where the person
// must act, as in the queue; idle stays in the calm idle color.
const IDLE = { status: "idle", label: "Parado" };
// A `#rrggbb` color with an alpha, or `fallback` for any other form.
const withAlpha = (color, alpha, fallback) => (/^#[0-9a-f]{6}$/i.test(color ?? "") ? color + alpha : fallback);

function statusBadge(group, t) {
  const section = [...SECTIONS, IDLE].find((s) => s.status === group) ?? IDLE;
  const color = t[section.color ?? section.status] ?? t.muted;
  return div().flex_none().px(6).rounded(4).text_size(12).text_color(color)
    .bg(withAlpha(color, "1a", t.raised)).border(1).border_color(withAlpha(color, "59", t.border))
    .child(section.label);
}

// A remote terminal's parent can be its bare address; compare both in full.
function parentOf(terminal) {
  const { parent, address } = terminal;
  if (!parent || parent.includes("/") || !address.includes("/")) return parent ?? null;
  return `${address.split("/")[0]}/${parent}`;
}

// What the agent is doing: a `task` label wins, then the title the agent set.
function taskOf(agent, terminal) {
  const title = (agent.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const generic = !title || title === agent.program?.name || title === "claude";
  return terminal?.labels?.task ?? (generic ? null : title);
}

function duration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "<1 min";
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

function age(ms) {
  return ms ? duration(Date.now() - ms) : null;
}

// How many inbox items wait on the person, from the labels the inbox plugin sets.
function inboxAsks(terminal) {
  return Number(terminal?.labels?.["inbox.needs-you"]) || 0;
}

// The core has no waiting state. An agent counts as waiting while it has a busy
// helper or carries a `wait` label; `error` is a person's job, like `blocked`.
// A session that stopped with inbox items open waits on the person, even while
// its helpers still work.
function classify(agent, terminal, busyChildren) {
  if (terminal?.status === "error") return { group: "blocked", note: "erro" };
  if (agent.status === "working" || agent.status === "blocked") return { group: agent.status };
  if (inboxAsks(terminal) > 0) return { group: "inbox", note: terminal.labels["inbox.status"] };
  const reason = terminal?.labels?.wait
    ?? (busyChildren > 0 ? `${busyChildren} sub-agente(s)` : null);
  if (!reason) return { group: agent.status };
  const since = age(terminal?.status_ms);
  return { group: "waiting", note: since ? `${reason} · ${since}` : reason };
}

export default class AgentBoard extends View {
  init(_props, cx) {
    this.selected = undefined;
    this.opened = {};
    this.turnEnded = {};
    this.query = "";
    this.showDelegates = false;
    this.expanded = {};
    this.load = {};
    this.search = InputState.new({ placeholder: "Buscar agente, repo, ticket ou branch…" });
    this.search.on("change", (_event, cx) => {
      this.query = this.search.value().trim().toLowerCase();
      cx.notify();
    });
    cx.timer.every(60000, (cx) => {
      this.refreshLoad(cx);
      cx.notify();
    });
    this.refreshLoad(cx);
    // Links a remote session asked to open (label `open.url`), opened here.
    this.openSeen = new Map();
    this.openFirst = true;
    if (!checking()) cx.timer.every(1000, () => this.openRequested());
  }

  openRequested() {
    const urls = linksToOpen(terminals(), this.openSeen, Math.floor(Date.now() / 1000), this.openFirst);
    this.openFirst = false;
    for (const url of urls) {
      exec("open", [url]).catch(() =>
        notify({ title: "Não abri o link remoto", body: url, level: "warning" }));
    }
  }

  // One reading per host: machines named `devvm-<x>` are treated as one host.
  refreshLoad(cx) {
    const hosts = {};
    for (const { name } of machines()) {
      if (name) hosts[name.startsWith("devvm-") ? "devvm" : name] ??= name;
    }
    cx.spawn(async (cx) => {
      for (const [host, machine] of Object.entries(hosts)) {
        try {
          const res = await exec("sh", ["-c", LOAD_COMMAND], { on: machine });
          const [load, memory] = res.stdout.trim().split("\n");
          this.load[host] = `${host} load ${load} · RAM ${memory} GB`;
        } catch {
          delete this.load[host];
        }
      }
      cx.notify();
    });
  }

  matches(agent) {
    if (!this.query) return true;
    const text = [agent.task, agent.space_name, agent.tab_name, agent.branch, agent.machine, agent.note];
    return text.filter(Boolean).join(" ").toLowerCase().includes(this.query);
  }

  // When each agent's last turn ended, which is about when its cache was last used.
  // Viewing a done agent turns it idle, so only a busy status clears the time.
  trackTurn(agent, terminal) {
    if (agent.status === "working" || agent.status === "blocked") {
      delete this.turnEnded[agent.address];
      return null;
    }
    this.turnEnded[agent.address] ??= terminal?.status_ms ?? Date.now();
    return Date.now() - this.turnEnded[agent.address];
  }

  async openPullRequest(agent, cwd) {
    try {
      const res = await exec("gh", ["pr", "view", "--json", "url", "--jq", ".url"],
        { cwd, on: agent.machine ?? undefined });
      const url = res.stdout.trim();
      if (!url) throw new Error("no PR");
      await exec("open", [url]);
    } catch {
      notify({ title: "Nenhum PR nesta branch", body: agent.branch ?? "", level: "warning" });
    }
  }

  link(id, label, t, action) {
    return div().id(id).px(6).rounded(4).flex_none().text_size(12).text_color(t.accent)
      .hover((el) => el.bg(t.raised))
      .on_click((_event, cx) => {
        cx.stop_propagation();
        action(cx);
      })
      .child(label);
  }

  // Right-click: rename (the `task` label) or pin (herdr's own `terminal.pin`).
  openMenu(agent) {
    const renamed = Boolean(agent.renamed);
    openOverlay({
      mod: "agent-board-menu", kind: "popup", width: 220, height: renamed ? 104 : 72,
      props: { terminal: agent.address, name: agent.task ?? "", pinned: Boolean(agent.pinned), renamed, mode: "menu" },
    });
  }

  // A coordinator's delegates hide under it; its card opens them in place.
  delegatesLine(agent, t, prefix) {
    const list = agent.delegates;
    const open = Boolean(this.expanded[agent.address]);
    // Only a blocked delegate needs the person; the coordinator relays the rest.
    const needs = list.filter((d) => d.group === "blocked").length;
    const working = list.filter((d) => d.group === "working" || d.group === "waiting").length;
    const text = [`${list.length} delegado(s)`, working && `${working} trabalhando`, needs && `${needs} bloqueado(s)`]
      .filter(Boolean).join(" · ");
    return div().id(`${prefix}delegates-${agent.address}`).px(6).rounded(4).text_size(12)
      .text_color(needs ? t.blocked : t.accent)
      .hover((el) => el.bg(t.raised))
      .on_click((_event, cx) => {
        cx.stop_propagation();
        this.expanded[agent.address] = !open;
        cx.notify();
      })
      .child(`${open ? "▾" : "▸"} ${text}`);
  }

  item(agent, t, prefix = "") {
    const nested = !this.showDelegates && agent.delegates?.length > 0;
    const card = this.card(agent, t, prefix);
    if (!nested) return card;
    return v_flex().gap(4)
      .child(card)
      .child(this.delegatesLine(agent, t, prefix))
      .when(Boolean(this.expanded[agent.address]), (el) => el.child(
        v_flex().gap(4).pl(16).children(agent.delegates.map((d) => this.item(d, t, `${prefix}${agent.address}>`)))));
  }

  card(agent, t, prefix) {
    const ticket = ticketOf(agent.space_name, agent.tab_name, agent.title, agent.branch);
    const where = agent.tab_name ? `${agent.space_name} / ${agent.tab_name}` : agent.space_name;
    const headline = agent.task ?? where;
    const place = agent.task ? agent.space_name : null;
    const from = this.showDelegates && agent.parentName ? `delegado de ${agent.parentName}` : null;
    const details = [from, place, agent.branch, ticket, agent.note].filter(Boolean).join(" · ");
    return v_flex()
      .id(`${prefix}item-${agent.address}`)
      .relative().gap(2).pl(12).pr(10).py(6).rounded(6).bg(machineTint(agent.machine, t))
      .border(1).border_color(agent.focused ? t.accent : t.border)
      .hover((el) => el.bg(t.hover))
      .on_mouse_down("right", (_event, cx) => {
        cx.stop_propagation();
        this.openMenu(agent);
      })
      .on_click(() => {
        this.opened[agent.address] = { group: agent.group, seen: false };
        return agent.pane
          ? run("pane.focus", { pane: agent.pane })
          : run("terminal.peek", { terminal: agent.address });
      })
      .child(machineStripe(agent.machine, t))
      .child(h_flex().gap(10)
        .child(div().w(72).flex_none().truncate().text_size(12).text_color(machineColor(agent.machine, t))
          .child(machineLabel(agent.machine)))
        .child(div().flex_1().truncate().text_size(13).text_color(t.foreground).child(headline))
        .when(agent.asks > 0 && agent.group !== "inbox", (row) => row.child(
          div().flex_none().text_size(12).text_color(t.muted).child(`inbox ${agent.asks}`)))
        .when(Boolean(agent.pinned), (row) => row.child(statusBadge(agent.group, t)))
        .when(Boolean(agent.pinned), (row) => row.child(
          svg("mods/workspace-chrome/pin.svg").size(12).flex_none().text_color(t.accent))))
      .when(Boolean(details || agent.cwd), (el) => el.child(h_flex().gap(4)
        .child(div().flex_1().truncate().text_size(12).text_color(t.dim).child(details))
        .when(Boolean(cardUrl(ticket)), (row) => row.child(this.link(
          `${prefix}card-${agent.address}`, "card", t, () => exec("open", [cardUrl(ticket)]))))
        .when(Boolean(agent.cwd && agent.branch && !["main", "master"].includes(agent.branch)), (row) => row.child(this.link(
          `${prefix}pr-${agent.address}`, "PR", t, () => this.openPullRequest(agent, agent.cwd))))));
  }

  section(section, list, t) {
    return v_flex().gap(6)
      .child(h_flex().gap(8)
        .child(div().text_size(13).font_semibold().text_color(t[section.color ?? section.status]).child(section.label))
        .child(div().text_size(12).text_color(t.dim).child(String(list.length))))
      .children(list.map((a) => this.item(a, t)));
  }

  summary(row, t) {
    const attention = row.agents.filter((a) => a.group !== "idle").length;
    const isSelected = this.selected === row.name;
    const text = row.layout === "ready"
      ? `${row.agents.length} · ${attention} ativos`
      : row.layout;
    const key = row.name ?? "local";
    return h_flex()
      .id(`machine-${key}`)
      .relative().gap(12).pl(12).pr(10).py(6).rounded(6).bg(t.surface).items_center()
      .border(1).border_color(isSelected ? t.accent : t.border)
      .hover((el) => el.bg(t.hover))
      .on_click((_event, cx) => {
        this.selected = isSelected ? undefined : row.name;
        cx.notify();
      })
      .child(machineStripe(row.name, t))
      .child(v_flex().gap(2)
        .child(div().text_size(13).text_color(machineColor(row.name, t)).child(machineLabel(row.name)))
        .child(div().text_size(12).text_color(t.dim).child(text)))
      .when(row.layout === "ready", (el) => el.child(
        div().id(`new-space-${key}`)
          .px(8).py(2).rounded(4).text_size(16).text_color(t.muted)
          .hover((b) => b.bg(t.raised).text_color(t.foreground))
          .on_click((_event, cx) => {
            cx.stop_propagation();
            run("space.new", { machine: row.name ?? "" });
          })
          .child("+")));
  }

  // Looking at a done agent makes it idle. Keep it in its section while it is
  // open, so the queue does not change under the click.
  keepOpened(agent) {
    const opened = this.opened[agent.address];
    if (!opened) return agent;
    if (agent.focused) opened.seen = true;
    else if (opened.seen) delete this.opened[agent.address];
    const keep = this.opened[agent.address] && agent.group === "idle";
    return keep ? { ...agent, group: opened.group, note: "aberto agora" } : agent;
  }

  render() {
    const t = theme();
    const machineOf = Object.fromEntries(spaces().map((s) => [s.id, s.machine ?? null]));
    const paneOf = Object.fromEntries(panes().filter((p) => p.terminal).map((p) => [p.terminal, p]));
    const live = terminals().filter((x) => x.state === "live");
    const byAddress = Object.fromEntries(live.map((x) => [x.address, x]));
    // A plain program reports no status, so a live one counts as busy.
    const busyChildren = (address) => live.filter((x) => parentOf(x) === address
      && x.status !== "idle" && x.status !== "done").length;
    const listed = agents().map((a) => {
      const terminal = byAddress[a.address];
      const entry = {
        ...a,
        ...classify(a, terminal, busyChildren(a.address)),
        task: taskOf(a, terminal),
        asks: inboxAsks(terminal),
        renamed: Boolean(terminal?.labels?.task),
        machine: machineOf[a.space] ?? null,
        branch: paneOf[a.address]?.branch ?? null,
        cwd: paneOf[a.address]?.cwd ?? null,
      };
      const idleFor = this.trackTurn(a, terminal);
      if (idleFor === null) return entry;
      const note = [entry.note, `há ${duration(idleFor)}`].filter(Boolean).join(" · ");
      const cooling = entry.group === "idle" && idleFor >= CACHE_WARN_MS && idleFor < CACHE_TTL_MS;
      return { ...entry, note, group: cooling ? "cooling" : entry.group };
    }).map((a) => this.keepOpened(a));
    // agents() may leave out a terminal in `error`, so it is added from terminals().
    const known = new Set(listed.map((a) => a.address));
    const failed = live.filter((x) => x.status === "error" && !known.has(x.address)).map((x) => ({
      address: x.address,
      space_name: x.labels?.where ?? x.address,
      group: "blocked",
      note: "erro",
      machine: x.address.includes("/") ? x.address.split("/")[0] : null,
      branch: null,
    }));
    const all = [...listed, ...failed];
    // A terminal another agent started is that agent's delegate. The coordinator
    // is where the person talks, so delegates hide under it unless shown or searched.
    const parentAt = Object.fromEntries(live.map((x) => [x.address, parentOf(x)]));
    const byAgent = Object.fromEntries(all.map((a) => [a.address, a]));
    for (const a of all) {
      const parent = byAgent[parentAt[a.address]];
      a.delegates = [];
      a.parent = parent?.address ?? null;
      a.parentName = parent ? parent.task ?? parent.space_name : null;
    }
    for (const a of all) if (a.parent) byAgent[a.parent].delegates.push(a);
    const visible = (a) => this.showDelegates || !a.parent || Boolean(this.query);
    const rows = machines().map((m) => ({
      ...m,
      agents: all.filter((a) => a.machine === m.name),
    }));
    // Pinned agents leave their status section for one of their own, on top,
    // whatever machine is selected.
    const pinned = all.filter((a) => a.pinned && visible(a) && this.matches(a));
    const queue = SECTIONS.map((s) => ({
      section: s,
      list: all.filter((a) => !a.pinned && a.group === s.status && visible(a) && this.matches(a)
        && (this.selected === undefined || a.machine === this.selected)),
    }));
    const shown = rows.find((r) => r.name === this.selected);
    // No machine selected means every machine, so a session can be found anywhere.
    const onShown = (machine) => this.selected === undefined || machine === this.selected;
    // Terminals in the app that report no status never reach agents().
    const silent = live
      .filter((x) => x.labels?.["herdr.space"] && !known.has(x.address)
        && (this.showDelegates || !byAgent[parentAt[x.address]]))
      .map((x) => ({
        address: x.address,
        space_name: x.labels?.where ?? x.address,
        note: x.title || x.foreground?.name || null,
        machine: x.address.includes("/") ? x.address.split("/")[0] : null,
        branch: null,
      }))
      .filter((x) => onShown(x.machine) && this.matches(x));
    const idle = all.filter((a) => !a.pinned && a.group === "idle" && visible(a) && this.matches(a) && onShown(a.machine));
    const hidden = all.filter((a) => a.parent).length;
    const idleTitle = shown ? `Parados em ${machineLabel(shown.name)}` : "Parados";

    setAgentOrder([...pinned, ...queue.flatMap((q) => q.list)].map((a) => a.address));

    return v_flex()
      .id("board").size_full().gap(16).p(14).bg(t.canvas).overflow_y_scrollbar()
      .child(h_flex().h(30).px(10).rounded(6).bg(t.background).border(1).border_color(t.border)
        .child(Input.new(this.search).flex_1().h_full().text_size(13).text_color(t.foreground))
        .when(hidden > 0, (row) => row.child(this.link("toggle-delegates",
          this.showDelegates ? `ocultar ${hidden} delegado(s)` : `mostrar ${hidden} delegado(s)`, t, (cx) => {
            this.showDelegates = !this.showDelegates;
            cx.notify();
          }))))
      .when(pinned.length > 0, (el) => el.child(this.section(PINNED, pinned, t)))
      .children(queue.filter((q) => !q.section.urgent || q.list.length > 0)
        .map((q) => this.section(q.section, q.list, t)))
      .child(v_flex().gap(6)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Máquinas"))
        .children(Object.values(this.load).map((line) =>
          div().text_size(12).text_color(t.dim).child(line)))
        .child(h_flex().gap(8).flex_wrap().children(rows.map((r) => this.summary(r, t)))))
      .when(Boolean(shown) || idle.length > 0, (el) => el.child(this.section(
        { status: "idle", label: idleTitle }, idle, t)))
      .when(silent.length > 0, (el) => el.child(this.section(
        { status: "idle", label: "Sem status" }, silent, t)));
  }
}
