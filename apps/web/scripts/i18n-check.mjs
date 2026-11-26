#!/usr/bin/env node
/**
 * Interface-language check (see src/i18n/index.ts).
 *
 *   node scripts/i18n-check.mjs                 every message of the app has an English and a Polish text
 *   node scripts/i18n-check.mjs --leftovers     …and list Russian literals that are not wrapped in tr()
 *   node scripts/i18n-check.mjs --part <file.json> --files <a> <b> … [--catalogues <c> …]
 *                                               the same for some files against a part {"ru": ["en", "pl"]}
 *
 * A message is the first argument of tr("…") / trc("…") / trn("…", n): a plain string literal.
 * trx("context", "source") is the message "source ## context" (a word with two meanings).
 * A CATALOGUE is a file outside the app whose Russian literals are shown through tr(x.label):
 * every one of them is a message too.
 *
 * Exit code 1 when a message has no translation or a translation is malformed.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(HERE, "..");
export const REPO_ROOT = path.resolve(WEB_ROOT, "..", "..");

/** Files outside the app whose Russian string literals reach the screen through tr(). */
export const CATALOGUES = [
  "packages/map-schema/src/events.ts",
  "packages/mapgen/src/recipes.ts",
  "tools/asset-pipeline/data/scen_variables.json",
  "packages/map-edit/src/generate.ts",
];

