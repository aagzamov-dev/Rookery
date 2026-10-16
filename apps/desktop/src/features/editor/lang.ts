// Which language a file is, by its name and folder (docs/08 §3). Pure: no CodeMirror imports here,
// so tests and the file tree can use it cheaply; the language packs load in `languages.ts`.

export type LangId =
  | "env"
  | "json"
  | "yaml"
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "php"
  | "python"
  | "html"
  | "css"
  | "scss"
  | "less"
  | "markdown"
  | "xml"
  | "sql"
  | "shell"
  | "nginx"
  | "dockerfile"
  | "ini"
  | "toml"
  | "properties"
  | "text";

export const LANG_LABEL: Record<LangId, string> = {
  env: ".env",
  json: "JSON",
  yaml: "YAML",
  javascript: "JavaScript",
  jsx: "JSX",
  typescript: "TypeScript",
  tsx: "TSX",
  php: "PHP",
  python: "Python",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  markdown: "Markdown",
  xml: "XML",
  sql: "SQL",
  shell: "Shell",
  nginx: "nginx",
  dockerfile: "Dockerfile",
  ini: "INI",
  toml: "TOML",
  properties: "Properties",
  text: "Plain text",
};

/** Prettier parser per language (formatting loads Prettier on first use). */
export const PRETTIER_PARSER: Partial<Record<LangId, string>> = {
  json: "json",
  yaml: "yaml",
  javascript: "babel",
  jsx: "babel",
  typescript: "typescript",
  tsx: "typescript",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  markdown: "markdown",
};

export const canFormat = (l: LangId) => l === "env" || l in PRETTIER_PARSER;

const BY_EXT: Record<string, LangId> = {
  json: "json",
  jsonc: "json",
  json5: "json",
  webmanifest: "json",
  yml: "yaml",
  yaml: "yaml",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  php: "php",
  phtml: "php",
  py: "python",
  pyw: "python",
  html: "html",
  htm: "html",
  vue: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  xml: "xml",
  svg: "xml",
  xsd: "xml",
  xsl: "xml",
  plist: "xml",
  csproj: "xml",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ksh: "shell",
  ini: "ini",
  cfg: "ini",
  cnf: "ini",
  service: "ini",
  timer: "ini",
  socket: "ini",
  mount: "ini",
  target: "ini",
  path: "ini",
  toml: "toml",
  properties: "properties",
  env: "env",
};

const BY_NAME: Record<string, LangId> = {
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".bash_aliases": "shell",
  ".bash_logout": "shell",
  ".profile": "shell",
  ".zshrc": "shell",
  ".zprofile": "shell",
  "nginx.conf": "nginx",
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  ".gitconfig": "ini",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  ".babelrc": "json",
  ".eslintrc": "json",
  ".prettierrc": "json",
  "composer.lock": "json",
  "cargo.lock": "toml",
  "pipfile": "toml",
  ".htaccess": "nginx", // close enough: directives + comments
  crontab: "shell",
};

export function baseName(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** `/a/b/c` → [["/", "/"], ["a", "/a"], ["b", "/a/b"], ["c", "/a/b/c"]] */
export function crumbs(path: string): [string, string][] {
  const out: [string, string][] = [["/", "/"]];
  let acc = "";
  for (const seg of path.split("/").filter(Boolean)) {
    acc += `/${seg}`;
    out.push([seg, acc]);
  }
  return out;
}

export function langOf(path: string): LangId {
  const name = baseName(path).toLowerCase();
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) return "env";
  if (name in BY_NAME) return BY_NAME[name];
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (ext === "conf") {
    // nginx folders: /etc/nginx/**, sites-available, conf.d of nginx
    return /\/(nginx|sites-available|sites-enabled)\//.test(path.toLowerCase()) ? "nginx" : "ini";
  }
  if (/\/(sites-available|sites-enabled)\//.test(path.toLowerCase())) return "nginx";
  if (ext && ext in BY_EXT) return BY_EXT[ext];
  return "text";
}
