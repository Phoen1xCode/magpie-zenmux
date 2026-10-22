// /docs/api/platform/subscription-detail.html: usage_percentage is a fraction,
// resets_at is ISO 8601 or null, and quota_monthly has no live usage counter.
import { billingPlan, managementKey } from "./authentication.mjs";
import {
  PROVIDER_NAME,
  USAGE_TTL,
  PLANS,
  PLAN_LABELS,
  QUOTA_WINDOWS,
  ACCOUNT_WARNING_STATUSES,
  DISPLAY_LOCALE,
  FLOW_FORMAT_OPTIONS,
  BALANCE_FORMAT_OPTIONS,
} from "./constants.mjs";
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const flows = (value) => value.toLocaleString(DISPLAY_LOCALE, FLOW_FORMAT_OPTIONS);
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

export function subscriptionDetail(body) {
  if (
    body?.success !== true ||
    !body.data?.plan ||
    typeof body.data.plan.tier !== "string" ||
    !body.data.plan.tier.trim()
  )
    throw new Error("ZenMux returned an unexpected subscription detail response.");
  return body.data;
}

export function quotaCard(detail) {
  const card = {
    plan: `${PLANS.builder.name} ${Object.hasOwn(PLAN_LABELS, detail.plan.tier) ? PLAN_LABELS[detail.plan.tier] : detail.plan.tier}`,
    windows: [],
    signIn: "kept",
  };
  const errors = [];
  if (timestamp(detail.plan.expires_at)) card.until = detail.plan.expires_at;
  const resets = detail.quota_5_hour?.remaining_resets;
  if (Number.isSafeInteger(resets) && resets >= 0) {
    card.resets = {
      count: resets,
      byWindow: true,
      fiveHour: resets,
      weekly: 0,
      ...(card.until ? { until: card.until } : {}),
    };
  } else errors.push("ZenMux did not return a valid remaining reset count.");
  for (const [field, name, span] of QUOTA_WINDOWS) {
    const quota = detail[field];
    if (
      !quota ||
      !number(quota.used_flows) ||
      !number(quota.max_flows) ||
      (quota.usage_percentage != null && !number(quota.usage_percentage))
    ) {
      errors.push(`ZenMux did not return valid ${name} quota usage.`);
      continue;
    }
    const percentage = number(quota.usage_percentage)
      ? quota.usage_percentage * 100
      : quota.max_flows > 0
        ? (quota.used_flows / quota.max_flows) * 100
        : 100;
    if (!Number.isFinite(percentage)) {
      errors.push(`ZenMux returned invalid ${name} quota usage.`);
      continue;
    }
    const window = {
      name,
      used: percentage,
      span,
      amount: quota.used_flows,
      limit: quota.max_flows,
      unit: "Flows",
      display: `${flows(quota.used_flows)} / ${flows(quota.max_flows)} Flows`,
    };
    if (timestamp(quota.resets_at)) window.resetsAt = quota.resets_at;
    card.windows.push(window);
  }
  if (ACCOUNT_WARNING_STATUSES.includes(detail.account_status))
    errors.push(`ZenMux account status: ${detail.account_status}. Check your ZenMux console.`);
  if (errors.length) card.error = errors.join(" ");
  return card;
}

export function paygBalance(body) {
  const value = body?.data?.total_credits;
  if (
    body?.success !== true ||
    typeof body.data?.currency !== "string" ||
    body.data.currency.toLowerCase() !== "usd" ||
    typeof value !== "number" ||
    !Number.isFinite(value)
  )
    throw new Error("ZenMux returned an unexpected PAYG balance response.");
  return body.data;
}

export async function accountUsage(getAuth, urls, read) {
  const auth = await getAuth();
  const status = { plan: PROVIDER_NAME, windows: [], signIn: "kept" };
  let plan;
  try {
    plan = billingPlan(auth);
    status.plan = plan.name;
  } catch (error) {
    return { ...status, signIn: "expired", error: error.message };
  }
  try {
    const key = managementKey(auth.metadata?.managementKey);
    if (!key)
      return {
        ...status,
        error:
          "Add a Management API Key to this account to view quotas or balance. Inference remains available.",
      };
    return plan === PLANS.builder
      ? quotaCard(await read(urls.subscription, key, USAGE_TTL, subscriptionDetail))
      : balanceCard(await read(urls.balance, key, USAGE_TTL, paygBalance));
  } catch (error) {
    // Monitoring credentials do not decide whether inference is signed in.
    return { ...status, error: error.message };
  }
}

export function balanceCard(detail) {
  return {
    // The documented API reports account funds, not a key's spending limit.
    plan: `${PLANS.payg.name} (account balance)`,
    signIn: "kept",
    balance: detail.total_credits.toLocaleString(DISPLAY_LOCALE, BALANCE_FORMAT_OPTIONS),
    windows: [],
  };
}
