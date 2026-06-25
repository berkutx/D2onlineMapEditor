// Emit JSON Schemas the Python asset-pipeline validates its output against.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AssetManifest, MANIFEST_VERSION } from "../src/manifest.js";
import { Spritesheet } from "../src/spritesheet.js";

const here = dirname(fileURLToPath(import.meta.url));
const genDir = resolve(here, "../gen");
mkdirSync(genDir, { recursive: true });

const manifest = zodToJsonSchema(AssetManifest, { name: "AssetManifest", $refStrategy: "none" });
writeFileSync(
  resolve(genDir, "asset-manifest.schema.json"),
  JSON.stringify({ manifestVersion: MANIFEST_VERSION, ...manifest }, null, 2) + "\n",
);
const sheet = zodToJsonSchema(Spritesheet, { name: "Spritesheet", $refStrategy: "none" });
writeFileSync(resolve(genDir, "spritesheet.schema.json"), JSON.stringify(sheet, null, 2) + "\n");
console.log("[asset-manifest] wrote gen/asset-manifest.schema.json + spritesheet.schema.json");
