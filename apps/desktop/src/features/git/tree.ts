import type { GitFile } from "../../ipc/bindings/GitFile";

export type ChangeView = "tree" | "list";
export type ChangeNode = { kind: "file"; name: string; path: string; file: GitFile } | { kind: "folder"; name: string; path: string; children: ChangeNode[] };
interface Directory { name: string; path: string; folders: Map<string, Directory>; files: GitFile[] }

export const changeView = (saved: string | null): ChangeView => saved === "list" ? "list" : "tree";

export function buildChangeTree(files: readonly GitFile[]): ChangeNode[] {
  const root: Directory = { name: "", path: "", folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let directory = root;
    for (const name of parts.slice(0, -1)) {
      const path = directory.path ? `${directory.path}/${name}` : name;
      let child = directory.folders.get(name);
      if (!child) {
        child = { name, path, folders: new Map(), files: [] };
        directory.folders.set(name, child);
      }
      directory = child;
    }
    directory.files.push(file);
  }
  const nodes = (directory: Directory): ChangeNode[] => [
    ...[...directory.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((folder): ChangeNode => ({ kind: "folder", name: folder.name, path: folder.path, children: nodes(folder) })),
    ...directory.files.slice().sort((a, b) => a.path.localeCompare(b.path)).map((file): ChangeNode => ({ kind: "file", name: file.path.slice(file.path.lastIndexOf("/") + 1), path: file.path, file })),
  ];
  return nodes(root);
}
