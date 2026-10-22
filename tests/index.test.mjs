import test from "node:test";
import assert from "node:assert/strict";
import * as pluginExports from "magpie-zenmux";
import { inferenceKey, billingPlan, managementKey } from "../src/authentication.mjs";
import { endpoints, metadataClient } from "../src/api.mjs";
import { PLANS, MODEL_TTL, USAGE_TTL } from "../src/constants.mjs";
import { buildModels } from "../src/models.mjs";
import { quotaCard, subscriptionDetail, paygBalance, balanceCard } from "../src/usage.mjs";
import {
  fixture,
  auth,
  KEYS,
  model,
  detail,
  deferred,
  inferenceCalls,
} from "./helpers/fixture.mjs";

const { ZenMuxPlugin } = pluginExports;
async function setup(t) {
  const f = await fixture(t);
  return {
    ...f,
    plugin: await ZenMuxPlugin({}, { origin: f.origin, modelsDevOrigin: f.origin }),
  };
}

test("exports one ZenMux plugin with one auto-detecting API key method", async () => {
  assert.deepEqual(Object.keys(pluginExports), ["ZenMuxPlugin"]);
  const plugin = await ZenMuxPlugin({});
  assert.equal(plugin.auth.provider, "zenmux");
  assert.equal(plugin.provider.id, "zenmux");
  assert.deepEqual(
    plugin.auth.methods.map((method) => method.label),
    ["ZenMux API Key (Builder Plan or Pay As You Go)"],
  );
});
async function send(
  f,
  { credential = auth(), id = "anthropic/claude-fixture", body = {}, init = {} } = {},
) {
  const loader = await f.plugin.auth.loader(async () => credential);
  return loader.fetch(
    f.origin + (id.startsWith("openai/") ? "/api/v1/responses" : "/api/anthropic/v1/messages"),
    {
      method: "POST",
      body: JSON.stringify({
        model: id,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        ...body,
      }),
      ...init,
    },
  );
}

for (const kind of ["builder", "payg"]) {
  test(`${kind}: standard API key form uses the host key field and an optional management prompt`, async () => {
    const plugin = await ZenMuxPlugin({});
    const [method] = plugin.auth.methods;
    assert.equal(method.type, "api");
    assert.equal(method.keyless, undefined);
    assert.equal(method.authorize, undefined);
    for (const plan of Object.values(PLANS))
      assert.ok(method.placeholder.includes(plan.prefixes[0]));
    assert.deepEqual(
      method.prompts.map((p) => [p.type, p.key]),
      [["password", "managementKey"]],
    );
    for (const value of [undefined, "", "   ", KEYS.management, "sk-mgmt-fixture"]) {
      assert.equal(method.prompts[0].validate(value), undefined);
    }
    assert.match(method.prompts[0].validate(KEYS[kind]), /Management API Key/);
  });

  test(`${kind}: config uses Messages by default without overwriting user settings`, async () => {
    const plugin = await ZenMuxPlugin({});
    const config = { provider: { unrelated: { name: "Keep" } } };
    await plugin.config(config);
    assert.deepEqual(Object.keys(config.provider).toSorted(), ["unrelated", "zenmux"]);
    assert.equal(config.provider.zenmux.npm, "@ai-sdk/anthropic");
    assert.deepEqual(config.provider.zenmux.models, {});
    config.provider.zenmux.name = "My name";
    await plugin.config(config);
    assert.equal(config.provider.zenmux.name, "My name");
    assert.equal(config.provider.unrelated.name, "Keep");
    assert.equal(plugin.auth.provider, "zenmux");
    assert.equal(plugin.auth.maxConcurrency, 2);
  });

  test(`${kind}: discovers only conversation models and declares per-model native APIs`, async (t) => {
    const f = await setup(t);
    const listed = await f.plugin.provider.models({ models: {} }, { auth: auth(kind) });
    assert.equal(Object.keys(listed).length, 4);
    for (const [id, entry] of Object.entries(listed)) {
      assert.equal(
        entry.api.npm,
        id.startsWith("openai/") ? "@ai-sdk/openai" : "@ai-sdk/anthropic",
      );
      assert.equal(
        entry.api.url,
        f.origin + (id.startsWith("openai/") ? "/api/v1" : "/api/anthropic/v1"),
      );
      assert.equal(entry.capabilities.input.pdf, true);
      assert.equal(entry.limit.context, 200000);
      assert.equal(entry.providerID, "zenmux");
      if (id === "deepseek/chat-fixture") {
        assert.equal(entry.cost, undefined);
        assert.deepEqual(entry.variants, {});
      } else {
        assert.deepEqual(entry.cost, {
          input: 1.25,
          output: 5,
          cache: { read: 0.125, write: 1.5 },
        });
        assert.deepEqual(Object.keys(entry.variants), ["low", "medium", "high"]);
      }
    }
    const loader = await f.plugin.auth.loader(async () => auth(kind));
    assert.equal(loader.baseURL, undefined, "loader must not override a model's URL");
    assert.ok(
      f.state.calls.every(
        (call) =>
          ["/api/v1/models", "/api.json"].includes(call.path) &&
          !call.headers.authorization &&
          !call.headers["x-api-key"],
      ),
    );
  });
}

