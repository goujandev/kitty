/**
 * Proves the TypeScript wire types still describe what Rust actually sends.
 *
 * `crates/core/tests/wire_contract.rs` serializes every wire type and every
 * enum variant into `src/ipc/contract.json`. This script walks that file and
 * checks that each discriminator value and each field name appears in
 * `src/ipc/bindings.ts`.
 *
 * It catches the drift that matters in practice: a field renamed in Rust, a
 * variant added, a tag changed. It cannot catch a type changing from string to
 * number, which is what a real code generator would buy us. That trade is
 * deliberate for slice 1 and recorded in ADR-0001.
 *
 * Run: node scripts/check-contract.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = join(root, "src", "ipc", "contract.json");
const bindingsPath = join(root, "src", "ipc", "bindings.ts");

const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const bindings = readFileSync(bindingsPath, "utf8");

/** Field names that exist only in the generated file, not in the types. */
const IGNORED_KEYS = new Set(["$comment"]);

const fields = new Set();
const tags = new Set();

function walk(value) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item);
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (IGNORED_KEYS.has(key)) continue;
    fields.add(key);
    if (key === "kind" && typeof child === "string") tags.add(child);
    walk(child);
  }
}

// Walk the payloads, not the envelope that groups them: `installStates` is
// a heading in this file, not a field Rust ever sends over IPC.
walk(contract.installStates);
walk(contract.loginStates);
walk(contract.stopReasons);
walk(contract.transcriptEvents);
walk(contract.scan);

// Harness ids are a bare string union rather than tagged objects.
for (const id of contract.harnessIds ?? []) tags.add(id);
for (const kind of contract.blockKinds ?? []) tags.add(kind);
for (const group of ["toolStatuses", "approvalKinds", "approvalOutcomes"]) {
  for (const value of contract[group] ?? []) tags.add(value);
}

const problems = [];

for (const tag of [...tags].sort()) {
  if (!bindings.includes(`"${tag}"`)) {
    problems.push(`tag "${tag}" is sent by Rust but absent from bindings.ts`);
  }
}

for (const field of [...fields].sort()) {
  // `kind` is the discriminator itself and appears as `kind:` in every variant.
  const declared =
    new RegExp(`(^|[\\s{;])${field}\\??\\s*:`, "m").test(bindings) ||
    bindings.includes(`"${field}"`);
  if (!declared) {
    problems.push(`field "${field}" is sent by Rust but absent from bindings.ts`);
  }
}

if (problems.length > 0) {
  console.error("src/ipc/bindings.ts is out of date with the Rust wire types:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nRust regenerates the contract with:\n  UPDATE_CONTRACT=1 cargo test -p kitty-core\n" +
      "Then update src/ipc/bindings.ts to match.\n",
  );
  process.exit(1);
}

console.log(
  `contract ok: ${tags.size} tags, ${fields.size} fields verified against bindings.ts`,
);
