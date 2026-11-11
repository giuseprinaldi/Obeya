/* Wall settings, add wall, and the room-wide Customize dialog. */
import { useId, useState } from "react";
import { copyText } from "../../clipboard";
import { normalizeRoom } from "../../logic/normalize";
import { ACCENTS, LIBRARY, TEMPLATES, buildWall, seed } from "../../logic/seed";
import { uid } from "../../logic/util";
import { store, useStore } from "../../store";
import type { AccentKey, Room, Theme, Wall } from "../../types";
import { go, useUi } from "../../ui";
import { Dialog, SelectField, TextArea, TextField } from "../Dialog";
import { PasscodeSection } from "./AccessDialogs";

export function WallSettingsDialog({ room, wall, onClose }: { room: Room; wall: Wall; onClose: () => void }) {
  const index = room.walls.findIndex((w) => w.id === wall.id);
  const [name, setName] = useState(wall.name);
  const [subtitle, setSubtitle] = useState(wall.subtitle);
  const [pos, setPos] = useState(String(index));

  const save = (): string | void => {
    const n = name.trim();
    if (!n) return "Give the wall a name.";
    store.commit((r) => {
      const from = r.walls.findIndex((w) => w.id === wall.id);
      const w = r.walls[from];
      if (!w) return;
      w.name = n;
      w.subtitle = subtitle.trim();
      r.walls.splice(from, 1);
      r.walls.splice(Number(pos) || 0, 0, w);
    });
  };

  const removeWall = (): void => {
    store.commit((r) => {
      r.walls = r.walls.filter((w) => w.id !== wall.id);
    });
    go("#overview");
  };

  return (
    <Dialog title="Wall settings" onClose={onClose} onSubmit={save} danger={{ label: "Delete wall", onConfirm: removeWall }}>
      <TextField label="Wall name" value={name} onChange={setName} />
      <TextField label="Subtitle" value={subtitle} onChange={setSubtitle} placeholder="The question this wall answers" />
      <SelectField
        label="Screen"
        value={pos}
        onChange={setPos}
        options={room.walls.map((_, n) => [String(n), `Screen ${n + 1}`] as const)}
        hint="Screens are numbered left to right around the room. TVs follow the screen number, so moving a wall to another screen changes which TV shows it."
      />
    </Dialog>
  );
}

export function AddWallDialog({ onClose }: { onClose: () => void }) {
  const [from, setFrom] = useState("");
  const [name, setName] = useState("");
  const options = [["", "Blank wall"] as const, ...Object.entries(LIBRARY).map(([k, L]) => [k, `${L.name} (example panels)`] as const)];

  const save = (): string | void => {
    const n = name.trim();
    if (!from && !n) return "Name the blank wall.";
    const wall: Wall = from ? buildWall(from) : { id: "w" + uid(), name: n, subtitle: "", panels: [] };
    if (n) wall.name = n;
    store.commit((r) => {
      r.walls.push(wall);
    });
    go(`#wall-${wall.id}`);
  };

  return (
    <Dialog title="Add wall" submitLabel="Add wall" onClose={onClose} onSubmit={save}>
      <SelectField label="Start from" value={from} onChange={setFrom} options={options} />
      <TextField label="Wall name" value={name} onChange={setName} placeholder="Uses the template name if left blank" />
    </Dialog>
  );
}

const THEMES: readonly (readonly [Theme, string])[] = [
  ["auto", "Match device"],
  ["light", "Light"],
  ["dark", "Dark"],
];
const DENSITIES: readonly (readonly [Room["density"], string])[] = [
  ["comfortable", "Comfortable"],
  ["compact", "Compact"],
];

