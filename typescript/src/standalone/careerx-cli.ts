#!/usr/bin/env node
/**
 * CareerX fork: the headless entry. It picks the model provider before anything that reads the
 * model IDs loads (`models/models.ts` reads its environment once, at import), then hands over to
 * `careerx-main.js`. Node built-ins only, on purpose.
 *
 *   pomerado-careerx mint --url URL --intent TEXT --out DIR [--provider gateway|openai] ...
 *   pomerado-careerx run --artifact DIR --url URL [--input JSON] ...
 */
const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (at === -1) return undefined;
  const arg = args[at] ?? "";
  return arg.includes("=") ? arg.slice(name.length + 1) : args[at + 1];
};
const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const provider = flag("--provider") ?? "gateway";
// A run makes no model request, and help makes none: neither needs a provider.
if (args[0] === "run" || args.includes("--help") || args.includes("-h") || args.length === 0) {
  if (provider !== "gateway" && provider !== "openai") fail("--provider must be gateway or openai.");
} else if (provider === "gateway") {
  if ((process.env["POMERADO_OPENAI_BASE_URL"] ?? "").trim() === "")
    fail("--provider gateway needs POMERADO_OPENAI_BASE_URL. Pass --provider openai to use OpenAI.");
} else if (provider === "openai") {
  // Upstream behaviour: OpenAI's model IDs and OPENAI_API_KEY. Nothing of the gateway applies.
  for (const name of ["POMERADO_OPENAI_BASE_URL", "POMERADO_MODEL_SOL", "POMERADO_MODEL_LUNA"])
    delete process.env[name];
  if ((process.env["OPENAI_API_KEY"] ?? "").trim() === "")
    fail("--provider openai needs OPENAI_API_KEY.");
} else fail("--provider must be gateway or openai.");

const { startCareerxCli } = await import("./careerx-main.js");
startCareerxCli(args, provider);
