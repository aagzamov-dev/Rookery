import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, Decoration, type DecorationSet } from "@codemirror/view";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { sql, MySQL, PostgreSQL, type SQLNamespace } from "@codemirror/lang-sql";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Dialect } from "./split";

export interface SqlEditorHandle {
  view: () => EditorView | null;
  focus: () => void;
  /** Replace the selection (or insert at the cursor). */
  insert: (text: string) => void;
  /** Replace everything. */
  setText: (text: string) => void;
  /** Underline an error (null clears). */
  markError: (from: number | null, to?: number) => void;
}

interface Props {
  initial: string;
  dialect: Dialect;
  /** schema → table → columns (or table → columns), for completion. */
  schema: SQLNamespace;
  defaultSchema?: string;
  fontFamily: string;
  fontSize: number;
  onChange: (text: string) => void;
}

// Slate Blue (docs/00 §6).
const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "#171D29", color: "#E6EAF2" },
    ".cm-scroller": { fontFamily: "var(--sql-font)", fontSize: "var(--sql-size)", lineHeight: "1.5" },
    ".cm-content": { caretColor: "#8AB4FF", padding: "8px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#8AB4FF" },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "#2B3F66" },
    ".cm-gutters": { backgroundColor: "#171D29", color: "#6B7690", border: "none" },
    ".cm-activeLine": { backgroundColor: "#1B2230" },
    ".cm-activeLineGutter": { backgroundColor: "#1B2230", color: "#A3ADC2" },
    ".cm-matchingBracket": { backgroundColor: "#364056", outline: "none" },
    ".cm-tooltip": { backgroundColor: "#222A3A", border: "1px solid #364056", color: "#E6EAF2" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "#2B3F66", color: "#E6EAF2" },
    ".cm-completionDetail": { color: "#A3ADC2" },
    ".cm-sql-error": { textDecoration: "underline wavy #FF7A7A", textUnderlineOffset: "3px", backgroundColor: "#33232A" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "#8AB4FF" },
  { tag: [t.string, t.special(t.string)], color: "#57C994" },
  { tag: [t.number, t.bool, t.null], color: "#F2BA45" },
  { tag: [t.lineComment, t.blockComment], color: "#6B7690", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.name)], color: "#BCD3FF" },
  { tag: [t.operator, t.punctuation], color: "#A3ADC2" },
  { tag: t.special(t.name), color: "#FFA8A8" },
]);

const setError = StateEffect.define<{ from: number; to: number } | null>();
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    if (tr.docChanged) deco = Decoration.none;
    for (const e of tr.effects) {
      if (e.is(setError)) {
        deco = e.value && e.value.to > e.value.from ? Decoration.set([Decoration.mark({ class: "cm-sql-error" }).range(e.value.from, e.value.to)]) : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function language(dialect: Dialect, schema: SQLNamespace, defaultSchema?: string) {
  return sql({ dialect: dialect === "mysql" ? MySQL : PostgreSQL, schema, defaultSchema, upperCaseKeywords: false });
}

/** CodeMirror 6 SQL editor. Shortcuts (run, cancel) come from the app's key dispatcher. */
export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor({ initial, dialect, schema, defaultSchema, fontFamily, fontSize, onChange }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true }),
          lang.current.of(language(dialect, schema, defaultSchema)),
          syntaxHighlighting(highlight),
          theme,
          errorField,
          EditorView.lineWrapping,
          keymap.of([...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) change.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The document is owned by CodeMirror after the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(language(dialect, schema, defaultSchema)) });
  }, [dialect, schema, defaultSchema]);

  useImperativeHandle(ref, () => ({
    view: () => view.current,
    focus: () => view.current?.focus(),
    insert: (text) => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      v.focus();
    },
    setText: (text) => {
      const v = view.current;
      if (!v) return;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: text.length } });
    },
    markError: (from, to) => {
      const v = view.current;
      if (!v) return;
      if (from == null) {
        v.dispatch({ effects: setError.of(null) });
        return;
      }
      const len = v.state.doc.length;
      const a = Math.min(Math.max(0, from), len);
      // Underline the word at the error (or one char).
      let b = to ?? a;
      if (to == null) {
        const text = v.state.doc.sliceString(a, Math.min(len, a + 64));
        const m = /^[\w$."`]+/.exec(text);
        b = a + (m ? m[0].length : 1);
      }
      v.dispatch({ effects: setError.of({ from: a, to: Math.min(b, len) }), selection: { anchor: a }, scrollIntoView: true });
    },
  }));

  return <div ref={host} className="h-full min-h-0 overflow-hidden" style={{ ["--sql-font" as string]: fontFamily, ["--sql-size" as string]: `${fontSize}px` }} />;
});
