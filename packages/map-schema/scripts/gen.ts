// Emit the language-neutral JSON Schema that the Python asset-pipeline & others validate against.
// Run via tsx (not part of the tsc build).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { MapDocument } from "../src/document.js";
import { SCHEMA_VERSION } from "../src/version.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../gen/map.schema.json");
const schema = zodToJsonSchema(MapDocument, { name: "MapDocument", $refStrategy: "none" });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...schema }, null, 2) + "\n");
console.log("[map-schema] wrote", out);
