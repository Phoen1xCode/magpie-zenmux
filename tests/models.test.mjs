import test from "node:test";
import assert from "node:assert/strict";
import { endpoints } from "../src/api.mjs";
import { MODEL_TTL, MODEL_METADATA_TTL } from "../src/constants.mjs";
import { buildModels } from "../src/models.mjs";
import { ZenMuxPlugin } from "../index.mjs";
import { auth, fixture, deferred, model, metadataModel } from "./helpers/fixture.mjs";

const id = "openai/gpt-fixture";
const urls = endpoints();
const mapped = (live, known) => buildModels({ data: [live] }, urls, { [live.id]: known })[live.id];

test("exact models.dev metadata supplies reasoning efforts and all four reference prices", () => {
  const live = model(id);
  const known = metadataModel(id);
  const before = structuredClone({ live, known });
  const result = mapped(live, known);
  assert.deepEqual(result.variants, { low: {}, medium: {}, high: {} });
  assert.deepEqual(result.cost, { input: 1.25, output: 5, cache: { read: 0.125, write: 1.5 } });
  assert.equal(result.free, undefined, "reference prices must not change allowance routing");
  assert.deepEqual({ live, known }, before);
});

test("a model missing from models.dev stays listed without invented variants or prices", () => {
  const result = buildModels({ data: [model(id), model("vendor/new-model")] }, urls, {
    [id]: metadataModel(id),
    "vendor/catalog-only": metadataModel("vendor/catalog-only"),
  });
  assert.deepEqual(Object.keys(result), [id, "vendor/new-model"]);
  assert.deepEqual(result["vendor/new-model"].variants, {});
  assert.equal(result["vendor/new-model"].cost, undefined);
  assert.equal(result["vendor/new-model"].limit.context, 200000);
  assert.ok(result[id].cost, "the positive case must prove metadata enrichment ran");
});

test("explicit ZenMux facts win over supplementary capabilities and limits", () => {
  const result = mapped(
    model(id, {
      display_name: "Live name",
      capabilities: { reasoning: false, temperature: false, tool_call: false, interleaved: false },
      context_length: 100000,
      max_tokens: 24000,
      publish_time: "2026-06-01",
    }),
    metadataModel(id, { reasoning: true, temperature: true, interleaved: true }),
  );
  assert.equal(result.name, "Live name");
  assert.equal(result.capabilities.reasoning, false);
  assert.equal(result.capabilities.temperature, false);
  assert.equal(result.capabilities.toolcall, false);
  assert.equal(result.capabilities.interleaved, false);
  assert.deepEqual(result.variants, {});
  assert.equal(result.limit.context, 100000);
  assert.equal(result.limit.output, 24000);
  assert.equal(result.release_date, "2026-06-01");
});

test("missing names, limits and capabilities are supplemented without changing native endpoints", () => {
  const result = mapped(
    model(id, {
      display_name: "",
      capabilities: {},
      context_length: undefined,
      max_tokens: undefined,
      input_modalities: undefined,
      output_modalities: undefined,
    }),
    metadataModel(id, {
      provider: { npm: "@ai-sdk/google", api: "https://untrusted.example" },
    }),
  );
  assert.ok(result);
  assert.equal(result.name, `Catalog ${id}`);
  assert.deepEqual(result.limit, { context: 128000, input: 112000, output: 16000 });
  assert.equal(result.capabilities.reasoning, true);
  assert.equal(result.capabilities.temperature, false);
  assert.equal(result.capabilities.input.pdf, true);
  assert.equal(result.release_date, "2026-01-01");
  assert.deepEqual(result.api, { id, npm: "@ai-sdk/openai", url: "https://zenmux.ai/api/v1" });
});

test("canonical aliases and mismatched metadata IDs are not used as guessed matches", () => {
  const result = buildModels({ data: [model(id), model("vendor/not-yet-synced")] }, urls, {
    [id]: metadataModel("openai/different-model"),
    "vendor/old-alias": metadataModel("vendor/old-alias", {
      canonical_model_id: "vendor/not-yet-synced",
    }),
  });
  for (const entry of Object.values(result)) {
    assert.deepEqual(entry.variants, {});
    assert.equal(entry.cost, undefined);
  }
  assert.ok(mapped(model(id), metadataModel(id)).cost);
});

test("toggle and budget reasoning models do not acquire invented effort levels", () => {
  for (const reasoning_options of [
    undefined,
    [],
    [{ type: "toggle" }],
    [{ type: "budget_tokens", min: 1024, max: 32000 }],
    [{ type: "effort", values: null }],
    [{ type: "effort", values: [null, 5, "", " "] }],
  ]) {
    const result = mapped(model(id), metadataModel(id, { reasoning_options }));
    assert.equal(result.capabilities.reasoning, true);
    assert.deepEqual(result.variants, {});
  }
  const result = mapped(
    model(id),
    metadataModel(id, {
      reasoning_options: [{ type: "effort", values: ["low", "xhigh", "xhigh"] }],
    }),
  );
  assert.deepEqual(Object.keys(result.variants), ["low", "xhigh"]);
});

