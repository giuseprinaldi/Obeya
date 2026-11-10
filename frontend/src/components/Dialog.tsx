/* The modal shell every editor uses, and labelled form fields. */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { store } from "../store";

interface DialogProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  /** Return a message to keep the dialog open and show it; return nothing to close. Omit for a dialog with no Save. */
  onSubmit?: () => string | void | Promise<string | void>;
  submitLabel?: string;
  /** A delete button that needs a second click to confirm. */
  danger?: { label: string; onConfirm: () => void };
  wide?: boolean;
}

export function Dialog({ title, children, onClose, onSubmit, submitLabel = "Save", danger, wide }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [error, setError] = useState("");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    store.dialogOpened();
    if (!d.open) d.showModal();
    d.querySelector<HTMLElement>(".dlg-body input:not([type=checkbox]):not([type=radio]), .dlg-body textarea, .dlg-body select")?.focus();
    // No d.close() here: the element is leaving the page anyway, and closing would fire onClose again.
    return () => store.dialogClosed();
  }, []);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!onSubmit || busy) return;
    setBusy(true);
    try {
      const problem = await onSubmit();
      if (typeof problem === "string" && problem) setError(problem);
      else onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className={wide ? "wide" : undefined}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        // Escape: close through the app straight away instead of waiting for the browser's close event.
        e.preventDefault();
        onClose();
      }}
    >
      <form onSubmit={(e) => void submit(e)} noValidate>
        <header className="dlg-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="dlg-body">{children}</div>
        <p className="dlg-error" role="alert">
          {error}
        </p>
        <footer className="dlg-foot">
          {danger ? (
            <button
              type="button"
              className="btn danger"
              data-armed={armed ? "1" : ""}
              onClick={() => {
                if (!armed) return setArmed(true);
                danger.onConfirm();
                onClose();
              }}
            >
              {armed ? "Click again to confirm" : danger.label}
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            {onSubmit ? "Cancel" : "Close"}
          </button>
          {onSubmit ? (
            <button type="submit" className="btn primary" disabled={busy}>
              {submitLabel}
            </button>
          ) : null}
        </footer>
      </form>
    </dialog>
  );
}

/* ---------- Fields ---------- */

interface TextProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "number" | "date" | "search" | "password";
  /** Passed to the input, e.g. "off" or "new-password". */
  autoComplete?: string;
  placeholder?: string;
  hint?: string;
  min?: number;
  max?: number;
  step?: number | "any";
  list?: string;
}

export function TextField({ label, value, onChange, type = "text", autoComplete, placeholder, hint, min, max, step, list }: TextProps) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        min={min}
        max={max}
        step={type === "number" ? (step ?? "any") : undefined}
        list={list}
        autoComplete={autoComplete}
        inputMode={type === "number" ? "decimal" : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function TextArea({ label, value, onChange, rows = 3, hint, code, placeholder }: { label: string; value: string; onChange: (v: string) => void; rows?: number; hint?: string; code?: boolean; placeholder?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} className={code ? "code" : undefined} rows={rows} value={value} placeholder={placeholder} spellCheck={code ? false : undefined} onChange={(e) => onChange(e.target.value)} />
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function SelectField<T extends string>({ label, value, onChange, options, hint }: { label: string; value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[]; hint?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function CheckField({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label className="check" htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
      </label>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** A row of radio buttons styled as a segmented choice. */
export function Segmented<T extends string>({ legend, value, onChange, options }: { legend: string; value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[] }) {
  const name = useId();
  return (
    <fieldset className="field" style={{ border: 0, margin: 0, padding: 0 }}>
      <legend className="legend" style={{ padding: 0, marginBottom: 5 }}>
        {legend}
      </legend>
      <div className="seg">
        {options.map(([k, l]) => (
          <label key={k}>
            <input type="radio" name={name} value={k} checked={value === k} onChange={() => onChange(k)} />
            {l}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
