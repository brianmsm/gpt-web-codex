export const HERDR_CANONICAL_SPECIAL_KEYS = [
  "enter", "tab", "esc", "backspace",
  "up", "down", "left", "right",
  "ctrl+c", "ctrl+d", "ctrl+z", "ctrl+l",
] as const;

export type HerdrCanonicalSpecialKey = typeof HERDR_CANONICAL_SPECIAL_KEYS[number];

export const HERDR_LEGACY_SPECIAL_KEY_ALIASES = {
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
} as const satisfies Record<string, HerdrCanonicalSpecialKey>;

export const HERDR_PUBLIC_SPECIAL_KEYS = [
  ...HERDR_CANONICAL_SPECIAL_KEYS,
  "Enter", "Tab", "Escape", "Backspace",
  "Up", "Down", "Left", "Right",
  "Ctrl-C", "Ctrl-D", "Ctrl-Z", "Ctrl-L",
] as const;

export type HerdrPublicSpecialKey = typeof HERDR_PUBLIC_SPECIAL_KEYS[number];

const HERDR_SPECIAL_KEY_WIRE_MAP = {
  enter: "enter",
  tab: "tab",
  esc: "esc",
  backspace: "backspace",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  "ctrl+c": "ctrl+c",
  "ctrl+d": "ctrl+d",
  "ctrl+z": "ctrl+z",
  "ctrl+l": "ctrl+l",
  ...HERDR_LEGACY_SPECIAL_KEY_ALIASES,
} as const satisfies Record<HerdrPublicSpecialKey, HerdrCanonicalSpecialKey>;

const herdrSpecialKeyWireMap: Readonly<Record<string, HerdrCanonicalSpecialKey>> = HERDR_SPECIAL_KEY_WIRE_MAP;

export function normalizeHerdrSpecialKey(key: string): HerdrCanonicalSpecialKey | undefined {
  return herdrSpecialKeyWireMap[key];
}
