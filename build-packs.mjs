// build-packs.mjs — compile packs/_source/* into LevelDB packs
// Usage: node build-packs.mjs
import { compilePack } from "@foundryvtt/foundryvtt-cli";

await compilePack(
  "packs/_source/macros",   // input: folder of one-JSON-per-document
  "packs/macros",           // output: LevelDB directory Foundry reads
  { log: true }             // prints one "Packed <id> (<name>)" line per doc
);
console.log("packs/macros compiled.");