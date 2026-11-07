import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { readArtifact, writeArtifact } from "./artifact-files.js";
import { reportText, stoppedLines } from "./cli.js";
import { createPomerado } from "./pomerado.js";
import { prepareIntegration } from "./mcp-package.js";
import type { LocalMintOutcome, PomeradoOptions, PomeradoRequest } from "./contracts.js";
import { RunOutcomeFailure } from "./run-report.js";
import { makeTerminalAsker } from "../inputs/terminal.js";
import { InputRequestFailure, type InputAsker } from "../runtime/input-request.js";
import { gatewayConfigFromEnv, makeGatewayProvider } from "../models/gateway.js";
import {
  proxyFromEnv,
  proxyModeFromEnv,
  type ProxyMode,
  type ProxySettings,
} from "../execution/proxy-settings.js";

const usage = `Pomerado, CareerX headless entry

  pomerado-careerx mint --url URL --intent TEXT --out DIRECTORY [--input JSON]
                        [--integration NAME]
  pomerado-careerx run --artifact DIRECTORY --url URL [--input JSON]

Options
  --provider gateway|openai  gateway (default): POMERADO_OPENAI_BASE_URL and its models.
                             openai: upstream OpenAI, OPENAI_API_KEY. A run needs neither.
  --effect read|write|ask    Mint authority (default read, since nobody answers questions)
  --timeout-seconds N        Session budget (default 1200)
  --proxy-mode MODE          fallback|always|off, over POMERADO_PROXY_MODE
  --interactive              Ask questions in this terminal instead of failing them
  --integration NAME         Package the mint as an MCP integration, --out being its root
  --endpoint URL, --headed   As pomerado

Exit code 0 when an artifact was saved (or a run returned), 1 otherwise, 2 on bad arguments.
`;

/** Nobody is there to answer: every question goes unanswered, and the mint says so and stops. */
const noOneAsking: InputAsker = () => Effect.fail(new InputRequestFailure({ code: "NoResponse" }));

/** The mint was stopped by the site, not by the task: a proxied retry has a chance. */
export const siteBlocked = (result: LocalMintOutcome) => {
  const why = result.stopReason ?? result.blocked?.reason;
  return (
    result.artifact === undefined &&
    (why === "site_declined" ||
      why === "site_unavailable" ||
      result.executions.some(
        (execution) =>
          execution.siteAccess !== undefined || execution.terminalFailure === "ChallengeFailure",
      ))
  );
};

/**
 * The browser of one attempt. Direct requests identify themselves (`POMERADO_USER_AGENT`); a
 * proxied attempt presents as the browser it is, with Chromium's own user agent.
 */
export const attemptBrowser = (
  proxy: ProxySettings | undefined,
  env: Readonly<Record<string, string | undefined>>,
) => {
  const identifying = env["POMERADO_USER_AGENT"]?.trim();
  return proxy !== undefined
    ? { proxy }
    : identifying === undefined || identifying === ""
      ? {}
      : { userAgent: identifying };
};

const readArgs = (args: readonly string[]) =>
  Effect.try({
    try: () => {
      const { values, positionals } = parseArgs({
        args: [...args],
        allowPositionals: true,
        options: {
          help: { type: "boolean", short: "h" },
          provider: { type: "string" },
          url: { type: "string" },
          intent: { type: "string" },
          out: { type: "string" },
          artifact: { type: "string" },
          input: { type: "string" },
          endpoint: { type: "string" },
          headed: { type: "boolean" },
          interactive: { type: "boolean" },
          effect: { type: "string" },
          integration: { type: "string" },
          "proxy-mode": { type: "string" },
          "timeout-seconds": { type: "string" },
        },
      });
      return { values, command: positionals[0], extra: positionals.length };
    },
    catch: (cause) => new Error(cause instanceof Error ? cause.message : "Bad arguments."),
  });

