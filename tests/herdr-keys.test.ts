import { expect, test } from "bun:test";
import {
  HERDR_CANONICAL_SPECIAL_KEYS,
  HERDR_LEGACY_SPECIAL_KEY_ALIASES,
  HERDR_PUBLIC_SPECIAL_KEYS,
  normalizeHerdrSpecialKey,
} from "../src/standalone/herdr-keys";

test("Herdr public special keys normalize explicitly to the 0.8.2 wire vocabulary", () => {
  for (const key of HERDR_PUBLIC_SPECIAL_KEYS) {
    const wireKey = normalizeHerdrSpecialKey(key);
    expect(wireKey).toBeDefined();
    expect(HERDR_CANONICAL_SPECIAL_KEYS).toContain(wireKey!);
  }

  expect(HERDR_LEGACY_SPECIAL_KEY_ALIASES).toEqual({
    Enter: "enter",
    Tab: "tab",
    Escape: "esc",
    Backspace: "backspace",
    Up: "up",
    Down: "down",
    Left: "left",
    Right: "right",
    "Ctrl-C": "ctrl+c",
    "Ctrl-D": "ctrl+d",
    "Ctrl-Z": "ctrl+z",
    "Ctrl-L": "ctrl+l",
  });
});

test("Herdr key normalization does not generically lowercase or advertise unsupported 0.8.2 keys", () => {
  expect(normalizeHerdrSpecialKey("CTRL+C")).toBeUndefined();
  expect(normalizeHerdrSpecialKey("delete")).toBeUndefined();
  expect(normalizeHerdrSpecialKey("Delete")).toBeUndefined();
  expect(normalizeHerdrSpecialKey("Home")).toBeUndefined();
  expect(normalizeHerdrSpecialKey("End")).toBeUndefined();
  expect(normalizeHerdrSpecialKey("PageUp")).toBeUndefined();
  expect(normalizeHerdrSpecialKey("PageDown")).toBeUndefined();
});