test("key validation accepts both billing modes and rejects malformed or management keys", () => {
  for (const kind of ["builder", "payg"]) {
    for (const key of [
      KEYS.management,
      "sk-mgmt-fixture",
      "sk-ss-v1-",
      "sk-ai-v1-",
      123,
      null,
      KEYS[kind] + "\r\nheader",
    ]) {
      assert.throws(() => inferenceKey({ type: "api", key }), { signIn: "expired" });
      assert.throws(() => billingPlan({ type: "api", key }), { signIn: "expired" });
    }
    for (const prefix of PLANS[kind].prefixes) {
      const credential = {
        type: "api",
        key: ` ${prefix}fixture `,
        metadata: { billingMode: "ignored-legacy-value" },
      };
      assert.equal(inferenceKey(credential), prefix + "fixture");
      assert.equal(billingPlan(credential), PLANS[kind]);
    }
  }
  assert.throws(() => inferenceKey({ type: "oauth", key: KEYS.builder }));
  for (const key of [KEYS.builder, KEYS.payg, "sk-mg-v1-", {}, "sk-random-fixture"])
    assert.throws(() => managementKey(key));
});

test("protocol selection covers future model IDs, excludes non-conversations and respects explicit API restrictions", () => {
  const catalog = {
    data: [
      model("openai/future-new-model"),
      model("anthropic/future-model"),
      model("vendor/future-model"),
      model("vendor/multimodal-generator", { output_modalities: ["text", "image"] }),
      model("openai/unsupported", { supported_apis: ["messages"] }),
      model("vendor/chat-only", { supported_apis: ["chat.completions"] }),
      model("vendor/no-apis", { supported_apis: [] }),
      model("vendor/restricted", {
        capabilities: { tool_call: false, reasoning: false, temperature: false },
        context_length: 1000,
        max_tokens: 2000,
      }),
      model("__proto__"),
      null,
      model("no-namespace"),
    ],
  };
  const result = buildModels(catalog, endpoints());
  assert.deepEqual(Object.keys(result), [
    "openai/future-new-model",
    "anthropic/future-model",
    "vendor/future-model",
    "vendor/restricted",
  ]);
  assert.equal(result["vendor/restricted"].capabilities.toolcall, false);
  assert.equal(result["vendor/restricted"].capabilities.reasoning, false);
  assert.equal(result["vendor/restricted"].capabilities.temperature, false);
  assert.equal(result["vendor/restricted"].limit.output, 1000);
  assert.throws(() => buildModels({ data: [null] }, endpoints()), /no valid/);
  assert.throws(() => buildModels({}, endpoints()), /unexpected format/);
  assert.deepEqual(Object.keys(buildModels({ data: [] }, endpoints())), []);
});

