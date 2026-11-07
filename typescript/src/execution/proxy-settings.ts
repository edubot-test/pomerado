/**
 * CareerX fork: the browser's egress proxy, from the environment. The URL's credentials become
 * their own fields (Playwright's `proxy.username` and `password`) and are never part of a message.
 */
export type ProxyMode = "fallback" | "always" | "off";

export interface ProxySettings {
  readonly server: string;
  readonly username?: string;
  readonly password?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** `http://user:pass@host:port` as server plus credentials. The error never quotes the URL. */
export const parseProxyUrl = (url: string): ProxySettings => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("POMERADO_PROXY_URL is not a valid URL.");
  }
  if (!["http:", "https:", "socks5:"].includes(parsed.protocol))
    throw new Error("POMERADO_PROXY_URL must be an http, https or socks5 URL.");
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  return {
    server: `${parsed.protocol}//${parsed.host}`,
    ...(username === "" ? {} : { username }),
    ...(password === "" ? {} : { password }),
  };
};

/** The configured mode; `fallback` when only a URL is set, `off` when nothing is. */
export const proxyModeFromEnv = (env: Env): ProxyMode => {
  const mode = env["POMERADO_PROXY_MODE"]?.trim().toLowerCase();
  const hasUrl = (env["POMERADO_PROXY_URL"]?.trim() ?? "") !== "";
  if (mode === undefined || mode === "") return hasUrl ? "fallback" : "off";
  if (mode !== "fallback" && mode !== "always" && mode !== "off")
    throw new Error("POMERADO_PROXY_MODE must be fallback, always or off.");
  return mode;
};

/** The proxy the environment names, or none. A mode that needs one and finds none is an error. */
export const proxyFromEnv = (env: Env): ProxySettings | undefined => {
  const mode = proxyModeFromEnv(env);
  const url = env["POMERADO_PROXY_URL"]?.trim() ?? "";
  if (url === "") {
    if (mode === "always") throw new Error("POMERADO_PROXY_MODE=always needs POMERADO_PROXY_URL.");
    return undefined;
  }
  return parseProxyUrl(url);
};
