import { PROVIDER_ID, MODEL_ID_PATTERN, OPENAI_MODEL_PREFIX, MODALITIES } from "./constants.mjs";

export function modelProtocol(id, urls) {
  return id.toLowerCase().startsWith(OPENAI_MODEL_PREFIX) ? urls.responses : urls.messages;
}

export const isModelId = (id) => typeof id === "string" && MODEL_ID_PATTERN.test(id);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" ? value.trim() : "");
const positiveInteger = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);
const price = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const flag = (...values) => values.find((value) => typeof value === "boolean");
const modalities = (values) =>
  Object.fromEntries(
    MODALITIES.map((kind) => [
      kind,
      values.includes(kind) || (kind === "pdf" && values.includes("file")),
    ]),
  );

export function modelCatalog(body) {
  if (!Array.isArray(body?.data)) throw new Error("ZenMux model catalog has an unexpected format.");
  if (body.data.length && !body.data.some((model) => isModelId(model?.id)))
    throw new Error("ZenMux model catalog contains no valid model records.");
  return body;
}

export function modelsDevCatalog(body) {
  if (!record(body?.zenmux?.models))
    throw new Error("models.dev returned an unexpected ZenMux catalog.");
  return body.zenmux.models;
}

function referenceCost(cost) {
  // The host's price card needs an input/output pair. Do not turn absent
  // prices into zero, or flatten context tiers into an invented single price.
  if (!price(cost?.input) || !price(cost?.output)) return undefined;
  const cache = {};
  if (price(cost.cache_read)) cache.read = cost.cache_read;
  if (price(cost.cache_write)) cache.write = cost.cache_write;
  return {
    input: cost.input,
    output: cost.output,
    ...(Object.keys(cache).length ? { cache } : {}),
  };
}

function reasoningVariants(known) {
  if (!Array.isArray(known.reasoning_options)) return {};
  const entries = known.reasoning_options.flatMap((option) =>
    option?.type === "effort" && Array.isArray(option.values)
      ? option.values
          .filter((value) => typeof value === "string" && /^[a-z][a-z0-9_-]*$/i.test(value))
          .map((value) => [value, {}])
      : [],
  );
  // Toggle and token-budget controls are not effort levels.
  return Object.fromEntries(entries);
}

function interleaved(value) {
  if (typeof value === "boolean") return value;
  if (record(value) && text(value.field)) return { field: value.field };
}

export function buildModels(catalog, urls, metadata = {}) {
  const models = Object.create(null);
  for (const model of modelCatalog(catalog).data) {
    if (!isModelId(model?.id)) continue;
    const candidate = Object.hasOwn(metadata, model.id) ? metadata[model.id] : undefined;
    // Exact ZenMux model IDs only: canonical IDs and other providers are not
    // evidence that ZenMux serves the same capabilities or price.
    const known = record(candidate) && candidate.id === model.id ? candidate : {};
    const inputs = Array.isArray(model.input_modalities)
      ? model.input_modalities
      : known.modalities?.input;
    const outputs = Array.isArray(model.output_modalities)
      ? model.output_modalities
      : known.modalities?.output;
    if (!Array.isArray(inputs) || !Array.isArray(outputs)) continue;
    // Image/video/audio generators do not belong in the Agent chat picker.
    if (!inputs.includes("text") || outputs.length !== 1 || outputs[0] !== "text") continue;
    const protocol = modelProtocol(model.id, urls);
    const api = protocol === urls.responses ? "responses" : "messages";
    if (
      model.supported_apis !== undefined &&
      (!Array.isArray(model.supported_apis) || !model.supported_apis.includes(api))
    )
      continue;
    const input = modalities(inputs);
    const context = positiveInteger(model.context_length) || positiveInteger(known.limit?.context);
    const output = positiveInteger(model.max_tokens) || positiveInteger(known.limit?.output);
    const inputLimit = positiveInteger(known.limit?.input);
    const reasoning = flag(model.capabilities?.reasoning, known.reasoning) ?? false;
    const cost = referenceCost(known.cost);
    models[model.id] = {
      id: model.id,
      providerID: PROVIDER_ID,
      name: text(model.display_name) || text(known.name) || model.id,
      // Routing is ours, not models.dev's provider defaults.
      api: { id: model.id, npm: protocol.npm, url: protocol.url },
      limit: {
        context,
        ...(inputLimit ? { input: context ? Math.min(context, inputLimit) : inputLimit } : {}),
        output: context && output ? Math.min(context, output) : output,
      },
      capabilities: {
        temperature: flag(model.capabilities?.temperature, known.temperature) ?? true,
        reasoning,
        attachment: Object.entries(input).some(([kind, on]) => kind !== "text" && on),
        toolcall:
          flag(model.capabilities?.tool_call, model.capabilities?.toolcall, known.tool_call) ??
          true,
        input,
        output: modalities(outputs),
        interleaved:
          interleaved(model.capabilities?.interleaved) ?? interleaved(known.interleaved) ?? false,
      },
      // Shared list-price references, not Builder Flow charges or a live bill.
      ...(cost ? { cost } : {}),
      options: {},
      headers: {},
      variants: reasoning ? reasoningVariants(known) : {},
      status: "active",
      release_date: text(model.publish_time) || text(known.release_date),
    };
  }
  return models;
}