for (const first of ["builder", "payg"]) {
  test(`${first} first: both key types share the same model metadata and reference prices`, async (t) => {
    const f = await setup(t);
    const second = first === "builder" ? "payg" : "builder";
    const listings = await Promise.all(
      [first, second].map((kind) => f.plugin.provider.models({ models: {} }, { auth: auth(kind) })),
    );
    assert.deepEqual(listings[0], listings[1]);
    assert.equal(f.state.calls.length, 2, "one live catalog and one supplementary catalog");
    assert.equal(listings[0]["openai/gpt-fixture"].cost.input, 1.25);
    assert.equal(listings[0]["deepseek/chat-fixture"].cost, undefined);
    for (const entry of Object.values(listings[0])) assert.equal(entry.providerID, "zenmux");
  });
}

test("catalog failure surfaces for host fallback, and never becomes an inference prerequisite", async (t) => {
  const f = await setup(t);
  f.state.catalogStatus = 503;
  await assert.rejects(() => f.plugin.provider.models({ models: {} }, { auth: auth() }), /503/);
  const response = await send(f);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(f.state.calls.filter((call) => call.path === "/api/v1/models").length, 1);
  assert.equal(inferenceCalls(f.state).length, 1);
  f.state.catalogStatus = 200;
  assert.equal(
    Object.keys(await f.plugin.provider.models({ models: {} }, { auth: auth() })).length,
    4,
  );
});

for (const kind of ["builder", "payg"]) {
  for (const id of [
    "anthropic/claude-fixture",
    "openai/gpt-fixture",
    "google/gemini-fixture",
    "deepseek/chat-fixture",
  ]) {
    test(`${kind}: ${id} preserves request bytes, tools, reasoning, streaming and credential separation`, async (t) => {
      const f = await setup(t);
      const responses = id.startsWith("openai/");
      const body = responses
        ? {
            model: id,
            stream: true,
            input: [{ role: "user", content: "Hi" }],
            reasoning: { effort: "high" },
            tools: [{ type: "function", name: "get_weather", parameters: { type: "object" } }],
          }
        : {
            model: id,
            stream: true,
            max_tokens: 2048,
            thinking: { type: "enabled", budget_tokens: 1024 },
            system: [{ type: "text", text: "Be helpful", cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: "Hi" }],
            tools: [{ name: "get_weather", input_schema: { type: "object" } }],
          };
      const raw = JSON.stringify(body, null, 2);
      const loader = await f.plugin.auth.loader(async () => auth(kind));
      const path = responses ? "/api/v1/responses" : "/api/anthropic/v1/messages?beta=true";
      const response = await loader.fetch(
        new Request(f.origin + path, {
          method: "POST",
          body: raw,
          headers: {
            authorization: "Bearer client-secret",
            "x-api-key": "client-secret",
            "x-goog-api-key": "other-secret",
            cookie: "client=session",
            "proxy-authorization": "Basic secret",
            "anthropic-beta": "test-beta",
            "anthropic-version": "2023-06-01",
          },
        }),
      );
      assert.equal(response.headers.get("x-zenmux-fixture"), "yes");
      assert.match(
        await response.text(),
        responses ? /response.function_call_arguments.delta/ : /input_json_delta/,
      );
      const [call] = inferenceCalls(f.state);
      assert.equal(call.raw, raw);
      assert.equal(
        call.headers[responses ? "authorization" : "x-api-key"],
        responses ? `Bearer ${KEYS[kind]}` : KEYS[kind],
      );
      assert.equal(call.headers[responses ? "x-api-key" : "authorization"], undefined);
      for (const name of ["x-goog-api-key", "cookie", "proxy-authorization"])
        assert.equal(call.headers[name], undefined);
      assert.equal(call.headers["anthropic-beta"], "test-beta");
      assert.ok(!JSON.stringify(call).includes(KEYS.management));
      assert.equal(f.state.calls.length, 1, "no metadata dependency on the inference path");
    });
  }
}

