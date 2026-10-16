// CodeMirror states of the open files (one per tab, so each keeps its own undo history), the shared
// extensions and the Slate Blue theme. The text is never stored anywhere else.
import { Compartment, EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { tags as t } from "@lezer/highlight";
import { envValueRanges } from "./env";
import { detectIndent } from "./format";
import type { LangId } from "./lang";

export const lang = new Compartment();
export const wrap = new Compartment();
export const whitespace = new Compartment();
export const hide = new Compartment();
export const readOnly = new Compartment();

/** key → its CodeMirror state while the tab is not on screen. */
export const states = new Map<string, EditorState>();

export const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "#171D29", color: "#E6EAF2" },
    ".cm-scroller": { fontFamily: "var(--ed-font)", fontSize: "var(--ed-size)", lineHeight: "1.55" },
    ".cm-content": { caretColor: "#8AB4FF", padding: "6px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#8AB4FF" },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "#2B3F66" },
    ".cm-gutters": { backgroundColor: "#171D29", color: "#6B7690", border: "none" },
    ".cm-activeLine": { backgroundColor: "#1B2230" },
    ".cm-activeLineGutter": { backgroundColor: "#1B2230", color: "#A3ADC2" },
    ".cm-matchingBracket": { backgroundColor: "#364056", outline: "none" },
    ".cm-selectionMatch": { backgroundColor: "#2A3345" },
    ".cm-searchMatch": { backgroundColor: "#44391A", outline: "1px solid #7A6420" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#6B5418" },
    ".cm-foldPlaceholder": { backgroundColor: "#2A3345", border: "none", color: "#A3ADC2", padding: "0 6px" },
    ".cm-tooltip": { backgroundColor: "#222A3A", border: "1px solid #364056", color: "#E6EAF2" },
    ".cm-tooltip-lint": { padding: "0" },
    ".cm-diagnostic": { padding: "4px 8px" },
    ".cm-diagnostic-error": { borderLeft: "3px solid #FF7A7A" },
    ".cm-diagnostic-warning": { borderLeft: "3px solid #F2BA45" },
    ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy #FF7A7A", textUnderlineOffset: "3px" },
    ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy #F2BA45", textUnderlineOffset: "3px" },
    ".cm-panels": { backgroundColor: "#222A3A", color: "#E6EAF2", borderColor: "#364056" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid #364056" },
    ".cm-panel.cm-search": { padding: "6px 8px", fontFamily: "inherit", fontSize: "12px" },
    ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "12px" },
    ".cm-textfield": { backgroundColor: "#1B2230", border: "1px solid #364056", borderRadius: "5px", color: "#E6EAF2", padding: "2px 6px" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "#2A3345", border: "1px solid #364056", borderRadius: "5px", color: "#E6EAF2" },
    ".cm-panel.cm-search label": { color: "#A3ADC2" },
    ".cm-highlightSpace": { backgroundImage: "radial-gradient(circle at 50% 55%, #4A5670 11%, transparent 5%)" },
    ".cm-highlightTab": { backgroundImage: "none", position: "relative" },
    ".cm-hidden-value": { WebkitTextSecurity: "disc", color: "#A3ADC2" },
    ".cm-lint-marker": { width: "0.8em", height: "0.8em" },
  },
  { dark: true },
);

export const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "#8AB4FF" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#57C994" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#F2BA45" },
  { tag: [t.lineComment, t.blockComment, t.comment, t.docComment], color: "#6B7690", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.standard(t.name), t.namespace], color: "#BCD3FF" },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: "#FFB38A" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#C7A6FF" },
  { tag: [t.special(t.variableName), t.macroName, t.self], color: "#FF8FB1" },
  { tag: [t.tagName, t.heading], color: "#8AB4FF", fontWeight: "600" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "#A3ADC2" },
  { tag: t.meta, color: "#7FDBCA" },
  { tag: t.link, color: "#8AB4FF", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.invalid, color: "#FF7A7A" },
]);

/** "Hide values" for .env: values look like ••••, except on the lines you are editing. */
const hiddenMark = Decoration.mark({ class: "cm-hidden-value" });
const hideValues = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) {
      this.decorations = this.build(v);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(v: EditorView) {
      const doc = v.state.doc;
      const open = new Set<number>();
      for (const r of v.state.selection.ranges) {
        for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) open.add(l);
      }
      const b = new RangeSetBuilder<Decoration>();
      for (const r of envValueRanges(doc.toString())) {
        if (r.to <= r.from || open.has(doc.lineAt(r.from).number)) continue;
        b.add(r.from, r.to, hiddenMark);
      }
      return b.finish();
    }
  },
  { decorations: (p) => p.decorations },
);

export const wrapExt = (on: boolean): Extension => (on ? EditorView.lineWrapping : []);
export const whitespaceExt = (on: boolean): Extension => (on ? highlightWhitespace() : []);
export const hideExt = (on: boolean, l: LangId): Extension => (on && l === "env" ? hideValues : []);
export const readOnlyExt = (on: boolean): Extension => (on ? [EditorState.readOnly.of(true), EditorView.editable.of(true)] : []);

export interface StateOpts {
  text: string;
  lang: LangId;
  readOnly: boolean;
  wrap: boolean;
  whitespace: boolean;
  hideValues: boolean;
  /** Every update (text, cursor): the workspace shows dirty state, position, problems. */
  onUpdate: (u: ViewUpdate) => void;
  /** Ctrl+S inside the editor. */
  onSave: () => void;
  onFormat: () => void;
}

export function createState(o: StateOpts): EditorState {
  const { useTabs, width } = detectIndent(o.text);
  return EditorState.create({
    doc: o.text,
    extensions: [
      lineNumbers(),
      foldGutter({ markerDOM: (open) => Object.assign(document.createElement("span"), { textContent: open ? "▾" : "▸", className: "text-muted" }) }),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      // Only \n breaks lines: a stray \r stays a character, so saving never changes it.
      EditorState.lineSeparator.of("\n"),
      indentOnInput(),
      indentUnit.of(useTabs ? "\t" : " ".repeat(width)),
      EditorState.tabSize.of(useTabs ? 4 : width),
      syntaxHighlighting(highlight),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: false }),
      theme,
      lang.of([]),
      wrap.of(wrapExt(o.wrap)),
      whitespace.of(whitespaceExt(o.whitespace)),
      hide.of(hideExt(o.hideValues, o.lang)),
      readOnly.of(readOnlyExt(o.readOnly)),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (o.onSave(), true) },
        { key: "Shift-Alt-f", preventDefault: true, run: () => (o.onFormat(), true) },
        { key: "Mod-g", preventDefault: true, run: gotoLine },
        ...closeBracketsKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...lintKeymap,
        indentWithTab,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((u) => o.onUpdate(u)),
    ],
  });
}
