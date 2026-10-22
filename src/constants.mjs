// Provider and credentials.
export const PROVIDER_ID = "zenmux";
export const PROVIDER_NAME = "ZenMux";
export const PLANS = Object.freeze({
  builder: { name: `${PROVIDER_NAME} Builder Plan`, prefixes: ["sk-ss-v1-", "sk-subs-"] },
  payg: { name: `${PROVIDER_NAME} Pay As You Go`, prefixes: ["sk-ai-v1-", "sk-payg-"] },
});
export const INFERENCE_PREFIXES = [...PLANS.builder.prefixes, ...PLANS.payg.prefixes];
export const MANAGEMENT_PREFIXES = ["sk-mg-v1-", "sk-mgmt-"];
export const KEY_SUFFIX_PATTERN = /^[A-Za-z0-9_-]+$/;

// Upstream protocols and metadata endpoints.
export const ORIGIN = "https://zenmux.ai";
export const MODELS_DEV_ORIGIN = "https://models.dev";
export const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]", "localhost"];
export const PROTOCOLS = {
  messages: { npm: "@ai-sdk/anthropic", basePath: "/api/anthropic/v1", path: "/messages" },
  responses: { npm: "@ai-sdk/openai", basePath: "/api/v1", path: "/responses" },
};
export const API_PATHS = {
  models: "/api/v1/models",
  subscription: "/api/v1/management/subscription/detail",
  balance: "/api/v1/management/payg/balance",
};
export const SIGN_IN_HEADER = "x-magpie-sign-in";
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_BETA_QUERY = "?beta=true";
export const PRIVATE_HEADERS = [
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
];

// Cache lifetimes and request limits; time values are milliseconds.
export const MODEL_TTL = 120_000;
export const MODEL_METADATA_TTL = 30 * 60_000;
export const USAGE_TTL = 30_000;
export const METADATA_TIMEOUT = 10_000;
export const METADATA_CACHE_LIMIT = 64;
export const MAX_CONCURRENCY = 2;

// Model identifiers and capabilities.
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;
export const OPENAI_MODEL_PREFIX = "openai/";
export const MODALITIES = ["text", "image", "audio", "video", "pdf"];

// Subscription reporting; quota window spans are seconds.
export const PLAN_LABELS = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  max: "Max",
  ultra: "Ultra",
};
export const QUOTA_WINDOWS = [
  ["quota_5_hour", "5 hours", 5 * 3600],
  ["quota_7_day", "7 days", 7 * 24 * 3600],
];
export const ACCOUNT_WARNING_STATUSES = ["monitored", "abusive", "suspended", "banned"];
export const DISPLAY_LOCALE = "en-US";
export const FLOW_FORMAT_OPTIONS = { maximumFractionDigits: 3 };
export const BALANCE_FORMAT_OPTIONS = {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
};
