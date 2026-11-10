/* Copying text. The page is often served over plain http on an internal host, where the browser's
   clipboard API does not exist, so the older copy command is tried first. */

function copyWithCommand(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  // Inside an open dialog only the dialog's content can take focus, so the helper goes there.
  const host = document.querySelector("dialog[open]") ?? document.body;
  host.appendChild(area);
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    active?.focus();
  }
}

/** Copies text. Resolves to false when the browser would not allow it (the caller then asks the user to copy by hand). */
export async function copyText(text: string): Promise<boolean> {
  if (copyWithCommand(text)) return true;
  if (!navigator.clipboard) return false;
  try {
    // The clipboard API can wait for ever on a permission question nobody sees, so it gets one second.
    return await Promise.race([navigator.clipboard.writeText(text).then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), 1000))]);
  } catch {
    return false;
  }
}
