/** The only place OpenAI model IDs are named in `typescript/src` and `tools`, and tests name
 * the current models only through these constants, both enforced by
 * `typescript/tests/unit/model-ids.test.ts`; changing a model is a one-line edit here. */

/**
 * CareerX fork: a model ID may be replaced from the environment, so the same build runs on the
 * org's own gateway (`POMERADO_MODEL_SOL`, `POMERADO_MODEL_LUNA`). An unset or blank variable
 * leaves the upstream ID, so upstream behaviour is the default.
 */
export const modelFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  upstream: string,
) => {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? upstream : value;
};

/** The big model: minting, maintenance, example generation and challenge solving. */
export const solModel = modelFromEnv(process.env, "POMERADO_MODEL_SOL", "gpt-6.1-sol");

/** The small model: Guardian reviews and capability assessment. */
export const lunaModel = modelFromEnv(process.env, "POMERADO_MODEL_LUNA", "gpt-6-luna");
