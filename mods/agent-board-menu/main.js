// The agent board's right-click menu, and its rename dialog.
// Props: { terminal, name, pinned, renamed, mode: "menu" | "rename", overlay }.
// A name is the terminal's `task` label, which the board shows as the card's title;
// it lives in herdr-core, so every Herdr client sees it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { closeOverlay, hc, notify, openOverlay, props, run, theme } from "herdr";

async function setName(terminal, name) {
  const res = await hc(["label", terminal, `task=${name}`]);
  if (res.code !== 0) {
    notify({ title: "Não deu para renomear", body: (res.stderr || res.stdout).trim(), level: "error" });
  }
}

function items(p) {
  return [
    ["Renomear", "square-pen", () => openOverlay({
      mod: "agent-board-menu", kind: "dialog", width: 400, height: 200,
      props: { ...p, overlay: undefined, mode: "rename" },
    })],
    p.pinned
      ? ["Desafixar", "pin-off", () => run("terminal.pin", { terminal: p.terminal, pinned: false })]
      : ["Fixar no topo", "pin", () => run("terminal.pin", { terminal: p.terminal, pinned: true })],
    ...(p.renamed ? [["Voltar ao nome original", "x", () => setName(p.terminal, "")]] : []),
  ];
}

export default class AgentBoardMenu extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.at = 0;
    this.handle = cx.focus_handle();
    if (p.mode === "rename") {
      this.text = p.name ?? "";
      this.input = InputState.new({ value: this.text, placeholder: "Nome da sessão" });
      if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
      this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
      this.input.on("submit", () => this.submit());
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
    } else {
      this.handle.focus();
    }
  }

  choose(i) {
    const p = props();
    const it = items(p)[i];
    if (!it) return;
    closeOverlay(p.overlay);
    it[2]();
  }

  submit() {
    const p = props();
    closeOverlay(p.overlay);
    setName(p.terminal, this.text.trim());
  }

  renderRename(t, p) {
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("rename").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        closeOverlay(p.overlay);
        cx.stop_propagation();
      })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Renomear sessão"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child(p.terminal))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent)
        .bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(div().pt(6).text_size(11.5).text_color(t.dim).child("Vazio volta ao nome original."))
      .child(h_flex().pt(16).gap(8).justify_end()
        .child(button("rn-cancel", "Cancelar", false, () => closeOverlay(p.overlay)))
        .child(button("rn-save", "Salvar", true, () => this.submit())));
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    if (p.mode === "rename") return this.renderRename(t, p);
    const list = items(p);
    return v_flex()
      .id("agent-board-menu").track_focus(this.handle)
      .w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") closeOverlay(p.overlay);
        else return;
        cx.notify();
      })
      .children(list.map(([label, icon], i) => h_flex()
        .id(`abm-${i}`).h(31).px(8).gap(9).rounded(7).items_center()
        .text_color(t.foreground)
        .when(i === this.at, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.choose(i))
        .child(svg(`mods/workspace-chrome/${icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(label))));
  }
}