export function CustomizeDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const [roomName, setRoomName] = useState(room.roomName);
  const [accent, setAccent] = useState<AccentKey>(room.accent);
  const [theme, setTheme] = useState<Theme>(room.theme);
  const [tvTheme, setTvTheme] = useState<Theme>(room.tvTheme);
  const [density, setDensity] = useState<Room["density"]>(room.density);
  const [rotate, setRotate] = useState(String(Number(room.rotate) || 0));
  const [armed, setArmed] = useState<string | null>(null);
  const [json, setJson] = useState("");
  const [msg, setMsg] = useState("");
  const accentName = useId();
  const { access } = useStore();
  const ui = useUi();

  const save = (): void => {
    store.commit(
      (r) => {
        r.roomName = roomName.trim() || "Obeya Room";
        r.accent = accent;
        r.theme = theme;
        r.tvTheme = tvTheme;
        r.density = density;
        r.rotate = Math.max(0, parseInt(rotate, 10) || 0);
      },
      { keepExample: true },
    );
  };

  const loadTemplate = (key: string): void => {
    if (armed !== key) return setArmed(key);
    const { roomName: n, theme: t, tvTheme: tv, accent: a, density: d, rotate: ro } = room;
    store.replaceRoom({ ...seed(key), roomName: n, theme: t, tvTheme: tv, accent: a, density: d, rotate: ro });
    onClose();
    go("#overview");
  };

  const current = (): string => JSON.stringify(store.getState().room, null, 1);

  const copy = async (): Promise<void> => {
    const textToCopy = json || current();
    if (!json) setJson(textToCopy);
    setMsg((await copyText(textToCopy)) ? "Copied." : "Copy was blocked. Select the text and press Ctrl+C.");
  };

  const importJson = (): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return setMsg("That is not valid room data. Paste the full JSON from a backup.");
    }
    const next = normalizeRoom(parsed);
    if (!next) return setMsg("That is not valid room data. Paste the full JSON from a backup.");
    store.replaceRoom(next);
    onClose();
    go("#overview");
  };

  return (
    <Dialog title="Customize room" onClose={onClose} onSubmit={save}>
      <TextField label="Room name" value={roomName} onChange={setRoomName} />
      <fieldset className="field" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="legend" style={{ padding: 0, marginBottom: 5 }}>
          Accent color
        </legend>
        <div className="swatches">
          {(Object.entries(ACCENTS) as [AccentKey, (typeof ACCENTS)[AccentKey]][]).map(([k, a]) => (
            <label className="swatch" title={a.name} key={k}>
              <input type="radio" name={accentName} value={k} checked={accent === k} onChange={() => setAccent(k)} aria-label={a.name} />
              <span style={{ background: a.l }} />
            </label>
          ))}
        </div>
      </fieldset>
      <div className="two">
        <SelectField label="Theme on laptops" value={theme} onChange={setTheme} options={THEMES} />
        <SelectField label="Theme on TVs" value={tvTheme} onChange={setTvTheme} options={THEMES} hint="Dark is easier on a room full of screens." />
      </div>
      <div className="two">
        <SelectField label="Density" value={density} onChange={setDensity} options={DENSITIES} />
        <TextField
          label="Rotate displays every (seconds)"
          type="number"
          min={0}
          step={5}
          value={rotate}
          onChange={setRotate}
          hint="0 keeps each TV on one wall. Use rotation when you have fewer TVs than walls."
        />
      </div>
      <div className="dlg-section">
        <h4>Room templates</h4>
        <span className="hint">Loading a template replaces every wall.</span>
        <div className="btn-row">
          {Object.entries(TEMPLATES).map(([k, t]) => (
            <button type="button" key={k} className={`btn small${armed === k ? " danger" : ""}`} data-armed={armed === k ? "1" : ""} title={t.desc} onClick={() => loadTemplate(k)}>
              {armed === k ? "Replace all walls? Click again" : t.name}
            </button>
          ))}
        </div>
      </div>
      <div className="dlg-section">
        <h4>Backup</h4>
        <TextArea label="Room data (JSON)" value={json} onChange={setJson} rows={4} code placeholder="Show the current data, or paste a backup here to import it." />
        <div className="btn-row">
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setJson(current());
              setMsg("");
            }}
          >
            Show current data
          </button>
          <button type="button" className="btn small" onClick={() => void copy()}>
            Copy
          </button>
          <button type="button" className="btn small" onClick={importJson}>
            Import pasted data
          </button>
          <span className="hint" role="status">
            {msg}
          </span>
        </div>
        <span className="hint">Backups from the earlier single-file prototype can be imported too.</span>
      </div>
      <div className="dlg-section">
        <h4>Earlier versions</h4>
        <div className="btn-row">
          <button type="button" className="btn small" onClick={() => ui.open({ kind: "history" })}>
            Earlier versions
          </button>
          <span className="hint">See what each of the last 100 saves changed, and go back to any of them. Changes typed above and not yet saved are dropped.</span>
        </div>
      </div>
      <PasscodeSection access={access} />
    </Dialog>
  );
}
