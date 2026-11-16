// Which organisation the focused terminal belongs to, in a colour of its own.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { focused, panes, spaces, theme } from "herdr";

const COLORS = ["ansi1", "ansi2", "ansi3", "ansi4", "ansi5", "ansi6"];

function colorOf(name, t) {
  const sum = [...name].reduce((total, char) => total + char.charCodeAt(0), 0);
  return t[COLORS[sum % COLORS.length]];
}

export default class ContextBar extends View {
  render() {
    const t = theme();
    const now = focused();
    const space = spaces().find((s) => s.id === now?.space);
    const name = (space?.machine ?? "Este Mac").replace(/^devvm-/, "");
    const branch = panes().find((p) => p.pane === now?.pane)?.branch;
    const place = [space?.name, branch].filter(Boolean).join(" · ");
    return h_flex()
      .size_full().gap(10).px(10).items_center().bg(t.chrome)
      .child(div().px(8).py(1).rounded(4).bg(colorOf(name, t)).text_color(t.background)
        .text_size(13).font_semibold().child(name.toUpperCase()))
      .child(div().flex_1().truncate().text_size(12).text_color(t.muted).child(place));
  }
}
