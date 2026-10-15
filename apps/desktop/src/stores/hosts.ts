import { create } from "zustand";
import { api, type IdentitySecrets } from "../ipc/api";
import type { Group } from "../ipc/bindings/Group";
import type { Host } from "../ipc/bindings/Host";
import type { Identity } from "../ipc/bindings/Identity";

interface HostsState {
  hosts: Host[];
  groups: Group[];
  identities: Identity[];
  loaded: boolean;
  load: () => Promise<void>;
  saveHost: (h: Host) => Promise<Host>;
  deleteHost: (id: string) => Promise<void>;
  saveGroup: (g: Group) => Promise<Group>;
  deleteGroup: (id: string) => Promise<void>;
  saveIdentity: (i: Identity, secrets?: IdentitySecrets) => Promise<Identity>;
  hostById: (id: string) => Host | undefined;
}

export const useHosts = create<HostsState>((set, get) => ({
  hosts: [],
  groups: [],
  identities: [],
  loaded: false,
  load: async () => {
    const [hosts, groups, identities] = await Promise.all([api.hostsList(), api.groupsList(), api.identitiesList()]);
    set({ hosts, groups, identities, loaded: true });
  },
  saveHost: async (h) => {
    const saved = await api.hostSave(h);
    set({ hosts: upsert(get().hosts, saved) });
    return saved;
  },
  deleteHost: async (id) => {
    await api.hostDelete(id);
    set({ hosts: get().hosts.filter((h) => h.id !== id) });
  },
  saveGroup: async (g) => {
    const saved = await api.groupSave(g);
    set({ groups: upsert(get().groups, saved) });
    return saved;
  },
  deleteGroup: async (id) => {
    await api.groupDelete(id);
    await get().load();
  },
  saveIdentity: async (i, secrets) => {
    const saved = await api.identitySave(i, secrets);
    set({ identities: await api.identitiesList() });
    return saved;
  },
  hostById: (id) => get().hosts.find((h) => h.id === id),
}));

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function emptyHost(groupId: string | null = null): Host {
  return {
    id: "",
    group_id: groupId,
    name: "",
    address: "",
    port: 22,
    env_label: "none",
    tags: [],
    identity_id: null,
    jump_host_id: null,
    theme: null,
    start_view: "terminal",
    start_folder: null,
    auto_reconnect: true,
    keepalive_s: 30,
    log_session: false,
    refresh: { mode: "inherit", interval_s: null, collect: null, desktop: null, mobile: null, wifi_only: null },
    sort: 0,
    created_at: 0,
    updated_at: 0,
  };
}

export function emptyGroup(): Group {
  return {
    id: "",
    parent_id: null,
    name: "",
    color: "#8AB4FF",
    sort: 0,
    identity_id: null,
    jump_host_id: null,
    theme: null,
    start_folder: null,
    refresh: { mode: "inherit", interval_s: null, collect: null, desktop: null, mobile: null, wifi_only: null },
    auto_sync_enabled: false,
  };
}

export function emptyIdentity(): Identity {
  return {
    id: "",
    name: "",
    username: "",
    auth: "password",
    key_path: null,
    has_password: false,
    has_key: false,
    has_passphrase: false,
    has_sudo: false,
  };
}
