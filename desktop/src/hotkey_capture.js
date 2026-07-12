"use strict";

function keyFromEvent(event) {
  const key = String(event?.key || "");
  const code = String(event?.code || "");

  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;

  const namedKeys = {
    Space: "Space",
    Tab: "Tab",
    Enter: "Enter",
    Escape: "Esc",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
  };
  return namedKeys[code] || (key.length === 1 ? key.toUpperCase() : "");
}

function acceleratorFromEvent(event, platform = "") {
  const parts = [];
  if (platform === "darwin") {
    if (event.metaKey) parts.push("Command");
    if (event.ctrlKey) parts.push("Control");
  } else {
    if (event.ctrlKey) parts.push("Control");
    if (event.metaKey) parts.push("Super");
  }
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  const key = keyFromEvent(event);
  if (!key) return "";
  parts.push(key);
  return parts.join("+");
}

const hotkeyCapture = Object.freeze({ acceleratorFromEvent, keyFromEvent });
if (typeof module !== "undefined" && module.exports) module.exports = hotkeyCapture;
if (typeof window !== "undefined") window.DurianflowHotkeyCapture = hotkeyCapture;
