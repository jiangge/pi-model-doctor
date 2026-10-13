import { isSafeProviderApiUrl, isLoopbackHost, isPrivateHost } from "./catalog-url.ts";
import { lookup } from "node:dns/promises";
import { isRecord } from "./json.ts";
import type { PiProvider } from "./types.ts";

export interface ChannelDiscovery { ids?: string[]; warnings: string[] }
export function modelsEndpoint(base: string): string {
  const url = new URL(base);
  const validationUrl = isLoopbackHost(url.hostname) && url.protocol === "https:" ? base.replace(/^https:/i, "http:") : base;
  if (!isSafeProviderApiUrl(validationUrl, (key) => /key|token|secret|auth|password/i.test(key))) throw new Error("unsafe endpoint");
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path || "/v1"}/models`;
  return url.toString();
}
function resolveSecret(value: string): string | undefined {
  if (value.startsWith("!") || value.startsWith("pi-auth:")) return undefined;
  const env = /^(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$?([A-Z_][A-Z0-9_]*))$/.exec(value);
  if (env) return process.env[env[1] ?? env[2]];
  // Header templates support environment references only. Never pass unresolved
  // templates or embedded command/auth-store references onto the wire.
  if (value.includes("pi-auth:") || /(?:^|\s)!/.test(value)) return undefined;
  let missing = false;
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced: string | undefined, bare: string | undefined) => {
    const resolved = process.env[braced ?? bare!];
    if (!resolved) missing = true;
    return resolved ?? "";
  });
  return missing || expanded.includes("$") ? undefined : expanded;
}
/** No redirects, credential commands, documentation fetches or persistence. */
export async function discoverChannel(provider: PiProvider, fetcher: typeof fetch = fetch): Promise<ChannelDiscovery> {
  const warnings: string[] = [];
  if (!["openai-completions", "openai-responses"].includes(provider.api ?? "openai-completions")) return { warnings: ["Channel discovery unsupported for configured protocol; fallback is not verified channel support."] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const timeout = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
  // The same promise bounds DNS, headers and streamed body reads.
  void timeout.catch(() => {});
  let stage = "endpoint validation";
  try {
    if (!provider.baseUrl) throw new Error("missing endpoint");
    const endpoint = modelsEndpoint(provider.baseUrl);
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
    if (!isLoopbackHost(host) && fetcher === fetch) {
      const addresses = await Promise.race([lookup(host, { all: true }), timeout]);
      if (addresses.some(({ address }) => isPrivateHost(address))) throw new Error("unsafe endpoint");
    }
    stage = "credential/header resolution";
    const headers = new Headers();
    if (isRecord(provider.headers)) for (const [key, value] of Object.entries(provider.headers)) {
      if (typeof value !== "string" || /^(host|cookie|connection|proxy-authorization)$/i.test(key)) throw new Error("unsupported header");
      const resolved = /auth|key|token|secret/i.test(key) || value.includes("$") || value.startsWith("!") || value.includes("pi-auth:") ? resolveSecret(value) : value;
      if (resolved === undefined) throw new Error("unresolved credential reference");
      headers.set(key, resolved);
    }
    if (typeof provider.apiKey === "string" && !headers.has("authorization")) {
      const key = resolveSecret(provider.apiKey);
      if (!key) throw new Error("unresolved credential reference");
      headers.set("authorization", `Bearer ${key}`);
    }
    stage = "network request";
    const response = await Promise.race([fetcher(endpoint, { headers, signal: controller.signal, redirect: "manual" }), timeout]);
    if (response.status >= 300 && response.status < 400) return { warnings: ["Channel discovery redirect rejected; credentials were not forwarded. Fallback is not verified channel support."] };
    if (response.redirected || (response.url && new URL(response.url).origin !== new URL(endpoint).origin)) return { warnings: ["Channel discovery changed origin rejected; fallback is not verified channel support."] };
    if (!response.ok) return { warnings: [`Channel discovery HTTP ${response.status}; fallback is not verified channel support.`] };
    stage = "response body validation";
    if (!response.body) throw new Error("missing body");
    const reader = response.body.getReader();
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const result = await Promise.race([reader.read(), timeout]); if (result.done) break;
        size += result.value.byteLength; if (size > 1_048_576) { stage = "response body validation (1 MiB limit)"; throw new Error("body limit exceeded"); }
        chunks.push(result.value);
      }
    } finally { void reader.cancel().catch(() => {}); }
    stage = "models JSON validation";
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("invalid models response");
    if (value.data.length > 10_000) { stage = "model count validation (10,000 limit)"; throw new Error("model count exceeded"); }
    const ids: string[] = [];
    for (const model of value.data) {
      if (!isRecord(model) || typeof model.id !== "string" || !model.id || model.id.length > 256 || ["__proto__", "constructor", "prototype"].includes(model.id) || /[\s\x00-\x1f\x7f]/.test(model.id)) throw new Error("invalid model id");
      if (!ids.includes(model.id)) ids.push(model.id);
    }
    return { ids, warnings };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { warnings: [controller.signal.aborted ? "Channel discovery timed out; fallback is not verified channel support." : `Channel discovery ${stage} failed; fallback is not verified channel support.`] };
  } finally { clearTimeout(timer); }
}
