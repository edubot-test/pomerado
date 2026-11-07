# CareerX fork of Pomerado

This fork (`edubot-test/pomerado`, branch `careerx-local-models`) runs the upstream minter on the
org's own models and proxy, for the local employment catalogue. Upstream is
[Pomerado/pomerado](https://github.com/Pomerado/pomerado) (MIT). Every change is behind the
environment, so with the variables below unset the fork behaves as upstream.

## What changed

| File | Change |
|---|---|
| `typescript/src/models/models.ts` | `solModel` / `lunaModel` read `POMERADO_MODEL_SOL` / `POMERADO_MODEL_LUNA`; still the only file that names model IDs. |
| `typescript/src/models/gateway.ts` (new) | Gateway config from env, pinned CA, a Chat Completions model provider for vLLM, and the request clean-up it needs. |
| `typescript/src/models/prompt-cache.ts` | Two helpers exported (`withoutPromptCacheSettings`, `isPrewarm`). |
| `typescript/src/execution/proxy-settings.ts` (new) | `POMERADO_PROXY_URL` / `POMERADO_PROXY_MODE` parsing. Credentials become separate fields; errors never quote the URL. |
| `typescript/src/execution/playwright-{execute,protocol,worker}.ts` | `proxy` and `userAgent` options reach `browser.newContext()` (and `launchServer({proxy:{server:"per-context"}})`). |
| `typescript/src/standalone/careerx-cli.ts`, `careerx-main.ts` (new) | Headless entry `pomerado-careerx` with `--provider gateway|openai`. |
| `typescript/src/standalone/cli.ts` | `stoppedLines` and `reportText` exported. Nothing else. |
| `scripts/mint-cli.mjs` (new) | `mint-cli.mjs <site_url> <task> <out_dir>` for scripts. |
| `package.json` | `bin.pomerado-careerx`. |
| `typescript/tests/unit/careerx-gateway.test.ts` (new) | Env overrides, request clean-up, proxy parsing, UA and fallback rules. |

The library API is unchanged: `createPomerado` still takes `minterProvider`, `guardianProvider`
and `outcomeReviewerProvider`; the CLI passes the gateway provider for all three.

## Environment

| Variable | Meaning |
|---|---|
| `POMERADO_OPENAI_BASE_URL` | The gateway, e.g. `https://10.70.0.1:8443/v1`. Required for `--provider gateway`. |
| `POMERADO_OPENAI_API_KEY` | Key sent to the gateway (`unused` if unset). `OPENAI_API_KEY` is never sent to it. |
| `POMERADO_CA_FILE` | PEM of the CA that signed the gateway certificate. Added to the process trust store (`tls.setDefaultCACertificates`, system roots kept), so `fetch` accepts it. |
| `POMERADO_MODEL_SOL`, `POMERADO_MODEL_LUNA` | Replace the big (mint, repair) and small (Guardian, outcome review) model IDs. |
| `POMERADO_STRIP_PARAMS` | Extra comma-separated request fields to drop, if the gateway rejects one. |
| `POMERADO_STRIP_REASONING_EFFORT` | `1` sends no `reasoning_effort`. |
| `POMERADO_PROXY_URL` | `http://user:pass@host:port` (also `https:`, `socks5:`). Credentials are split into `username` / `password`. |
| `POMERADO_PROXY_MODE` | `fallback` (default when a URL is set), `always`, `off`. |
| `POMERADO_USER_AGENT` | The identifying UA of direct attempts. A proxied attempt uses Chromium's own UA. |

`--provider openai` removes the three gateway/model variables from the process and uses upstream
IDs with `OPENAI_API_KEY`. No OpenAI request is made unless it is passed explicitly. The default
provider is `gateway`.

## Proxy modes

- `off`: direct, identifying UA.
- `always`: every attempt through the proxy, default UA.
- `fallback`: the mint runs direct. If it ends because the site stopped it (`site_declined`,
  `site_unavailable`, or a step with `siteAccess` bot-challenge / rate-limit evidence), the whole mint
  runs once more through the proxy; the first report is kept as `mint-report.direct.json`. A
  `run` retries through the proxy only on a `RunOutcomeFailure` with no unconfirmed write.
  The retry is per attempt, not per step: the browser context is fixed for a session in the
  upstream harness, and switching mid-session would lose its sign-in and page state.

## Chat Completions mode (what is lost)

`@openai/agents` 0.18 uses the Responses API by default. The gateway provider sets
`useResponses: false`, so the SDK's Chat Completions model is used, and every request passes
`forChatCompletions`: it removes `store`, the prompt-cache settings and breakpoints,
`include: reasoning.encrypted_content`, `context_management`, `reasoning.summary` and
`reasoning.context`, turns `tool_choice: allowed_tools` into a filtered tool list, and turns the
cached developer prefix into a system message. The same hook upstream uses for Azure
(`promptCacheFallback`) is not needed.

Not available on a vLLM chat endpoint, and what happens:

- Encrypted reasoning continuity across turns: gone. Reasoning text is not carried between turns.
- Server-side compaction (`compaction` items, the 250K idle trigger, the 268K backstop): a
  compaction request is refused locally and the minter's own "compaction failed" path runs. A model
  with a context below 250K tokens relies on the minter's tool-result cutting, which is upstream's
  recovery for an over-long request.
- Prompt caching and prewarm: no effect (prewarm resolves empty).
- `apply_patch` is sent as a function tool, which the SDK does by itself on this transport.
- Structured output (Guardian's `json_schema`, strict) needs the gateway's guided decoding.
  Tool calling needs the model's vLLM tool-call parser enabled.

Nothing of this was run against the live gateway; the first real mint is the test.

## Telemetry

None found. Outbound traffic is the target site (browser), the model endpoint, and Playwright's
browser download at install. `sign-in-telemetry` is an in-process sink that is silent unless a
host configures one; this fork configures none. No code reads `pomerado.ai`. The minter's shell
tool runs model-written commands with an explicit environment (no inherited keys), but it is not an
OS sandbox: a command can reach the network.

## Platform

The minter's local process runner is macOS/Linux only (`createLocalProcess` fails on win32). Run it
in a Linux container, not on Windows.

## Run

```sh
export POMERADO_OPENAI_BASE_URL=https://10.70.0.1:8443/v1 POMERADO_CA_FILE=/etc/careerx/ca.pem
export POMERADO_MODEL_SOL=<big model id> POMERADO_MODEL_LUNA=<small model id>
node scripts/mint-cli.mjs https://jobs.example.com "list open jobs with title, location, url" ./out/example
# same, as a packaged MCP integration (mcp.json, mcp.mjs, README.md, deployment.json, pomerado.json):
node dist/typescript/src/standalone/careerx-cli.js mint --url https://jobs.example.com \
  --intent "list open jobs" --out ./integrations --integration example-jobs
# run a saved artifact: no model, no key
node dist/typescript/src/standalone/careerx-cli.js run --artifact ./out/example --url https://jobs.example.com
```

Exit code 0 on a saved artifact, 1 when nothing was saved (the reason is on stderr and in
`mint-report.json`), 2 on bad arguments. Mints are non-interactive: a question the build needs goes
unanswered and the mint stops (`--interactive` asks on the terminal). `--effect` defaults to `read`.

## Container

```dockerfile
FROM node:24-bookworm-slim
RUN corepack enable
WORKDIR /opt/pomerado
COPY . .
RUN corepack pnpm install --frozen-lockfile && corepack pnpm build \
 && npx playwright install --with-deps chromium
```

Node must be `>=24.21 <25`. Mount the gateway CA and pass the variables above at run time.

## Rebase on upstream

The fork's changes are small and mostly additive. Upstream wants a merge, not a rebase, for its own
branches; for this fork:

```sh
git remote add upstream https://github.com/Pomerado/pomerado.git
git fetch upstream
git merge upstream/main          # conflicts, if any, are in models.ts, cli.ts, playwright-*.ts, package.json
corepack pnpm install --frozen-lockfile && corepack pnpm typecheck && corepack pnpm test
```

If upstream moves `@openai/agents`, re-check `OpenAIProvider({ useResponses: false })`, the
`allowed_tools` and `compaction_trigger` shapes in `gateway.ts`, and the model-ID test, which keeps
OpenAI IDs out of every file but `models.ts`.
