import { describe, it, expect } from "vitest";
import { hotkeyOf } from "../src/services/hotkeys";

describe("hotkeyOf: the key pressed, whatever the layout", () => {
  it("reads a letter key by its place on the keyboard, not by the character typed", () => {
    expect(hotkeyOf({ key: "t", code: "KeyT" })).toBe("t");
    expect(hotkeyOf({ key: "е", code: "KeyT" })).toBe("t"); // Russian layout
    expect(hotkeyOf({ key: "Я", code: "KeyZ" })).toBe("z"); // Ctrl+Z with a Russian layout
    expect(hotkeyOf({ key: "ź", code: "KeyX" })).toBe("x"); // Polish AltGr
  });
  it("reads digits from the main row and the numpad", () => {
    expect(hotkeyOf({ key: "3", code: "Digit3" })).toBe("3");
    expect(hotkeyOf({ key: "№", code: "Digit3" })).toBe("3"); // Shift+3 in a Russian layout
    expect(hotkeyOf({ key: "7", code: "Numpad7" })).toBe("7");
  });
  it("maps the punctuation keys the editor uses", () => {
    expect(hotkeyOf({ key: ".", code: "Slash" })).toBe("/"); // the «/» key types «.» in Russian
    expect(hotkeyOf({ key: "х", code: "BracketLeft" })).toBe("[");
    expect(hotkeyOf({ key: "ъ", code: "BracketRight" })).toBe("]");
    expect(hotkeyOf({ key: "б", code: "Comma" })).toBe(",");
    expect(hotkeyOf({ key: "ю", code: "Period" })).toBe(".");
  });
  it("falls back to the key name for everything else", () => {
    expect(hotkeyOf({ key: "Escape", code: "Escape" })).toBe("escape");
    expect(hotkeyOf({ key: "Delete", code: "Delete" })).toBe("delete");
    expect(hotkeyOf({ key: "a" })).toBe("a"); // an event without a code
  });
});