test("missing and invalid price fields are skipped while explicit zero prices survive", () => {
  for (const cost of [
    undefined,
    {},
    { input: 1 },
    { input: -1, output: 5 },
    { input: "1", output: 5 },
  ]) {
    assert.equal(mapped(model(id), metadataModel(id, { cost })).cost, undefined);
  }
  assert.deepEqual(
    mapped(
      model(id),
      metadataModel(id, { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }),
    ).cost,
    { input: 0, output: 0, cache: { read: 0, write: 0 } },
  );
  assert.deepEqual(
    mapped(
      model(id),
      metadataModel(id, { cost: { input: 1, output: 5, cache_read: null, cache_write: -1 } }),
    ).cost,
    { input: 1, output: 5 },
  );
  assert.deepEqual(
    mapped(model(id), metadataModel(id, { cost: { input: 1, output: 5, cache_read: 0.1 } })).cost,
    { input: 1, output: 5, cache: { read: 0.1 } },
  );
});

test("supplementation cannot add generators, bypass API restrictions or replace live modalities", () => {
  const result = buildModels(
    {
      data: [
        model(id, { supported_apis: ["messages"] }),
        model("vendor/generator", { output_modalities: ["image"] }),
        model("vendor/chat", { input_modalities: ["text"], output_modalities: ["text"] }),
      ],
    },
    urls,
    {
      [id]: metadataModel(id),
      "vendor/generator": metadataModel("vendor/generator"),
      "vendor/chat": metadataModel("vendor/chat"),
    },
  );
  assert.deepEqual(Object.keys(result), ["vendor/chat"]);
  assert.equal(result["vendor/chat"].capabilities.input.image, false);
  assert.ok(result["vendor/chat"].cost);
});

async function setup(t) {
  const f = await fixture(t);
  return { ...f, plugin: await ZenMuxPlugin({}, { origin: f.origin, modelsDevOrigin: f.origin }) };
}
const listModels = (f) => f.plugin.provider.models({ models: {} }, { auth: auth() });

for (const [name, status, body] of [
  ["HTTP failure", 503, {}],
  ["malformed response", 200, null],
  ["missing ZenMux provider", 200, { openai: { models: { [id]: metadataModel(id) } } }],
  ["malformed models", 200, { zenmux: { models: [] } }],
  ["empty ZenMux catalog", 200, { zenmux: { models: {} } }],
]) {
  test(`optional models.dev ${name} skips enrichment without blocking discovery or inference`, async (t) => {
    const f = await setup(t);
    f.state.modelsDevStatus = status;
    f.state.modelsDev = body;
    const result = await listModels(f);
    assert.equal(Object.keys(result).length, 4);
    assert.deepEqual(result[id].variants, {});
    assert.equal(result[id].cost, undefined);
    const loader = await f.plugin.auth.loader(async () => auth());
    const response = await loader.fetch(f.origin + "/api/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: id, input: "Hello" }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.ok(
      f.state.calls
        .filter((call) => call.path === "/api.json")
        .every(
          (call) =>
            !call.headers.authorization && !call.headers["x-api-key"] && !call.headers.cookie,
        ),
    );
  });
}

test("failed supplementary reads are retried without poisoning the live model cache", async (t) => {
  const f = await setup(t);
  f.state.modelsDevStatus = 503;
  assert.equal((await listModels(f))[id].cost, undefined);
  f.state.modelsDevStatus = 200;
  assert.equal((await listModels(f))[id].cost.input, 1.25);
  assert.equal(f.state.calls.filter((call) => call.path === "/api/v1/models").length, 1);
  assert.equal(f.state.calls.filter((call) => call.path === "/api.json").length, 2);
});

test(
  "simultaneous model listings share an anonymous supplementary metadata request",
  { timeout: 2000 },
  async (t) => {
    const f = await setup(t);
    const gate = deferred();
    const arrived = deferred();
    t.after(gate.resolve);
    f.state.modelsDevGate = gate.promise;
    f.state.onModelsDev = arrived.resolve;
    const pending = Promise.all(Array.from({ length: 8 }, () => listModels(f)));
    await arrived.promise;
    assert.equal(f.state.calls.filter((call) => call.path === "/api.json").length, 1);
    gate.resolve();
    const results = await pending;
    assert.ok(results.every((result) => result[id].cost.cache.read === 0.125));
    assert.equal(f.state.calls.filter((call) => call.path === "/api/v1/models").length, 1);
    assert.equal(f.state.calls.filter((call) => call.path === "/api.json").length, 1);
  },
);

test("metadata refreshes on its own TTL and is reapplied to the cached live catalog", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const f = await setup(t);
  assert.equal((await listModels(f))[id].cost.input, 1.25);
  f.state.modelsDev.zenmux.models[id].cost.input = 2.5;
  clock += MODEL_TTL + 1;
  assert.equal((await listModels(f))[id].cost.input, 1.25);
  clock += MODEL_METADATA_TTL;
  assert.equal((await listModels(f))[id].cost.input, 2.5);
  assert.equal(f.state.calls.filter((call) => call.path === "/api/v1/models").length, 3);
  assert.equal(f.state.calls.filter((call) => call.path === "/api.json").length, 2);
});