for (const status of [400, 401, 402, 403, 404, 422, 429, 500, 503]) {
  test(`HTTP ${status} and Retry-After pass through without retries or a billing fallback`, async (t) => {
    const f = await setup(t);
    f.state.inferenceStatus = status;
    const response = await send(f);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("retry-after"), "30");
    assert.equal((await response.json()).error.message, "Fixture upstream error");
    assert.equal(inferenceCalls(f.state).length, 1);
    assert.equal(inferenceCalls(f.state)[0].headers["x-api-key"], KEYS.builder);
  });
}

for (const id of ["anthropic/claude-fixture", "openai/gpt-fixture"]) {
  for (const type of ["access_denied", "safety_check_failed", "unknown_error"]) {
    test(`${id}: 403 ${type} preserves the error and reports the correct sign-in state`, async (t) => {
      const f = await setup(t);
      f.state.inferenceStatus = 403;
      f.state.inferenceErrorType = type;
      const response = await send(f, { id });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("retry-after"), "30");
      assert.equal(
        response.headers.get("x-magpie-sign-in"),
        type === "access_denied" ? "expired" : "kept",
      );
      assert.deepEqual((await response.json()).error, {
        code: "403",
        type,
        message: "Fixture upstream error",
      });
      assert.equal(inferenceCalls(f.state).length, 1);
    });
  }
}

test("an unparseable 403 is passed through without assuming the inference key expired", async (t) => {
  const f = await setup(t);
  f.state.inferenceStatus = 403;
  for (const raw of ["<!doctype html>Proxy denied", "not JSON", "null", "{}"]) {
    f.state.inferenceRaw = raw;
    const response = await send(f);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("x-magpie-sign-in"), "kept");
    assert.equal(response.headers.get("retry-after"), "30");
    assert.equal(await response.text(), raw);
  }
  assert.equal(inferenceCalls(f.state).length, 4);
});

test("rejects other URLs, protocol mismatches and malformed requests before credentials leave", async (t) => {
  const f = await setup(t);
  const loader = await f.plugin.auth.loader(async () => auth());
  for (const url of [
    "https://example.com/api/anthropic/v1/messages",
    f.origin + "/api/v1/management/subscription/detail",
    f.origin + "/api/v1/chat/completions",
    f.origin + "/api/anthropic/v1/messages?other=true",
    f.origin + "/api/anthropic/v1/messages#fragment",
  ])
    await assert.rejects(() => loader.fetch(url, { method: "POST", body: "{}" }), /unexpected/);
  for (const [path, body] of [
    ["/api/anthropic/v1/messages", { model: "openai/gpt-fixture" }],
    ["/api/v1/responses", { model: "anthropic/claude-fixture" }],
  ]) {
    await assert.rejects(
      () => loader.fetch(f.origin + path, { method: "POST", body: JSON.stringify(body) }),
      /mismatch/,
    );
  }
  for (const raw of ["null", "{}", "[]", '{"model":"bad"}', "not JSON"]) {
    await assert.rejects(
      () => loader.fetch(f.origin + "/api/anthropic/v1/messages", { method: "POST", body: raw }),
      /expects/,
    );
  }
  await assert.rejects(() => loader.fetch(f.origin + "/api/anthropic/v1/messages"), /unexpected/);
  assert.equal(f.state.calls.length, 0);
});

test("does not follow an upstream redirect with inference credentials", async (t) => {
  const f = await setup(t);
  f.state.redirect = f.origin + "/redirect-target";
  await assert.rejects(() => send(f));
  assert.equal(f.state.calls.length, 1);
});

