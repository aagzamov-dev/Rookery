import type { ITheme } from "@xterm/xterm";

type Pal = [string, string, string, string, string, string, string, string];

function make(bg: string, fg: string, cursor: string, selection: string, normal: Pal, bright: Pal): ITheme {
  const [black, red, green, yellow, blue, magenta, cyan, white] = normal;
  const [brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = bright;
  return {
    background: bg,
    foreground: fg,
    cursor,
    cursorAccent: bg,
    selectionBackground: selection,
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  };
}

export const DEFAULT_THEME = "Slate Blue";

export const BUILTIN_THEMES: Record<string, ITheme> = {
  "Slate Blue": make("#171D29", "#D3D9E4", "#8AB4FF", "#34507E",
    ["#2A3345", "#FF7A7A", "#57C994", "#F2BA45", "#8AB4FF", "#C792EA", "#7FDBCA", "#D3D9E4"],
    ["#8390A8", "#FF8A8A", "#86E0B6", "#F7CB6A", "#BCD3FF", "#DDB6F2", "#A3EFE0", "#E6EAF2"]),
  "One Dark": make("#282C34", "#ABB2BF", "#528BFF", "#3E4451",
    ["#282C34", "#E06C75", "#98C379", "#E5C07B", "#61AFEF", "#C678DD", "#56B6C2", "#ABB2BF"],
    ["#5C6370", "#E06C75", "#98C379", "#E5C07B", "#61AFEF", "#C678DD", "#56B6C2", "#FFFFFF"]),
  Dracula: make("#282A36", "#F8F8F2", "#F8F8F2", "#44475A",
    ["#21222C", "#FF5555", "#50FA7B", "#F1FA8C", "#BD93F9", "#FF79C6", "#8BE9FD", "#F8F8F2"],
    ["#6272A4", "#FF6E6E", "#69FF94", "#FFFFA5", "#D6ACFF", "#FF92DF", "#A4FFFF", "#FFFFFF"]),
  Nord: make("#2E3440", "#D8DEE9", "#D8DEE9", "#434C5E",
    ["#3B4252", "#BF616A", "#A3BE8C", "#EBCB8B", "#81A1C1", "#B48EAD", "#88C0D0", "#E5E9F0"],
    ["#4C566A", "#BF616A", "#A3BE8C", "#EBCB8B", "#81A1C1", "#B48EAD", "#8FBCBB", "#ECEFF4"]),
  "Tokyo Night": make("#1A1B26", "#C0CAF5", "#C0CAF5", "#33467C",
    ["#15161E", "#F7768E", "#9ECE6A", "#E0AF68", "#7AA2F7", "#BB9AF7", "#7DCFFF", "#A9B1D6"],
    ["#414868", "#F7768E", "#9ECE6A", "#E0AF68", "#7AA2F7", "#BB9AF7", "#7DCFFF", "#C0CAF5"]),
  "Gruvbox Dark": make("#282828", "#EBDBB2", "#EBDBB2", "#504945",
    ["#282828", "#CC241D", "#98971A", "#D79921", "#458588", "#B16286", "#689D6A", "#A89984"],
    ["#928374", "#FB4934", "#B8BB26", "#FABD2F", "#83A598", "#D3869B", "#8EC07C", "#EBDBB2"]),
  Monokai: make("#272822", "#F8F8F2", "#F8F8F0", "#49483E",
    ["#272822", "#F92672", "#A6E22E", "#F4BF75", "#66D9EF", "#AE81FF", "#A1EFE4", "#F8F8F2"],
    ["#75715E", "#F92672", "#A6E22E", "#F4BF75", "#66D9EF", "#AE81FF", "#A1EFE4", "#F9F8F5"]),
  "Solarized Dark": make("#002B36", "#839496", "#93A1A1", "#073642",
    ["#073642", "#DC322F", "#859900", "#B58900", "#268BD2", "#D33682", "#2AA198", "#EEE8D5"],
    ["#002B36", "#CB4B16", "#586E75", "#657B83", "#839496", "#6C71C4", "#93A1A1", "#FDF6E3"]),
  "Solarized Light": make("#FDF6E3", "#657B83", "#586E75", "#EEE8D5",
    ["#073642", "#DC322F", "#859900", "#B58900", "#268BD2", "#D33682", "#2AA198", "#EEE8D5"],
    ["#002B36", "#CB4B16", "#586E75", "#657B83", "#839496", "#6C71C4", "#93A1A1", "#FDF6E3"]),
  "GitHub Light": make("#FFFFFF", "#24292F", "#0969DA", "#B6E3FF",
    ["#24292F", "#CF222E", "#116329", "#4D2D00", "#0969DA", "#8250DF", "#1B7C83", "#6E7781"],
    ["#57606A", "#A40E26", "#1A7F37", "#633C01", "#218BFF", "#A475F9", "#3192AA", "#8C959F"]),
};

export function resolveTheme(name: string | null | undefined, custom: Record<string, ITheme>): ITheme {
  if (name && custom[name]) return custom[name];
  if (name && BUILTIN_THEMES[name]) return BUILTIN_THEMES[name];
  return BUILTIN_THEMES[DEFAULT_THEME];
}

const ITERM_KEYS: Record<string, keyof ITheme> = {
  "Background Color": "background",
  "Foreground Color": "foreground",
  "Cursor Color": "cursor",
  "Cursor Text Color": "cursorAccent",
  "Selection Color": "selectionBackground",
  "Ansi 0 Color": "black",
  "Ansi 1 Color": "red",
  "Ansi 2 Color": "green",
  "Ansi 3 Color": "yellow",
  "Ansi 4 Color": "blue",
  "Ansi 5 Color": "magenta",
  "Ansi 6 Color": "cyan",
  "Ansi 7 Color": "white",
  "Ansi 8 Color": "brightBlack",
  "Ansi 9 Color": "brightRed",
  "Ansi 10 Color": "brightGreen",
  "Ansi 11 Color": "brightYellow",
  "Ansi 12 Color": "brightBlue",
  "Ansi 13 Color": "brightMagenta",
  "Ansi 14 Color": "brightCyan",
  "Ansi 15 Color": "brightWhite",
};

/** Parse an iTerm2 `.itermcolors` file (XML plist with 0–1 float RGB components). */
export function parseItermColors(xml: string): ITheme {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Not a valid .itermcolors file");
  const root = doc.querySelector("plist > dict");
  if (!root) throw new Error("Not a valid .itermcolors file");
  const theme: ITheme = {};
  const kids = Array.from(root.children);
  for (let i = 0; i < kids.length - 1; i++) {
    if (kids[i].tagName !== "key") continue;
    const target = ITERM_KEYS[kids[i].textContent?.trim() ?? ""];
    const dict = kids[i + 1];
    if (!target || dict.tagName !== "dict") continue;
    const comp: Record<string, number> = {};
    const c = Array.from(dict.children);
    for (let j = 0; j < c.length - 1; j++) {
      if (c[j].tagName === "key") comp[c[j].textContent?.trim() ?? ""] = parseFloat(c[j + 1].textContent ?? "0");
    }
    const hex = (k: string) => Math.round(Math.min(1, Math.max(0, comp[k] ?? 0)) * 255).toString(16).padStart(2, "0");
    (theme as Record<string, string>)[target] = `#${hex("Red Component")}${hex("Green Component")}${hex("Blue Component")}`.toUpperCase();
  }
  if (!theme.background || !theme.foreground) throw new Error("The file has no background/foreground colors");
  return theme;
}

export const FONT_CHOICES = [
  '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  '"Cascadia Code", Consolas, monospace',
  '"Cascadia Mono", Consolas, monospace',
  'Consolas, "Courier New", monospace',
  '"Fira Code", Consolas, monospace',
  '"Source Code Pro", Consolas, monospace',
  'Menlo, Monaco, monospace',
  '"SF Mono", Menlo, monospace',
  '"Ubuntu Mono", monospace',
];

export const fontLabel = (f: string) => f.split(",")[0].replace(/"/g, "");
