import { useEffect, useRef, useState } from "react";
import { useDialogs, type ChoiceRequest, type ConfirmRequest, type TextRequest, type VarsRequest } from "../stores/dialogs";
import { fillCommand } from "../features/snippets/vars";
import { Button, Field, Modal, TextInput } from "./primitives";

export function DialogHost() {
  const current = useDialogs((s) => s.current);
  if (!current) return null;
  if (current.kind === "confirm") return <Confirm key={current.id} req={current} />;
  if (current.kind === "text") return <TextAsk key={current.id} req={current} />;
  if (current.kind === "choice") return <Choice key={current.id} req={current} />;
  return <Vars key={current.id} req={current} />;
}

function TextAsk({ req }: { req: TextRequest }) {
  const done = useDialogs((s) => s.done);
  const [value, setValue] = useState(req.value);
  const finish = (ok: boolean) => {
    req.resolve(ok && value.trim() ? value.trim() : null);
    done();
  };
  return (
    <Modal
      title={req.title}
      onClose={() => finish(false)}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => finish(true)} disabled={!value.trim()}>
            {req.confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        <Field label={req.label}>
          <TextInput
            mono={!req.secret}
            type={req.secret ? "password" : "text"}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.currentTarget.setSelectionRange(0, req.selectUntil ?? e.currentTarget.value.length)}
          />
        </Field>
      </form>
    </Modal>
  );
}

function Confirm({ req }: { req: ConfirmRequest }) {
  const done = useDialogs((s) => s.done);
  const okRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const locked = req.typeToConfirm != null && typed !== req.typeToConfirm;
  const finish = (ok: boolean) => {
    req.resolve(ok && !locked);
    done();
  };
  useEffect(() => {
    if (req.typeToConfirm == null) okRef.current?.focus();
  }, [req.typeToConfirm]);
  return (
    <Modal
      title={req.title}
      onClose={() => finish(false)}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button ref={okRef} variant={req.danger ? "danger" : "primary"} disabled={locked} onClick={() => finish(true)}>
            {req.confirmLabel}
          </Button>
        </>
      }
    >
      {req.body && <p className="m-0 leading-relaxed text-muted">{req.body}</p>}
      {req.preview && (
        <pre className="m-0 max-h-64 overflow-auto rounded-lg border border-line bg-term p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[#D3D9E4]">
          {req.preview}
        </pre>
      )}
      {req.typeToConfirm != null && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!locked) finish(true);
          }}
        >
          <Field label={`Type ${req.typeToConfirm} to confirm`}>
            <TextInput mono autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Confirmation text" />
          </Field>
        </form>
      )}
    </Modal>
  );
}

function Choice({ req }: { req: ChoiceRequest }) {
  const done = useDialogs((s) => s.done);
  const finish = (id: string | null) => {
    req.resolve(id);
    done();
  };
  return (
    <Modal
      title={req.title}
      onClose={() => finish(null)}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(null)}>
            Cancel
          </Button>
          {req.choices.map((c, i) => (
            <Button key={c.id} autoFocus={i === 0} variant={c.variant ?? "outline"} onClick={() => finish(c.id)}>
              {c.label}
            </Button>
          ))}
        </>
      }
    >
      {req.body && <p className="m-0 leading-relaxed whitespace-pre-line text-muted">{req.body}</p>}
    </Modal>
  );
}

function Vars({ req }: { req: VarsRequest }) {
  const done = useDialogs((s) => s.done);
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(req.vars.map((v) => [v.name, v.value])));
  const finish = (ok: boolean) => {
    req.resolve(ok ? values : null);
    done();
  };
  return (
    <Modal
      title={req.title}
      onClose={() => finish(false)}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => finish(true)}>
            Run
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        {req.vars.map((v, i) => (
          <Field key={v.name} label={v.name}>
            <TextInput
              mono
              autoFocus={i === 0}
              value={values[v.name] ?? ""}
              onChange={(e) => setValues((x) => ({ ...x, [v.name]: e.target.value }))}
              onFocus={(e) => e.currentTarget.select()}
            />
          </Field>
        ))}
        <button type="submit" hidden />
      </form>
      <pre className="m-0 overflow-auto rounded-lg border border-line bg-term p-3 font-mono text-xs whitespace-pre-wrap text-[#D3D9E4]">
        {fillCommand(req.command, values)}
      </pre>
    </Modal>
  );
}