test("reads the current auth before each request without pinning a billing mode", async (t) => {
  const f = await setup(t);
  let current = auth();
  const loader = await f.plugin.auth.loader(async () => current);
  current = { ...current, key: "sk-ss-v1-rotated-fixture" };
  const request = () =>
    loader.fetch(f.origin + "/api/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "anthropic/claude-fixture" }),
    });
  await (await request()).text();
  assert.equal(inferenceCalls(f.state)[0].headers["x-api-key"], current.key);
  current = auth("payg");
  await (await request()).text();
  assert.equal(inferenceCalls(f.state).at(-1).headers["x-api-key"], KEYS.payg);
  current = { type: "api", key: KEYS.management };
  await assert.rejects(request, { signIn: "expired" });
  assert.equal(inferenceCalls(f.state).length, 2);
});

test("honors cancellation before sending and while consuming a response stream", async (t) => {
  const f = await setup(t);
  await assert.rejects(() => send(f, { init: { signal: AbortSignal.abort() } }));
  assert.equal(f.state.calls.length, 0);
  const controller = new AbortController();
  f.state.hang = true;
  const response = await send(f, { init: { signal: controller.signal } });
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  controller.abort();
  await assert.rejects(() => reader.read());
  // Actual socket closure is asserted by the Node-backed gateway E2E test.
  // Bun's node:http server shim loses close events after consuming a POST body.
});

test("usage maps fractional quotas, reset attempts and natural reset times without inventing monthly remaining", () => {
  const card = quotaCard(subscriptionDetail(detail()));
  assert.ok(Math.abs(card.windows[0].used - 7.15) < 1e-9);
  assert.equal(card.windows[0].amount, 57.2);
  assert.equal(card.windows[0].limit, 800);
  assert.equal(card.windows[0].unit, "Flows");
  assert.equal(card.windows[0].span, 18000);
  assert.equal(card.windows[1].span, 604800);
  assert.equal(card.windows[1].resetsAt, undefined);
  assert.deepEqual(card.resets, {
    count: 2,
    byWindow: true,
    fiveHour: 2,
    weekly: 0,
    until: "2027-01-01T00:00:00Z",
  });
  assert.equal(card.balance, undefined);
  assert.equal(card.windows.length, 2);
  assert.equal(card.error, undefined);
  assert.equal(card.signIn, "kept");
});

test("zero and missing reset counts stay distinct, partial bad monitoring data does not look healthy", () => {
  const data = detail().data;
  data.quota_5_hour.remaining_resets = 0;
  data.quota_5_hour.resets_at = null;
  assert.equal(quotaCard(data).resets.count, 0);
  for (const count of [undefined, null, -1, 1.5, "2", NaN]) {
    data.quota_5_hour.remaining_resets = count;
    const card = quotaCard(data);
    assert.equal(card.resets, undefined);
    assert.match(card.error, /reset count/);
  }
  data.quota_7_day.used_flows = "0";
  data.account_status = "suspended";
  const card = quotaCard(data);
  assert.equal(card.windows.length, 1);
  assert.match(card.error, /7 days/);
  assert.match(card.error, /suspended/);
  assert.equal(card.signIn, "kept");
  assert.throws(() => subscriptionDetail({ success: true, data: { plan: { tier: "" } } }));
});

test("quota ratios handle absent percentages, zero limits and overspending honestly", () => {
  const data = detail().data;
  delete data.quota_5_hour.usage_percentage;
  data.quota_5_hour.used_flows = 110;
  data.quota_5_hour.max_flows = 100;
  assert.ok(Math.abs(quotaCard(data).windows[0].used - 110) < 1e-9);
  data.quota_5_hour.max_flows = 0;
  assert.equal(quotaCard(data).windows[0].used, 100);
  data.plan.expires_at = "invalid";
  assert.equal(quotaCard(data).resets.until, undefined);
});

test("balance is account USD funds, permits debt and does not turn missing data into zero", () => {
  for (const amount of [482.74, 0, -1.25]) {
    const card = balanceCard(
      paygBalance({ success: true, data: { currency: "usd", total_credits: amount } }),
    );
    assert.match(card.plan, /account balance/);
    assert.ok(card.balance.includes("$"));
    assert.deepEqual(card.windows, []);
  }
  for (const data of [
    {},
    { currency: 1, total_credits: 0 },
    { currency: "usd", total_credits: "0" },
    { currency: "cny", total_credits: 0 },
  ]) {
    assert.throws(() => paygBalance({ success: true, data }), /unexpected PAYG/);
  }
});

