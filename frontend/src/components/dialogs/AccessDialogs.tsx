/* The edit lock: unlocking this browser, and setting, changing or removing the passcode. */
import { useState } from "react";
import { PASSCODE_MIN, passcodeError } from "../../logic/access";
import { store } from "../../store";
import type { Access } from "../../types";
import { Dialog, TextField } from "../Dialog";

export function UnlockDialog({ onClose }: { onClose: () => void }) {
  const [passcode, setPasscode] = useState("");
  // A wrong passcode or too many attempts comes back as text, which keeps the dialog open and shows it.
  const submit = async (): Promise<string | void> => {
    if (!passcode) return "Enter the passcode.";
    return store.unlock(passcode);
  };
  return (
    <Dialog title="Unlock editing" submitLabel="Unlock" onClose={onClose} onSubmit={submit}>
      <TextField label="Passcode" type="password" autoComplete="off" value={passcode} onChange={setPasscode} hint="Until it is unlocked, this browser can look at the room but not change it." />
    </Dialog>
  );
}

/** The "Edit passcode" part of Customize. Its buttons act at once; they are not part of the dialog's Save. */
export function PasscodeSection({ access }: { access: Access }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);

  const run = async (cur: string, nxt: string, done: string): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const problem = await store.setPasscode(cur, nxt);
      if (problem) return setMsg({ ok: false, text: problem });
      setCurrent("");
      setNext("");
      setMsg({ ok: true, text: done });
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  const setOrChange = (): void => {
    const problem = passcodeError(next);
    if (problem) return setMsg({ ok: false, text: problem });
    if (access.passcodeSet && !current) return setMsg({ ok: false, text: "Enter the current passcode to change it." });
    void run(access.passcodeSet ? current : "", next, access.passcodeSet ? "The passcode was changed." : "The passcode is set. Other browsers and the screens are now view-only until they unlock.");
  };

  const remove = (): void => {
    if (!current) return setMsg({ ok: false, text: "Enter the current passcode to remove it." });
    if (!armed) return setArmed(true);
    void run(current, "", "The passcode was removed. Anyone who can open this page can edit again.");
  };

  return (
    <div className="dlg-section">
      <h4>Edit passcode</h4>
      {access.passcodeSet ? (
        <>
          <span className="hint">A passcode is set: screens and visitors can look but not change anything until they unlock.</span>
          <div className="two">
            <TextField label="Current passcode" type="password" autoComplete="off" value={current} onChange={setCurrent} />
            <TextField label="New passcode" type="password" autoComplete="new-password" value={next} onChange={setNext} hint={`At least ${PASSCODE_MIN} characters.`} />
          </div>
          <div className="btn-row">
            <button type="button" className="btn small" onClick={setOrChange} disabled={busy}>
              Change
            </button>
            <button type="button" className="btn small danger" data-armed={armed ? "1" : ""} onClick={remove} disabled={busy}>
              {armed ? "Click again to confirm" : "Remove passcode"}
            </button>
          </div>
        </>
      ) : (
        <>
          <span className="hint">Once a passcode is set, screens and visitors can look but not change anything. Editing then needs the passcode, once per browser.</span>
          <TextField label="New passcode" type="password" autoComplete="new-password" value={next} onChange={setNext} hint={`At least ${PASSCODE_MIN} characters.`} />
          <div className="btn-row">
            <button type="button" className="btn small" onClick={setOrChange} disabled={busy}>
              Set passcode
            </button>
          </div>
        </>
      )}
      {msg ? (
        <p className={`check-result st-${msg.ok ? "good" : "bad"}`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}
