#!/usr/bin/env node
// CareerX fork: mint one integration from a script, no MCP client.
//   node scripts/mint-cli.mjs <site_url> <task> <out_dir> [--provider gateway|openai] [flags...]
// Needs `pnpm build` first. Exit code: 0 artifact saved, 1 nothing saved or failure, 2 bad usage.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [url, task, out, ...rest] = process.argv.slice(2);
if (!url || !task || !out || url.startsWith("-")) {
  process.stderr.write(
    "Usage: node scripts/mint-cli.mjs <site_url> <task> <out_dir> [--provider gateway|openai] [--effect read|write] [--integration NAME] [--proxy-mode fallback|always|off] [--timeout-seconds N]\n",
  );
  process.exit(2);
}
const entry = fileURLToPath(
  new URL("../dist/typescript/src/standalone/careerx-cli.js", import.meta.url),
);
if (!existsSync(entry)) {
  process.stderr.write("dist/ is missing. Run `corepack pnpm build` first.\n");
  process.exit(2);
}
const child = spawn(
  process.execPath,
  [entry, "mint", "--url", url, "--intent", task, "--out", out, ...rest],
  { stdio: "inherit" },
);
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
