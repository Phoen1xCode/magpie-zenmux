import { createServer } from "node:http";
import { once } from "node:events";

export const KEYS = {
  builder: "sk-ss-v1-builder-fixture",
  payg: "sk-ai-v1-payg-fixture",
  management: "sk-mg-v1-management-fixture",
};
export const auth = (kind = "builder", managementKey = KEYS.management) => ({
  type: "api",
  key: KEYS[kind],
  metadata: { managementKey },
});
export const model = (id, extra = {}) => ({
  id,
  display_name: id,
  input_modalities: ["text", "image", "file"],
  output_modalities: ["text"],
  capabilities: { reasoning: true },
  context_length: 200000,
  max_tokens: 32000,
  pricings: {
    prompt: [{ value: 2, unit: "perMTokens", currency: "USD" }],
    completion: [{ value: 8, unit: "perMTokens", currency: "USD" }],
    input_cache_read: [{ value: 0.2, unit: "perMTokens", currency: "USD" }],
  },
  ...extra,
});
export const metadataModel = (id, extra = {}) => ({
  id,
  name: `Catalog ${id}`,
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
  temperature: false,
  tool_call: true,
  modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  limit: { context: 128000, input: 112000, output: 16000 },
  cost: { input: 1.25, output: 5, cache_read: 0.125, cache_write: 1.5 },
  release_date: "2026-01-01",
  ...extra,
});
export const detail = () => ({
  success: true,
  data: {
    plan: { tier: "max", expires_at: "2027-01-01T00:00:00Z" },
    account_status: "healthy",
    quota_5_hour: {
      max_flows: 800,
      used_flows: 57.2,
      usage_percentage: 0.0715,
      remaining_resets: 2,
      resets_at: "2027-01-01T05:00:00Z",
    },
    quota_7_day: { max_flows: 6182, used_flows: 416.11, usage_percentage: 0.0673, resets_at: null },
    quota_monthly: { max_flows: 34560 },
  },
});

