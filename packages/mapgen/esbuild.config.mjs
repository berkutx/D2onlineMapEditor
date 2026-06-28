// Build @d2/mapgen into a single self-contained ESM bundle. We bundle (rather than
// tsc-compile) because the vendored MarkovJuniorWeb uses extensionless / directory
// imports that Node ESM can't resolve post-emit; esbuild inlines everything (incl.
// @xmldom/xmldom + seedrandom) into one node-ready file. Public types are hand-written
// (tiny surface) since esbuild doesn't emit .d.ts.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  outfile: "dist/index.js",
  logLevel: "info",
});
console.log("wrote dist/index.js (types in committed types.d.ts)");
