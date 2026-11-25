// Emit JSON Schemas the Python asset-pipeline validates its mod data sets against.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { MOD_SCHEMA_VERSION, ModIndex, ModManifest } from "../src/manifest.js";
import { IdSets } from "../src/ids.js";
import { ModProfile } from "../src/profile.js";
import { ScenVariableCatalog } from "../src/scenVariables.js";

const here = dirname(fileURLToPath(import.meta.url));
const genDir = resolve(here, "../gen");
mkdirSync(genDir, { recursive: true });

const schemas: [file: string, name: string, schema: ZodTypeAny][] = [
  ["mod-manifest.schema.json", "ModManifest", ModManifest],
  ["mod-index.schema.json", "ModIndex", ModIndex],
  ["id-sets.schema.json", "IdSets", IdSets],
  ["mod-profile.schema.json", "ModProfile", ModProfile],
  ["scen-variables.schema.json", "ScenVariableCatalog", ScenVariableCatalog],
];
for (const [file, name, schema] of schemas) {
  const json = zodToJsonSchema(schema, { name, $refStrategy: "none" });
  writeFileSync(resolve(genDir, file), JSON.stringify({ modSchemaVersion: MOD_SCHEMA_VERSION, ...json }, null, 2) + "\n");
}
console.log(`[mod-catalog] wrote ${schemas.map(([f]) => `gen/${f}`).join(", ")}`);