const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
export function messagesReply(modelId, tool = false) {
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: modelId,
    content: tool
      ? [{ type: "tool_use", id: "call_fixture", name: "get_weather", input: { city: "Shanghai" } }]
      : [{ type: "text", text: "OK" }],
    stop_reason: tool ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 11,
      output_tokens: 3,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
    },
  };
}
export function messagesStream(modelId, tool = false) {
  const whole = messagesReply(modelId, tool);
  const block = whole.content[0];
  return (
    event("message_start", {
      message: {
        ...whole,
        content: [],
        stop_reason: null,
        usage: { ...whole.usage, output_tokens: 0 },
      },
    }) +
    event("content_block_start", {
      index: 0,
      content_block: tool ? { ...block, input: {} } : { type: "text", text: "" },
    }) +
    event("content_block_delta", {
      index: 0,
      delta: tool
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text: "OK" },
    }) +
    event("content_block_stop", { index: 0 }) +
    event("message_delta", {
      delta: { stop_reason: whole.stop_reason, stop_sequence: null },
      usage: { output_tokens: 3 },
    }) +
    event("message_stop", {})
  );
}
export function responsesReply(modelId, tool = false) {
  return {
    id: "resp_fixture",
    object: "response",
    model: modelId,
    status: "completed",
    output: tool
      ? [
          {
            type: "function_call",
            id: "fc_fixture",
            call_id: "call_fixture",
            name: "get_weather",
            arguments: '{"city":"Shanghai"}',
            status: "completed",
          },
        ]
      : [
          {
            type: "message",
            id: "msg_fixture",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "OK", annotations: [] }],
          },
        ],
    usage: {
      input_tokens: 16,
      output_tokens: 3,
      total_tokens: 19,
      input_tokens_details: { cached_tokens: 5 },
    },
  };
}
export function responsesStream(modelId, tool = false) {
  const whole = responsesReply(modelId, tool);
  const item = whole.output[0];
  let result = event("response.created", {
    response: { ...whole, status: "in_progress", output: [], usage: null },
  });
  result += event("response.output_item.added", {
    output_index: 0,
    item: tool
      ? { ...item, arguments: "", status: "in_progress" }
      : { ...item, content: [], status: "in_progress" },
  });
  if (tool) {
    result += event("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    });
    result += event("response.function_call_arguments.done", {
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    });
  } else {
    result += event("response.content_part.added", {
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    result += event("response.output_text.delta", {
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: "OK",
    });
    result += event("response.output_text.done", {
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      text: "OK",
    });
    result += event("response.content_part.done", {
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      part: item.content[0],
    });
  }
  return (
    result +
    event("response.output_item.done", { output_index: 0, item }) +
    event("response.completed", { response: whole })
  );
}

export async function fixture(t) {
  const state = {
    calls: [],
    catalog: {
      data: [
        model("anthropic/claude-fixture"),
        model("openai/gpt-fixture"),
        model("google/gemini-fixture"),
        model("deepseek/chat-fixture"),
        model("image/generator", { output_modalities: ["image"] }),
      ],
    },
    modelsDev: {
      zenmux: {
        models: Object.fromEntries(
          ["anthropic/claude-fixture", "openai/gpt-fixture", "google/gemini-fixture"].map((id) => [
            id,
            metadataModel(id),
          ]),
        ),
      },
    },
    modelsDevStatus: 200,
    detail: detail(),
    balance: { success: true, data: { currency: "usd", total_credits: 482.74 } },
    catalogStatus: 200,
    detailStatus: 200,
    balanceStatus: 200,
    inferenceStatus: 200,
  };
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const path = new URL(req.url, "http://fixture").pathname;
      state.calls.push({ path, url: req.url, headers: req.headers, raw });
      const json = (body, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (path === "/api.json") {
        state.onModelsDev?.();
        await state.modelsDevGate;
        return json(state.modelsDev, state.modelsDevStatus);
      }
      if (path === "/api/v1/models") {
        state.onCatalog?.();
        await state.catalogGate;
        return json(state.catalog, state.catalogStatus);
      }
      if (
        path === "/api/v1/management/subscription/detail" ||
        path === "/api/v1/management/payg/balance"
      ) {
        state.onManagement?.();
        await state.managementGate;
        return path.endsWith("/detail")
          ? json(state.detail, state.detailStatus)
          : json(state.balance, state.balanceStatus);
      }
      if (!["/api/anthropic/v1/messages", "/api/v1/responses"].includes(path))
        return json({ error: "not found" }, 404);
      state.onInference?.();
      // Bun emits the socket close on abort, but not ServerResponse.close.
      if (state.onClose) req.socket.once("close", state.onClose);
      if (state.redirect) {
        res.writeHead(307, { location: state.redirect });
        return res.end();
      }
      const body = JSON.parse(raw);
      if (state.inferenceStatus !== 200) {
        res.setHeader("retry-after", "30");
        if (state.inferenceRaw !== undefined) {
          res.writeHead(state.inferenceStatus, { "content-type": "text/plain" });
          return res.end(state.inferenceRaw);
        }
        return json(
          {
            type: "error",
            error: {
              code: String(state.inferenceStatus),
              type: state.inferenceErrorType ?? "rate_limit_error",
              message: "Fixture upstream error",
            },
          },
          state.inferenceStatus,
        );
      }
      const responses = path.endsWith("/responses");
      const tool =
        body.tools?.length > 0 && !JSON.stringify(body).includes("weather-result-fixture");
      if (!body.stream)
        return json(responses ? responsesReply(body.model, tool) : messagesReply(body.model, tool));
      res.writeHead(200, { "content-type": "text/event-stream", "x-zenmux-fixture": "yes" });
      res.write(
        state.reply ??
          (responses ? responsesStream(body.model, tool) : messagesStream(body.model, tool)),
      );
      if (!state.hang) res.end();
    } catch (error) {
      state.error = error;
      res.destroy(error);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
    if (state.error) throw state.error;
  });
  return { state, origin: `http://127.0.0.1:${server.address().port}` };
}

export const inferenceCalls = (state) =>
  state.calls.filter((call) => /\/(messages|responses)$/.test(call.path));
export const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
