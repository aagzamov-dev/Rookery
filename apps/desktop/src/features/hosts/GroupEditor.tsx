import { useState } from "react";
import clsx from "clsx";
import { asCoreError } from "../../ipc/api";
import type { Group } from "../../ipc/bindings/Group";
import { emptyGroup, useHosts } from "../../stores/hosts";
import { Button, Field, Modal, Select, TextInput } from "../../ui/primitives";
import { RefreshFields } from "./RefreshFields";

const COLORS = ["#FF7A7A", "#F2BA45", "#57C994", "#8AB4FF", "#C792EA", "#7FDBCA", "#A3ADC2"];

export function GroupEditor({ group, onClose }: { group: Group | null; onClose: () => void }) {
  const groups = useHosts((s) => s.groups);
  const identities = useHosts((s) => s.identities);
  const saveGroup = useHosts((s) => s.saveGroup);
  const deleteGroup = useHosts((s) => s.deleteGroup);
  const [g, setG] = useState<Group>(group ?? emptyGroup());
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!g.name.trim()) return setErr("Name is required.");
    try {
      await saveGroup({ ...g, name: g.name.trim() });
      onClose();
    } catch (e) {
      setErr(asCoreError(e).message);
    }
  };

  // A group cannot be its own ancestor.
  const isDescendant = (candidate: Group): boolean => {
    let p = candidate.parent_id;
    for (let i = 0; p && i < 32; i++) {
      if (p === g.id) return true;
      p = groups.find((x) => x.id === p)?.parent_id ?? null;
    }
    return false;
  };

  return (
    <Modal
      title={group ? `Edit group ${group.name}` : "New group"}
      onClose={onClose}
      width={460}
      footer={
        <>
          {group && (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={async () => {
                if (!confirm(`Delete group ${group.name}? Its hosts move to "No group".`)) return;
                await deleteGroup(group.id);
                onClose();
              }}
            >
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">
        <TextInput autoFocus value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} placeholder="Production" />
      </Field>
      <Field label="Color">
        <div className="flex gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              aria-label={`Color ${c}`}
              onClick={() => setG({ ...g, color: c })}
              className={clsx("h-7 w-7 rounded-md border-2", g.color === c ? "border-text" : "border-transparent")}
              style={{ background: c }}
            />
          ))}
        </div>
      </Field>
      <Field label="Parent group">
        <Select value={g.parent_id ?? ""} onChange={(e) => setG({ ...g, parent_id: e.target.value || null })}>
          <option value="">None (top level)</option>
          {groups
            .filter((x) => x.id !== g.id && !isDescendant(x))
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="Default login for hosts in this group" hint="Hosts set to “Inherit” use this identity.">
        <Select value={g.identity_id ?? ""} onChange={(e) => setG({ ...g, identity_id: e.target.value || null })}>
          <option value="">None</option>
          {identities.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} — {i.username}
            </option>
          ))}
        </Select>
      </Field>
      <RefreshFields value={g.refresh} onChange={(refresh) => setG({ ...g, refresh })} parentGroupId={g.parent_id} />
      {err && <div className="text-prod-fg">{err}</div>}
    </Modal>
  );
}
