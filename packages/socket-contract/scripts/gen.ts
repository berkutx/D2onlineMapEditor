// Emit the EditOp JSON Schema for the server to validate incoming ops (Stage 4).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { EditOp } from "../src/ops.js";

const here = dirname(fileURLToPath(import.meta.url));
const genDir = resolve(here, "../gen");
mkdirSync(genDir, { recursive: true });
const schema = zodToJsonSchema(EditOp, { name: "EditOp", $refStrategy: "none" });
writeFileSync(resolve(genDir, "edit-op.schema.json"), JSON.stringify(schema, null, 2) + "\n");
console.log("[socket-contract] wrote gen/edit-op.schema.json");
