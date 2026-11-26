/**
 * Which key was pressed, whatever the keyboard layout. `event.key` is the CHARACTER — with a
 * Russian layout the key labelled T gives «е», so a hotkey written as "t" never fires for
 * most of this editor's users. `event.code` names the physical key; this maps it back to the
 * character printed on a Latin keyboard.
 */
const SYMBOL_CODES: Record<string, string> = {
  Slash: "/", BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Minus: "-", Equal: "=",
};

/**
 * The hotkey name of a keyboard event: a lowercase Latin letter or a digit for the letter and
 * digit keys (main row and numpad), the usual symbol for a few punctuation keys, and otherwise
 * `event.key` in lowercase ("escape", "delete", "backspace", "enter"…).
 */
export function hotkeyOf(e: { key: string; code?: string }): string {
  const code = e.code ?? "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (code in SYMBOL_CODES) return SYMBOL_CODES[code]!;
  return e.key.toLowerCase();
}
