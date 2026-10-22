import { inferenceKey } from "./authentication.mjs";
import { isModelId, modelProtocol } from "./models.mjs";
import {
  ANTHROPIC_VERSION,
  ANTHROPIC_BETA_QUERY,
  PRIVATE_HEADERS,
  SIGN_IN_HEADER,
} from "./constants.mjs";

async function inferenceRequest(input, init, urls) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const endpoint = url.origin + url.pathname;
  const messages = endpoint === urls.messages.url + urls.messages.path;
  const responses = endpoint === urls.responses.url + urls.responses.path;
  const queryOK = !url.search || (messages && url.search === ANTHROPIC_BETA_QUERY);
  if (
    request.method !== "POST" ||
    (!messages && !responses) ||
    !queryOK ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Refusing an unexpected ZenMux endpoint or method.");
  request.signal.throwIfAborted();
  const raw = await request.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("ZenMux expects a JSON request.");
  }
  if (!isModelId(body?.model)) throw new Error("ZenMux expects a namespaced model id.");
  const protocol = modelProtocol(body.model, urls);
  if (endpoint !== protocol.url + protocol.path)
    throw new Error("ZenMux model protocol mismatch. Refresh the model catalog in Magpie.");
  return { request, raw, messages };
}

async function signInResponse(response) {
  if (response.status !== 403) return response;
  let signIn = "kept";
  try {
    // ZenMux uses the same HTTP status for revoked keys and safety filters.
    // Inspect only the error response, never a successful SSE stream.
    const body = await response.clone().json();
    if (body?.error?.type === "access_denied") signIn = "expired";
  } catch {
    // An HTML proxy denial or malformed error is not proof of a revoked key.
  }
  const headers = new Headers(response.headers);
  headers.set(SIGN_IN_HEADER, signIn);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function createInferenceLoader(urls, getAuth) {
  inferenceKey(await getAuth());
  return {
    // No baseURL: it would override each model's native endpoint.
    async fetch(input, init) {
      const { request, raw, messages } = await inferenceRequest(input, init, urls);
      const key = inferenceKey(await getAuth());
      request.signal.throwIfAborted();
      const headers = new Headers(request.headers);
      for (const name of PRIVATE_HEADERS) headers.delete(name);
      if (messages) {
        headers.set("x-api-key", key);
        if (!headers.has("anthropic-version")) headers.set("anthropic-version", ANTHROPIC_VERSION);
      } else headers.set("authorization", `Bearer ${key}`);
      headers.set("content-type", "application/json");
      const response = await fetch(request.url, {
        method: "POST",
        headers,
        body: raw,
        signal: request.signal,
        redirect: "error",
      });
      return signInResponse(response);
    },
  };
}