for (const kind of ["builder", "payg"]) {
  test(`${kind}: usage only calls its management endpoint and coalesces concurrent reads`, async (t) => {
    const f = await setup(t);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => f.plugin.auth.usage(async () => auth(kind))),
    );
    assert.ok(results.every((result) => !result.error && result.signIn === "kept"));
    assert.equal(f.state.calls.length, 1);
    assert.equal(
      f.state.calls[0].path,
      kind === "builder"
        ? "/api/v1/management/subscription/detail"
        : "/api/v1/management/payg/balance",
    );
    assert.equal(f.state.calls[0].headers.authorization, `Bearer ${KEYS.management}`);
    await f.plugin.auth.usage(async () => auth(kind));
    assert.equal(f.state.calls.length, 1);
    await f.plugin.auth.usage(async () => auth(kind, "sk-mg-v1-second-fixture"));
    assert.equal(f.state.calls.length, 2);
  });

  test(`${kind}: missing, wrong or failing management credentials never disable inference`, async (t) => {
    const f = await setup(t);
    f.state.detailStatus = f.state.balanceStatus = 401;
    for (const management of ["", KEYS[kind], KEYS.management]) {
      const credential = auth(kind, management);
      const usage = await f.plugin.auth.usage(async () => credential);
      assert.equal(usage.signIn, "kept");
      assert.ok(usage.error);
      assert.ok(!usage.error.includes(KEYS.management));
      const response = await send(f, { credential });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal(inferenceCalls(f.state).length, 3);
    const invalid = await f.plugin.auth.usage(async () => ({ type: "api", key: KEYS.management }));
    assert.equal(invalid.signIn, "expired");
  });
}

test("monitoring failures explain credential rejection or rate limits without leaking keys", async (t) => {
  const f = await setup(t);
  for (const kind of ["builder", "payg"]) {
    for (const status of [401, 403, 422, 429]) {
      f.state.detailStatus = f.state.balanceStatus = status;
      const card = await f.plugin.auth.usage(async () => auth(kind));
      assert.equal(card.signIn, "kept");
      assert.match(card.error, new RegExp(`HTTP ${status}`));
      assert.match(card.error, /Inference remains available/);
      assert.match(card.error, [401, 403].includes(status) ? /Management API Key/ : /rate limited/);
      for (const key of Object.values(KEYS)) assert.ok(!card.error.includes(key));
    }
  }
  assert.equal(f.state.calls.length, 8, "failed reads must not be cached");
});

test("mixed-key loaders use their own credentials on the shared provider", async (t) => {
  const f = await setup(t);
  const loaders = await Promise.all(
    ["builder", "payg"].map((kind) => f.plugin.auth.loader(async () => auth(kind))),
  );
  const responses = await Promise.all(
    loaders.map((loader) =>
      loader.fetch(f.origin + "/api/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "anthropic/claude-fixture" }),
      }),
    ),
  );
  await Promise.all(responses.map((response) => response.text()));
  assert.deepEqual(
    inferenceCalls(f.state)
      .map((call) => call.headers["x-api-key"])
      .toSorted(),
    [KEYS.builder, KEYS.payg].toSorted(),
  );
});

