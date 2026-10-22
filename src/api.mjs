import { createHash } from "node:crypto";

import {
  ORIGIN,
  MODELS_DEV_ORIGIN,
  LOOPBACK_HOSTS,
  PROTOCOLS,
  API_PATHS,
  METADATA_TIMEOUT,
  METADATA_CACHE_LIMIT,
} from "./constants.mjs";

function origin(value, label) {
  const url = new URL(value);
  const local = LOOPBACK_HOSTS.includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(`${label} must be an HTTPS origin, or an HTTP loopback origin for testing.`);
  return url.origin;
}

export function endpoints(options = {}) {
  for (const key of Object.keys(options)) {
    if (!["origin", "modelsDevOrigin"].includes(key))
      throw new Error(
        `Unsupported magpie-zenmux option: ${key}. Routing is automatic; remove old protocol and endpoint options.`,
      );
  }
  const site = origin(options.origin ?? ORIGIN, "ZenMux origin");
  const modelsDev = origin(options.modelsDevOrigin ?? MODELS_DEV_ORIGIN, "models.dev origin");
  return {
    origin: site,
    modelsDev: modelsDev + "/api.json",
    messages: {
      npm: PROTOCOLS.messages.npm,
      url: site + PROTOCOLS.messages.basePath,
      path: PROTOCOLS.messages.path,
    },
    responses: {
      npm: PROTOCOLS.responses.npm,
      url: site + PROTOCOLS.responses.basePath,
      path: PROTOCOLS.responses.path,
    },
    models: site + API_PATHS.models,
    subscription: site + API_PATHS.subscription,
    balance: site + API_PATHS.balance,
  };
}

// Successes only, with in-flight coalescing. Each provider instance owns its
// cache; management entries are keyed by endpoint and a digest of its key.
export function metadataClient({ now = Date.now, timeout = METADATA_TIMEOUT } = {}) {
  const cache = new Map();
  return async function read(url, key, ttl, parse) {
    const id = createHash("sha256")
      .update(JSON.stringify([url, key ?? ""]))
      .digest("hex");
    let entry = cache.get(id);
    if (entry?.pending) return entry.pending;
    if (entry && now() < entry.until) return entry.value;
    if (!entry) {
      if (cache.size >= METADATA_CACHE_LIMIT) cache.delete(cache.keys().next().value);
      entry = { until: 0 };
      cache.set(id, entry);
    }
    entry.pending = (async () => {
      const label = key ? "Management API" : "model catalog";
      let response;
      try {
        response = await fetch(url, {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(timeout),
          redirect: "error",
        });
      } catch {
        throw new Error(`ZenMux ${label} could not be reached (network, timeout or redirect).`);
      }
      if (!response.ok) {
        let hint = "";
        if (key && [401, 403].includes(response.status))
          hint =
            " Check this account's Management API Key at https://zenmux.ai/platform/management. Inference remains available.";
        else if (key && [422, 429].includes(response.status))
          hint = " Monitoring is rate limited; try again later. Inference remains available.";
        throw new Error(`ZenMux ${label} returned HTTP ${response.status}.${hint}`);
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error(`ZenMux ${label} returned invalid JSON.`);
      }
      const value = parse(body);
      entry.value = value;
      entry.until = now() + ttl;
      return value;
    })().finally(() => {
      entry.pending = undefined;
    });
    return entry.pending;
  };
}
