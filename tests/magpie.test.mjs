// Real Magpie CLI, Bun host and HTTP gateway; only invented keys and a local
// upstream. HOME and all XDG directories are isolated from the user's setup.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, KEYS, inferenceCalls, deferred } from "./helpers/fixture.mjs";

const directory = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const locate = (name) => execFileSync("which", [name], { encoding: "utf8" }).trim();

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

function run(binary, args, env, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`magpie ${args.join(" ")} exited ${code}: ${stdout}\n${stderr}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const sseData = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));

for (const kind of ["builder", "payg"])
  test(
    `${kind}: Magpie saves and forwards 164-character keys through native upstream APIs`,
    {
      skip: process.env.MAGPIE_E2E !== "1",
      timeout: 120_000,
    },
    async (t) => {
      const f = await fixture(t);
      const scratch = await mkdtemp(join(tmpdir(), "magpie-zenmux-e2e-"));
      const configRoot = join(scratch, "config");
      const config = join(configRoot, "magpie");
      const home = join(scratch, "home");
      await mkdir(home, { recursive: true });
      await mkdir(config, { recursive: true });
      const port = await unusedPort();
      const binary = locate(process.env.MAGPIE_BIN ?? "magpie");
      // MAGPIE_NO_ACCOUNTS also disables plugin accounts. Instead isolate HOME,
      // all credential paths and PATH, so no real agent CLI or Keychain command
      // can be discovered. Do not inherit the user's tokens or proxy settings.
      const env = {
        HOME: home,
        PATH: join(scratch, "bin"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
        XDG_CONFIG_HOME: configRoot,
        XDG_CACHE_HOME: join(scratch, "cache"),
        XDG_DATA_HOME: join(scratch, "data"),
        XDG_STATE_HOME: join(scratch, "state"),
        MAGPIE_NO_ACCOUNTS: "0",
        MAGPIE_NO_STATS: "1",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
        MAGPIE_PLUGIN_MARKET: "off",
        MAGPIE_ADDR: `127.0.0.1:${port}`,
        MAGPIE_BUN: locate(process.env.MAGPIE_BUN ?? "bun"),
      };
      const cli = (args, input) => run(binary, args, env, input);
      const account = async () => {
        const entries = JSON.parse(await readFile(join(config, "logins.json"), "utf8"));
        return entries.find((entry) => entry.agent === "plugin:zenmux");
      };
      let gateway;
      let log = "";
      t.after(async () => {
        if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
          const closed = once(gateway, "exit");
          gateway.kill();
          await closed;
        }
        await rm(scratch, { recursive: true, force: true });
      });

      await cli(["plugin", "add", directory]);
      await cli([
        "plugin",
        "options",
        directory,
        JSON.stringify({ origin: f.origin, modelsDevOrigin: f.origin }),
      ]);
      const output = await cli(
        ["plugin", "login", "zenmux"],
        `${KEYS.management}\n${KEYS[kind]}\n`,
      );
      assert.match(output, /signed in to ZenMux/);
      const saved = JSON.parse(await readFile(join(config, "plugin-auth.json"), "utf8"));
      assert.deepEqual(Object.keys(saved), ["zenmux"]);
      assert.equal(saved.zenmux.type, "api");
      assert.equal(saved.zenmux.key, KEYS[kind]);
      assert.equal(saved.zenmux.metadata.managementKey, KEYS.management);
      assert.equal(saved.zenmux.metadata.apiKey, undefined);
      const loaded = await cli(["plugin", "--json"]);
      assert.match(loaded, /"id"\s*:\s*"zenmux"/);
      assert.doesNotMatch(loaded, /zenmux-(builder|payg)/);
      assert.match(loaded, /ZenMux API Key \(Builder Plan or Pay As You Go\)/);
      assert.match(loaded, /@ai-sdk\/anthropic/);
      assert.match(loaded, /@ai-sdk\/openai/);
      const info = JSON.parse(loaded).providers.find((entry) => entry.id === "zenmux");
      const enriched = info.models.find((entry) => entry.id === "openai/gpt-fixture");
      assert.deepEqual(enriched.variants, ["low", "medium", "high"]);
      assert.deepEqual(enriched.cost, {
        input: 1.25,
        output: 5,
        cache: { read: 0.125, write: 1.5 },
      });
      const unsynced = info.models.find((entry) => entry.id === "deepseek/chat-fixture");
      assert.deepEqual(unsynced.variants, []);
      assert.equal(unsynced.cost, null);

      gateway = spawn(binary, ["serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
      gateway.stdout.on("data", (chunk) => {
        log += chunk;
      });
      gateway.stderr.on("data", (chunk) => {
        log += chunk;
      });
      const base = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let i = 0; i < 150; i++) {
        if (gateway.exitCode !== null) throw new Error(`Gateway exited: ${log}`);
        try {
          const response = await fetch(base + "/v1/models", { signal: AbortSignal.timeout(1000) });
          const body = await response.json();
          ready =
            response.ok && body.data?.some((entry) => entry.id === "zenmux/openai/gpt-fixture");
          if (ready) break;
        } catch {}
        await delay(100);
      }
      assert.ok(ready, `Gateway did not list the plugin models: ${log}`);
      const catalog = await (
        await fetch(base + "/v1/models", { signal: AbortSignal.timeout(1000) })
      ).json();
      assert.equal(catalog.data.filter((entry) => entry.id.startsWith("zenmux/")).length, 4);
      assert.ok(catalog.data.every((entry) => !/^zenmux-(builder|payg)\//.test(entry.id)));
      const send = async (id, extra = {}, signal) => {
        const response = await fetch(base + "/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": "magpie-client-fixture",
          },
          body: JSON.stringify({
            model: `zenmux/${id}`,
            max_tokens: 2048,
            messages: [{ role: "user", content: "Hello" }],
            ...extra,
          }),
          signal: signal ?? AbortSignal.timeout(15_000),
        });
        return response;
      };

      await t.test("the key type selects the correct quota card under zenmux", async () => {
        const quotas = await cli(["quota", "zenmux", "--json"]);
        if (kind === "builder") {
          assert.match(quotas, /ZenMux Builder Plan Max/);
          assert.match(quotas, /57.2/);
          assert.match(quotas, /"count"\s*:\s*2/i);
          assert.doesNotMatch(quotas, /Pay As You Go/);
        } else {
          assert.match(quotas, /Pay As You Go/);
          assert.match(quotas, /482.74/);
          assert.doesNotMatch(quotas, /Builder Plan/);
        }
        assert.ok(!quotas.includes(KEYS.management));
        assert.ok(!quotas.includes(KEYS.builder));
        assert.ok(!quotas.includes(KEYS.payg));
      });

      for (const id of [
        "anthropic/claude-fixture",
        "openai/gpt-fixture",
        "google/gemini-fixture",
        "deepseek/chat-fixture",
      ]) {
        for (const stream of [false, true]) {
          await t.test(`${kind} ${id}: Agent Messages ${stream ? "SSE" : "JSON"}`, async () => {
            const before = inferenceCalls(f.state).length;
            const response = await send(id, { stream });
            const raw = await response.text();
            assert.equal(response.status, 200, raw);
            if (stream) {
              assert.match(response.headers.get("content-type"), /text\/event-stream/);
              const events = sseData(raw);
              assert.ok(
                events.some((event) => event.type === "message_start"),
                raw,
              );
              assert.ok(
                events.some(
                  (event) => event.type === "content_block_delta" && event.delta?.text === "OK",
                ),
                raw,
              );
              assert.ok(
                events.some((event) => event.type === "message_stop"),
                raw,
              );
            } else {
              const body = JSON.parse(raw);
              assert.equal(body.type, "message");
              assert.equal(body.content[0].text, "OK");
              assert.equal(body.stop_reason, "end_turn");
              assert.equal(body.usage.output_tokens, 3);
            }
            const calls = inferenceCalls(f.state).slice(before);
            assert.equal(calls.length, 1);
            const nativeResponses = id.startsWith("openai/");
            assert.equal(
              calls[0].path,
              nativeResponses ? "/api/v1/responses" : "/api/anthropic/v1/messages",
            );
            assert.equal(
              calls[0].headers[nativeResponses ? "authorization" : "x-api-key"],
              nativeResponses ? `Bearer ${KEYS[kind]}` : KEYS[kind],
            );
            assert.equal(JSON.parse(calls[0].raw).model, id);
            assert.ok(!calls[0].raw.includes(KEYS.management));
          });
        }
      }

      for (const stream of [false, true]) {
        await t.test(
          `OpenAI remains callable through Agent Responses (${stream ? "SSE" : "JSON"})`,
          async () => {
            const before = inferenceCalls(f.state).length;
            const response = await fetch(base + "/v1/responses", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: "zenmux/openai/gpt-fixture",
                input: [{ role: "user", content: "Hello" }],
                max_output_tokens: 2048,
                stream,
              }),
              signal: AbortSignal.timeout(15_000),
            });
            const raw = await response.text();
            assert.equal(response.status, 200, raw);
            if (stream) {
              assert.ok(
                sseData(raw).some((event) => event.type === "response.completed"),
                raw,
              );
            } else {
              const body = JSON.parse(raw);
              assert.equal(body.object, "response");
              assert.equal(body.output[0].content[0].text, "OK");
            }
            const calls = inferenceCalls(f.state).slice(before);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].path, "/api/v1/responses");
            assert.equal(calls[0].headers.authorization, `Bearer ${KEYS[kind]}`);
          },
        );
      }

      for (const id of ["anthropic/claude-fixture", "openai/gpt-fixture"]) {
        for (const stream of [false, true]) {
          await t.test(
            `${id}: tool calls and tool results survive the Messages round trip (${stream ? "SSE" : "JSON"})`,
            async () => {
              const tools = [
                {
                  name: "get_weather",
                  description: "Get weather",
                  input_schema: {
                    type: "object",
                    properties: { city: { type: "string" } },
                    required: ["city"],
                  },
                },
              ];
              const response = await send(id, { tools, stream });
              const raw = await response.text();
              assert.equal(response.status, 200, raw);
              let call;
              if (stream) {
                const events = sseData(raw);
                call = events.find(
                  (event) => event.content_block?.type === "tool_use",
                )?.content_block;
                assert.ok(call, raw);
                const args = events
                  .filter((event) => event.delta?.type === "input_json_delta")
                  .map((event) => event.delta.partial_json)
                  .join("");
                assert.deepEqual(JSON.parse(args), { city: "Shanghai" });
                assert.ok(
                  events.some((event) => event.delta?.stop_reason === "tool_use"),
                  raw,
                );
                call = { ...call, input: JSON.parse(args) };
              } else {
                const body = JSON.parse(raw);
                assert.equal(body.stop_reason, "tool_use");
                call = body.content[0];
                assert.deepEqual(call.input, { city: "Shanghai" });
              }
              assert.equal(call.name, "get_weather");
              const next = await send(id, {
                tools,
                messages: [
                  { role: "user", content: "Weather?" },
                  { role: "assistant", content: [call] },
                  {
                    role: "user",
                    content: [
                      {
                        type: "tool_result",
                        tool_use_id: call.id,
                        content: "weather-result-fixture",
                      },
                    ],
                  },
                ],
              });
              const nextRaw = await next.text();
              assert.equal(next.status, 200, nextRaw);
              assert.equal(JSON.parse(nextRaw).content[0].text, "OK");
              const upstream = JSON.parse(inferenceCalls(f.state).at(-1).raw);
              if (id.startsWith("openai/"))
                assert.ok(
                  upstream.input.some(
                    (item) =>
                      item.type === "function_call_output" &&
                      item.output === "weather-result-fixture",
                  ),
                );
              else assert.equal(upstream.messages.at(-1).content[0].type, "tool_result");
            },
          );
        }
      }

      await t.test("Agent cancellation closes the native upstream connection", async () => {
        f.state.hang = true;
        f.state.reply =
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_cancel","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
        const arrived = deferred(),
          closed = deferred();
        f.state.onInference = arrived.resolve;
        f.state.onClose = closed.resolve;
        const controller = new AbortController();
        const pending = send("anthropic/claude-fixture", { stream: true }, controller.signal).then(
          (response) => response.text(),
        );
        // Attach the rejection handler before aborting so it cannot be unhandled.
        const aborted = assert.rejects(pending);
        await arrived.promise;
        controller.abort();
        await aborted;
        await closed.promise;
        f.state.hang = false;
        f.state.reply = undefined;
        f.state.onInference = f.state.onClose = undefined;
      });

      await t.test("a single-account rate limit returns the upstream error", async () => {
        const before = inferenceCalls(f.state).length;
        f.state.inferenceStatus = 429;
        const response = await send("deepseek/chat-fixture");
        const raw = await response.text();
        assert.equal(response.status, 429, raw);
        const calls = inferenceCalls(f.state).slice(before);
        assert.ok(calls.length >= 1);
        assert.ok(calls.every((call) => call.headers["x-api-key"] === KEYS[kind]));
        assert.equal(JSON.parse(raw).type, "error");
      });

      await t.test(
        "billing and safety errors keep the sign-in, but access_denied expires it",
        async () => {
          for (const [status, type] of [
            [402, "quote_exceeded"],
            [402, "reject_no_credit"],
            [403, "safety_check_failed"],
            [404, "model_not_available"],
          ]) {
            f.state.inferenceStatus = status;
            f.state.inferenceErrorType = type;
            const response = await send("deepseek/chat-fixture");
            const raw = await response.text();
            assert.equal(response.status, status, raw);
            // Magpie normalizes vendor error types into the Agent protocol.
            assert.match(JSON.parse(raw).error.message, /Fixture upstream error/);
            assert.equal((await account()).lapsed, undefined, type);
            assert.equal(response.headers.get("x-magpie-sign-in"), null);
          }
          f.state.inferenceStatus = 403;
          f.state.inferenceErrorType = "access_denied";
          const response = await send("deepseek/chat-fixture");
          assert.equal(response.status, 403, await response.text());
          assert.match((await account()).lapsed ?? "", /sign-in has expired/);
          f.state.inferenceStatus = 200;
          f.state.inferenceErrorType = undefined;
          await cli(["plugin", "login", "zenmux"], `${KEYS.management}\n${KEYS[kind]}\n`);
          assert.equal((await account()).lapsed, undefined);
        },
      );

      await t.test("both key types coexist as accounts of the same zenmux provider", async () => {
        f.state.inferenceStatus = 200;
        const other = kind === "builder" ? "payg" : "builder";
        await cli(["plugin", "login", "zenmux"], `${KEYS.management}\n${KEYS[other]}\n`);
        const accounts = JSON.parse(await readFile(join(config, "plugin-auth.json"), "utf8"));
        assert.equal(Object.keys(accounts).length, 2);
        assert.ok(
          Object.keys(accounts).every((key) => key === "zenmux" || key.startsWith("zenmux#")),
        );
        assert.deepEqual(
          Object.values(accounts)
            .map((credential) => credential.key)
            .toSorted(),
          [KEYS.builder, KEYS.payg].toSorted(),
        );
        const listing = await cli(["plugin", "--json"]);
        assert.match(listing, /"id"\s*:\s*"zenmux"/);
        assert.doesNotMatch(listing, /zenmux-(builder|payg)/);
        const quotas = await cli(["quota", "zenmux", "--json"]);
        assert.match(quotas, /ZenMux Builder Plan Max/);
        assert.match(quotas, /"count"\s*:\s*2/i);
        assert.match(quotas, /Pay As You Go/);
        assert.match(quotas, /482.74/);
        for (const key of Object.values(KEYS)) assert.ok(!quotas.includes(key));
      });

      assert.ok(
        f.state.calls
          .filter((call) => call.path.includes("/management/"))
          .every((call) => call.headers.authorization === `Bearer ${KEYS.management}`),
      );
      assert.ok(
        f.state.calls
          .filter((call) => call.path === "/api.json")
          .every((call) => !call.headers.authorization && !call.headers["x-api-key"]),
      );
      t.diagnostic(
        `Exercised ${kind} on zenmux/: models.dev metadata, automatic key classification, quota cards, native routes, Messages and Responses JSON/SSE, tools, cancellation, sign-in errors and mixed-key accounts.`,
      );
    },
  );