const runCareerx = (args: readonly string[], provider: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { values, command, extra } = yield* readArgs(args);
      if (values.help || command === undefined) {
        process.stdout.write(usage);
        return;
      }
      if ((command !== "mint" && command !== "run") || extra !== 1)
        return yield* Effect.fail(new Error("Use mint or run. See --help."));
      if (values.url === undefined) return yield* Effect.fail(new Error("--url is required."));
      if (command === "mint" && values.intent === undefined)
        return yield* Effect.fail(new Error("--intent is required to mint."));
      const effect = values.effect ?? "read";
      if (effect !== "read" && effect !== "write" && effect !== "ask")
        return yield* Effect.fail(new Error("Choose a supported --effect. See --help."));
      const timeoutMs = Number(values["timeout-seconds"] ?? "1200") * 1000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return yield* Effect.fail(new Error("--timeout-seconds must be positive."));
      const input = yield* Effect.try({
        try: () => JSON.parse(values.input ?? "{}") as unknown,
        catch: () => new Error("--input must be valid JSON."),
      });
      const env = {
        ...process.env,
        ...(values["proxy-mode"] === undefined ? {} : { POMERADO_PROXY_MODE: values["proxy-mode"] }),
      };
      const mode: ProxyMode = yield* Effect.try(() => proxyModeFromEnv(env));
      const proxy = yield* Effect.try(() => proxyFromEnv(env));

      const gateway = provider === "gateway" ? gatewayConfigFromEnv(process.env) : undefined;
      const modelProvider = gateway === undefined ? undefined : makeGatewayProvider(gateway);
      const providers: Pick<
        PomeradoOptions,
        "minterProvider" | "guardianProvider" | "outcomeReviewerProvider"
      > =
        modelProvider === undefined
          ? {}
          : {
              minterProvider: modelProvider,
              guardianProvider: modelProvider,
              outcomeReviewerProvider: modelProvider,
            };

      /** One session, direct or through the proxy. */
      const session = (through: ProxySettings | undefined) =>
        createPomerado({
          ...providers,
          ask: values.interactive ? makeTerminalAsker() : noOneAsking,
          timeoutMs,
          browser: {
            headless: !values.headed,
            ...(values.endpoint === undefined ? {} : { endpoint: values.endpoint }),
            ...attemptBrowser(through, env),
          },
        });
      // `always` goes through the proxy; `fallback` starts direct; `off` never uses it.
      const first = mode === "always" ? proxy : undefined;
      const retry = mode === "fallback" ? proxy : undefined;

      if (command === "run") {
        if (values.artifact === undefined)
          return yield* Effect.fail(new Error("--artifact is required."));
        const artifact = yield* readArtifact(resolve(values.artifact));
        const request = { url: values.url, intent: values.intent ?? "", input };
        const attempt = (through: ProxySettings | undefined) =>
          session(through).pipe(Effect.flatMap((pomerado) => pomerado.run(artifact, request)));
        const output = yield* attempt(first).pipe(
          // A proxied retry only when nothing may have been written to the site.
          Effect.catchAll((failure) =>
            retry !== undefined &&
            failure instanceof RunOutcomeFailure &&
            failure.unconfirmed === undefined
              ? attempt(retry)
              : Effect.fail(failure),
          ),
        );
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        return;
      }

      if (values.out === undefined) return yield* Effect.fail(new Error("--out is required."));
      const request: PomeradoRequest = { url: values.url, intent: values.intent ?? "", input, effect };
      const attempt = (through: ProxySettings | undefined) =>
        session(through).pipe(Effect.flatMap((pomerado) => pomerado.mint(request)));
      const root = resolve(values.out);
      yield* Effect.tryPromise(() => mkdir(dirname(root), { recursive: true }));
      const save = values.integration === undefined ? undefined : root;
      // An integration is packaged under `--out/NAME`; a plain mint writes into `--out` itself.
      const directory = save === undefined ? root : join(root, values.integration ?? "");
      if (save === undefined)
        yield* Effect.tryPromise({
          try: () => mkdir(directory),
          catch: (cause) => new Error("--out must name a new directory.", { cause }),
        });
      else yield* Effect.tryPromise(() => mkdir(root, { recursive: true }));

      // Reports go beside an integration (its directory must not exist yet), inside a plain mint.
      const reports = save === undefined ? directory : root;
      const stem = save === undefined ? "" : `${values.integration ?? ""}.`;
      let result = yield* attempt(first);
      if (result.artifact === undefined && retry !== undefined && siteBlocked(result)) {
        process.stderr.write(
          "The site blocked the direct attempt; minting once more through the proxy.\n",
        );
        const kept = join(reports, `${stem}mint-report.direct.json`);
        yield* Effect.tryPromise(() => writeFile(kept, reportText(result)));
        result = yield* attempt(retry);
      }
      if (result.artifact === undefined) {
        process.stderr.write(`${result.summary}\n${stoppedLines(result)}`);
        process.exitCode = 1;
        const report = join(reports, `${stem}mint-report.json`);
        yield* Effect.tryPromise(() => writeFile(report, reportText(result)));
        process.stderr.write(`  Full report: ${report}\n`);
        return;
      }
      if (values.integration === undefined) {
        yield* writeArtifact(directory, result.artifact);
        process.stdout.write(`Saved ${result.artifact.entrypoint} and its schemas to ${directory}\n`);
        return;
      }
      const write = yield* prepareIntegration({
        root,
        name: values.integration,
        request,
        description: request.intent,
      });
      yield* write(result.artifact);
      process.stdout.write(`Saved the integration ${values.integration} to ${directory}\n`);
    }),
  );

/** Runs the headless entry and sets the exit code: 1 on failure or when a mint saves nothing. */
export const startCareerxCli = (args: readonly string[], provider: string): void => {
  const cancel = Effect.runCallback(runCareerx(args, provider), {
    onExit: (result) => {
      if (Exit.isFailure(result)) {
        const failure = Cause.squash(result.cause);
        process.stderr.write(
          `${failure instanceof Error ? failure.message : "Pomerado failed."}\n`,
        );
        process.exitCode = 1;
      }
    },
  });
  process.once("SIGINT", () => cancel());
  process.once("SIGTERM", () => cancel());
};