test("mixed-key usage keeps subscription and balance caches separate without borrowing credentials", async (t) => {
  const f = await setup(t);
  const [builder, payg] = await Promise.all(
    ["builder", "payg"].map((kind) => f.plugin.auth.usage(async () => auth(kind))),
  );
  assert.equal(builder.resets.count, 2);
  assert.equal(builder.balance, undefined);
  assert.equal(payg.balance, "$482.74");
  assert.equal(payg.resets, undefined);
  assert.deepEqual(f.state.calls.map((call) => call.path).toSorted(), [
    "/api/v1/management/payg/balance",
    "/api/v1/management/subscription/detail",
  ]);
  await Promise.all(["builder", "payg"].map((kind) => f.plugin.auth.usage(async () => auth(kind))));
  assert.equal(f.state.calls.length, 2);
  const missing = await f.plugin.auth.usage(async () => auth("payg", ""));
  assert.match(missing.error, /Add a Management API Key/);
  assert.equal(f.state.calls.length, 2);
  await f.plugin.auth.usage(async () => auth("payg", "sk-mg-v1-other-account"));
  assert.equal(f.state.calls.at(-1).headers.authorization, "Bearer sk-mg-v1-other-account");
  assert.equal(f.state.calls.length, 3);
});

test("metadata cache expires, coalesces, isolates endpoints and does not cache failures", async (t) => {
  const f = await fixture(t);
  let clock = 0;
  const read = metadataClient({ now: () => clock });
  const url = f.origin + "/api/v1/models";
  const parse = (body) => buildModels(body, endpoints({ origin: f.origin }));
  await Promise.all(Array.from({ length: 8 }, () => read(url, "", MODEL_TTL, parse)));
  assert.equal(f.state.calls.length, 1);
  clock = MODEL_TTL - 1;
  await read(url, "", MODEL_TTL, parse);
  assert.equal(f.state.calls.length, 1);
  clock++;
  f.state.catalogStatus = 503;
  await assert.rejects(() => read(url, "", MODEL_TTL, parse), /503/);
  f.state.catalogStatus = 200;
  await read(url, "", MODEL_TTL, parse);
  assert.equal(f.state.calls.length, 3);
  const balance = f.origin + "/api/v1/management/payg/balance";
  await read(balance, KEYS.management, USAGE_TTL, paygBalance);
  clock += USAGE_TTL;
  await read(balance, KEYS.management, USAGE_TTL, paygBalance);
  assert.equal(f.state.calls.length, 5);
});

test("catalog reads coalesce and malformed catalogs do not poison the cache", async (t) => {
  const f = await setup(t);
  f.state.catalog = { wrong: [] };
  await assert.rejects(() => f.plugin.provider.models({ models: {} }, { auth: auth() }), /format/);
  f.state.catalog = { data: [model("openai/new-model")] };
  const listed = await Promise.all(
    Array.from({ length: 4 }, () => f.plugin.provider.models({ models: {} }, { auth: auth() })),
  );
  assert.ok(listed.every((result) => result["openai/new-model"]));
  assert.equal(f.state.calls.filter((call) => call.path === "/api/v1/models").length, 2);
  assert.equal(f.state.calls.filter((call) => call.path === "/api.json").length, 1);
});

test("metadata timeouts are bounded and diagnostics do not expose credentials", async (t) => {
  const f = await fixture(t);
  const gate = deferred();
  f.state.managementGate = gate.promise;
  t.after(gate.resolve);
  const read = metadataClient({ timeout: 30 });
  await assert.rejects(
    () =>
      read(
        f.origin + "/api/v1/management/subscription/detail",
        KEYS.management,
        USAGE_TTL,
        subscriptionDetail,
      ),
    (error) => {
      assert.match(error.message, /timeout/);
      assert.ok(!error.message.includes(KEYS.management));
      return true;
    },
  );
});

test("options reject insecure/non-origin URLs and obsolete global protocol settings", () => {
  for (const origin of [
    "http://example.com",
    "https://user:pass@zenmux.ai",
    "https://zenmux.ai/api",
    "https://zenmux.ai?token=secret",
    "file:///tmp/a",
  ]) {
    assert.throws(() => endpoints({ origin }));
    assert.throws(() => endpoints({ modelsDevOrigin: origin }));
  }
  assert.throws(() => endpoints({ protocol: "responses" }), /Routing is automatic/);
  assert.equal(endpoints().messages.url, "https://zenmux.ai/api/anthropic/v1");
  assert.equal(endpoints().modelsDev, "https://models.dev/api.json");
});
