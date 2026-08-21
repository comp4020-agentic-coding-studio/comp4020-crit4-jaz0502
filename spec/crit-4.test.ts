import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// This week's own contract (crit 4, "An instrument"), on top of the
// stack-agnostic invariants in spec/invariants.test.ts. See spec/README.md.
const DIST = resolve("dist");

function files(dir: string = DIST): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const shipped = files().map((path) => relative(DIST, path).split(sep).join("/"));
const scripts = shipped.filter((name) => name.endsWith(".js"));
const scriptSource = scripts.map((name) => readFileSync(join(DIST, name), "utf8")).join("\n");

const pages = shipped
  .filter((name) => name.endsWith(".html"))
  .map((name) => ({
    name,
    doc: new JSDOM(readFileSync(join(DIST, name), "utf8")).window.document,
  }));

describe("crit 4: an instrument", () => {
  it("makes sound live via the Web Audio API, not by playing a file", () => {
    expect(
      scriptSource,
      "no AudioContext found in the shipped JS — sound needs to be synthesised in the browser, not just referenced in markup",
    ).toMatch(/\bAudioContext\b/);
  });

  it("doesn't fall back to a pre-recorded audio/video track", () => {
    for (const { name, doc } of pages) {
      for (const el of doc.querySelectorAll("audio[src], video[src]")) {
        throw new Error(
          `${name} has a <${el.tagName.toLowerCase()} src="${el.getAttribute("src")}"> — ` +
            "that's playback, not an instrument the player shapes live",
        );
      }
    }
  });

  it("every playable control is keyboard-operable, not mouse-only", () => {
    // Native <button>s get keyboard focus and activation for free. A custom
    // clickable control (a div/span wired up with just a click handler) is
    // mouse- or touch-only unless it also carries a tabindex.
    for (const { name, doc } of pages) {
      for (const el of doc.querySelectorAll('[role="button"], [onclick]')) {
        if (el.tagName === "BUTTON") continue;
        expect(
          el.hasAttribute("tabindex"),
          `${name} has a clickable <${el.tagName.toLowerCase()}> with no tabindex — ` +
            "someone playing by keyboard can't reach it",
        ).toBe(true);
      }
    }
  });
});
