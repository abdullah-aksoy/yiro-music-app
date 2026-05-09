import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const srcPath = path.join(repoRoot, "app/static/app.js");
const outPath = path.join(__dirname, "../src/application.ts");

const raw = fs.readFileSync(srcPath, "utf8");
const lines = raw.split(/\r?\n/);

/** 1-based inclusive; remove from bottom of file first so indices stay valid. */
function remove1Based(start, end) {
  lines.splice(start - 1, end - start + 1);
}

remove1Based(6857, 6875);
remove1Based(206, 332);
remove1Based(1, 203);

const header = `// @ts-nocheck
// Spliced from app/static/app.js — re-run: npm run splice (after restoring a full legacy app.js snapshot if needed)
import { state } from "./state";
import { el, elNew } from "./dom";
import { perfMark, perfMeasure, initPerfFromUrl } from "./perf";

`;

fs.writeFileSync(outPath, header + lines.join("\n"), "utf8");
console.log("Wrote", outPath, "line count:", lines.length);
