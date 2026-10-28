import {
  PLANS,
  PROVIDER_NAME,
  INFERENCE_PREFIXES,
  MANAGEMENT_PREFIX,
  KEY_LENGTH,
  KEY_SUFFIX_PATTERN,
} from "./constants.mjs";

function readKey(value, prefixes, label) {
  const key = typeof value === "string" ? value.trim() : "";
  if (
    key.length !== KEY_LENGTH ||
    !prefixes.some(
      (prefix) => key.startsWith(prefix) && KEY_SUFFIX_PATTERN.test(key.slice(prefix.length)),
    )
  )
    throw new Error(
      `Enter a ${KEY_LENGTH}-character ${label} starting with ${prefixes.join(" or ")}.`,
    );
  return key;
}

export function inferenceKey(auth) {
  try {
    if (auth?.type !== "api") throw new Error("Sign in with an API key.");
    return readKey(auth.key, INFERENCE_PREFIXES, "ZenMux inference API Key");
  } catch (error) {
    error.signIn = "expired";
    throw error;
  }
}

export function billingPlan(auth) {
  const key = inferenceKey(auth);
  return Object.values(PLANS).find((plan) => key.startsWith(plan.prefix));
}

export function managementKey(value) {
  if (value == null || (typeof value === "string" && !value.trim())) return "";
  return readKey(value, [MANAGEMENT_PREFIX], "Management API Key");
}

export function signInMethod() {
  return {
    type: "api",
    label: `${PROVIDER_NAME} API Key (Builder Plan or Pay As You Go)`,
    placeholder: `${PLANS.builder.prefix}... or ${PLANS.payg.prefix}...`,
    prompts: [
      {
        type: "password",
        key: "managementKey",
        message: "Management API Key (optional, only for quotas or balance; leave blank to skip)",
        placeholder: `${MANAGEMENT_PREFIX}...`,
        validate(value) {
          try {
            managementKey(value);
          } catch (error) {
            return error.message;
          }
        },
      },
    ],
  };
}
