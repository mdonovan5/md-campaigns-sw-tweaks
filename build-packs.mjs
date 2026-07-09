// build-packs.mjs — compile packs/_source/* into the LevelDB packs Foundry reads.
// Usage: node build-packs.mjs
// Requires: npm install --save-dev @foundryvtt/foundryvtt-cli
// Run with Foundry CLOSED (LevelDB is single-writer; a live world holds the LOCK).

import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { readdirSync } from "fs";

const SOURCE = "packs/_source/macros";
const OUTPUT = "packs/macros";

const count = readdirSync(SOURCE).filter((f) => f.endsWith(".json")).length;

await compilePack(SOURCE, OUTPUT, { log: true });

console.log(`${OUTPUT} compiled from ${count} source document(s).`);