const CYRILLIC = /[Ѐ-ӿ]/;
const CALL = /(?<![\w$.])(tr|trc|trn)\(\s*(["'`])((?:\\[\s\S]|(?!\2)[^\\])*)\2/g;
const CONTEXT_CALL = /(?<![\w$.])trx\(\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*,\s*(["'`])((?:\\[\s\S]|(?!\3)[^\\])*)\3/g;
const DYNAMIC_CALL =/(?<![\w$.])(tr|trc|trn)\(\s*(?!["'`\s)])/g;
const LITERAL = /(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;

function unescapeLiteral(body) {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (whole, e) => {
    if (e[0] === "u" && e[1] === "{") return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    if (e[0] === "u" && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === "n") return "\n";
    if (e === "t") return "\t";
    if (e === "r") return "\r";
    if (e === "\n") return "";
    return e;
  });
}

/**
 * Blank out comments, keeping every line break and offset. One pass that knows it is inside
 * a string, so a comment opener within a literal (an XML attribute `U*` + `/**`) is not taken for one.
 * A heuristic all the same — no real parser: a quote in a regex literal or in template text
 * can open a "string"; to bound the damage a '…' or "…" string ends at the line break.
 */
function stripComments(text) {
  const out = text.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote || (ch === "\n" && quote !== "`")) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const stop = close < 0 ? text.length : close + 2;
      blank(i, stop);
      i = stop - 1;
    } else if (ch === "/" && text[i + 1] === "/" && text[i - 1] !== ":") {
      const eol = text.indexOf("\n", i);
      const stop = eol < 0 ? text.length : eol;
      blank(i, stop);
      i = stop - 1;
    } else if (ch === "<" && text.startsWith("<!--", i)) {
      const close = text.indexOf("-->", i + 4);
      const stop = close < 0 ? text.length : close + 3;
      blank(i, stop);
      i = stop - 1;
    }
  }
  return out.join("");
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The messages of one source file, the calls that cannot be checked, and unwrapped Russian. */
export function scanSource(file, text) {
  const messages = [];
  const bad = [];
  const leftovers = [];
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
  for (const m of text.matchAll(CALL)) {
    const where = `${rel}:${lineOf(text, m.index)}`;
    if (m[2] === "`" && m[3].includes("${")) {
      bad.push(`${where}: ${m[1]}() takes a plain string with {placeholders}, not a template with \${…}`);
      continue;
    }
    messages.push({ key: unescapeLiteral(m[3]), plural: m[1] === "trn", where });
  }
  // trx("context", "source") — a homonym, keyed "source ## context"
  for (const m of text.matchAll(CONTEXT_CALL)) {
    const key = `${unescapeLiteral(m[4])} ## ${unescapeLiteral(m[2])}`;
    messages.push({ key, plural: false, where: `${rel}:${lineOf(text, m.index)}` });
  }
  let dynamic = 0;
  for (const _ of text.matchAll(DYNAMIC_CALL)) dynamic++;
  // what is left in Russian once comments and wrapped messages are taken out
  const blankRussian = (whole) => whole.replace(/[Ѐ-ӿ]/g, "_");
  const bare = stripComments(text.replace(CALL, blankRussian).replace(CONTEXT_CALL, blankRussian));
  bare.split("\n").forEach((line, i) => {
    if (CYRILLIC.test(line)) leftovers.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
  });
  return { messages, bad, leftovers, dynamic };
}

/** Every Russian string literal of a catalogue file. */
export function scanCatalogue(file, text) {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
  const messages = [];
  const bare = stripComments(text);
  for (const m of bare.matchAll(LITERAL)) {
    if (!CYRILLIC.test(m[2])) continue;
    if (m[1] === "`" && m[2].includes("${")) continue; // built at run time: not a fixed message
    messages.push({ key: unescapeLiteral(m[2]), plural: false, where: `${rel}:${lineOf(bare, m.index)}` });
  }
  return messages;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "i18n") yield* walk(p); // the i18n module itself only quotes examples
    } else if (/\.(ts|vue)$/.test(name) && !name.endsWith(".d.ts")) yield p;
  }
}

function placeholders(text) {
  return new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
}

/** What is wrong with one translation of `key` (an empty list = nothing). */
export function translationProblems(key, value, lang, plural) {
  const problems = [];
  if (typeof value !== "string" || value.trim() === "") return [`${lang}: empty`];
  const allowed = placeholders(key);
  if (plural) allowed.add("n");
  for (const name of placeholders(value)) if (!allowed.has(name)) problems.push(`${lang}: unknown placeholder {${name}}`);
  if (plural) {
    const forms = value.split("|").length;
    const want = lang === "en" ? [1, 2] : [1, 3];
    if (!want.includes(forms)) problems.push(`${lang}: ${forms} plural forms, expected ${want.join(" or ")}`);
  } else {
    for (const name of allowed) if (!placeholders(value).has(name)) problems.push(`${lang}: placeholder {${name}} is missing`);
  }
  return problems;
}

/**
 * Collect the messages of `files` + `catalogues` and compare them with `dictionaries`
 * ({ en: {ru: text}, pl: {ru: text} }).
 */
export function analyse({ files, catalogues, dictionaries }) {
  const byKey = new Map();
  const bad = [];
  const leftovers = [];
  let dynamic = 0;
  const add = (m) => {
    const seen = byKey.get(m.key);
    if (seen) seen.plural ||= m.plural;
    else byKey.set(m.key, { plural: m.plural, where: m.where });
  };
  for (const file of files) {
    const scan = scanSource(file, readFileSync(file, "utf8"));
    scan.messages.forEach(add);
    bad.push(...scan.bad);
    leftovers.push(...scan.leftovers);
    dynamic += scan.dynamic;
  }
  for (const file of catalogues) scanCatalogue(file, readFileSync(file, "utf8")).forEach(add);

  const missing = [];
  const malformed = [];
  for (const [key, info] of byKey) {
    for (const lang of Object.keys(dictionaries)) {
      const value = dictionaries[lang][key];
      if (value === undefined) missing.push(`${lang}: ${JSON.stringify(key)}  (${info.where})`);
      else for (const p of translationProblems(key, value, lang, info.plural)) malformed.push(`${JSON.stringify(key)} — ${p}`);
    }
  }
  const unused = [];
  for (const lang of Object.keys(dictionaries))
    for (const key of Object.keys(dictionaries[lang])) if (!byKey.has(key)) unused.push(`${lang}: ${JSON.stringify(key)}`);
  return { messages: byKey.size, missing, malformed, unused, bad, leftovers, dynamic };
}

export function appFiles() {
  return [...walk(path.join(WEB_ROOT, "src"))];
}

export function loadDictionaries() {
  const read = (lang) => JSON.parse(readFileSync(path.join(WEB_ROOT, "src", "i18n", "locales", `${lang}.json`), "utf8"));
  return { en: read("en"), pl: read("pl") };
}

/** The whole app against its dictionaries. */
export function checkApp() {
  return analyse({
    files: appFiles(),
    catalogues: CATALOGUES.map((c) => path.join(REPO_ROOT, c)).filter(existsSync),
    dictionaries: loadDictionaries(),
  });
}

function main(argv) {
  const args = argv.slice(2);
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const out = [];
    for (let k = i + 1; k < args.length && !args[k].startsWith("--"); k++) out.push(args[k]);
    return out;
  };
  const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));
  const partArg = take("--part");
  let result;
  if (partArg) {
    const part = JSON.parse(readFileSync(resolve(partArg[0]), "utf8"));
    const dictionaries = { en: {}, pl: {} };
    for (const [key, value] of Object.entries(part)) {
      if (!Array.isArray(value) || value.length !== 2) {
        console.log(`MALFORMED ${JSON.stringify(key)}: a part entry is ["English", "Polski"]`);
        process.exitCode = 1;
        continue;
      }
      dictionaries.en[key] = value[0];
      dictionaries.pl[key] = value[1];
    }
    result = analyse({
      files: (take("--files") ?? []).map(resolve),
      catalogues: (take("--catalogues") ?? []).map(resolve),
      dictionaries,
    });
  } else {
    result = checkApp();
  }
  const section = (title, list) => {
    if (!list.length) return;
    console.log(`\n${title} (${list.length})`);
    for (const line of list) console.log("  " + line);
  };
  section("BAD CALLS", result.bad);
  section("NO TRANSLATION", result.missing);
  section("MALFORMED TRANSLATION", result.malformed);
  section("NOT USED BY THE CODE", result.unused);
  if (args.includes("--leftovers") || partArg) section("RUSSIAN TEXT OUTSIDE tr() — wrap it, or leave it if it is not interface text", result.leftovers);
  console.log(
    `\n${result.messages} messages · ${result.missing.length} without a translation · ${result.malformed.length} malformed · ` +
      `${result.unused.length} unused · ${result.leftovers.length} unwrapped Russian lines · ${result.dynamic} calls with a computed text`,
  );
  if (result.bad.length || result.missing.length || result.malformed.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv);
