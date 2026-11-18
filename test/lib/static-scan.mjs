// Static checks of the extension directory for T18 (privacy) and T19 (performance).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const EXPECTED_FILES = ["background.js", "common.js", "content.js", "manifest.json", "options.css", "options.html", "options.js"];

// Spec §8 T18 / plan Global Constraints.
export const FORBIDDEN = [
  ["console.", /\bconsole\s*\./],
  ["fetch", /\bfetch\b/],
  ["XMLHttpRequest", /XMLHttpRequest/],
  ["WebSocket", /WebSocket/],
  ["EventSource", /EventSource/],
  ["sendBeacon", /sendBeacon/],
  ["eval", /\beval\b/],
  ["Function(", /\bFunction\s*\(/],
  ["innerHTML", /innerHTML/],
  ["import(", /\bimport\s*\(/],
  ["storage.sync", /storage\s*\.\s*sync\b/],
];

export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

const REGEX_PREFIX_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);

/** Split JS source into { code, comments } (strings and regex literals stay in code). */
export function splitJs(src) {
  let code = "", comments = "", i = 0;
  const n = src.length;
  let prev = ""; // last significant code character
  let word = ""; // last identifier-like word
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      comments += src.slice(i, end) + "\n";
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      comments += src.slice(i, end) + "\n";
      code += " ";
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      code += src.slice(i, j + 1);
      i = j + 1;
      prev = c; word = "";
      continue;
    }
    if (c === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || REGEX_PREFIX_WORDS.has(word))) {
      let j = i + 1, inClass = false;
      while (j < n) {
        const ch = src[j];
        if (ch === "\\") { j += 2; continue; }
        if (ch === "\n") break;
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        j++;
      }
      code += src.slice(i, j + 1);
      i = j + 1;
      prev = "/"; word = "";
      continue;
    }
    code += c;
    if (/[A-Za-z0-9_$]/.test(c)) { word = (/[A-Za-z0-9_$]/.test(prev) ? word : "") + c; prev = c; }
    else if (!/\s/.test(c)) { prev = c; word = ""; }
    i++;
  }
  return { code, comments };
}

export function splitHtml(src) {
  const comments = [...src.matchAll(/<!--[\s\S]*?-->/g)].map((m) => m[0]).join("\n");
  return { code: src.replace(/<!--[\s\S]*?-->/g, " "), comments };
}

/** Lines of `text` that match re, as "file:line: text". */
export function matches(file, text, re) {
  const out = [];
  text.split("\n").forEach((line, i) => { if (re.test(line)) out.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`); });
  return out;
}
