import {
  ErrorCodes,
  JesutobitsError,
  type JesutobitsErrorCode,
  type ProviderError,
  type ProviderErrorCategory,
  type UserAction,
} from "@jesutobits/protocol";

/** Categories worth another attempt (AGENT_HARNESS.md section 2.5). */
const RETRYABLE: ReadonlySet<ProviderErrorCategory> = new Set([
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "network",
]);

export function providerError(
  category: ProviderErrorCategory,
  message: string,
  extra: Partial<Omit<ProviderError, "category" | "message">> = {},
): ProviderError {
  return { category, message, retryable: RETRYABLE.has(category), ...extra };
}

/** Phrases providers use for an over-long prompt, whatever status they send it with. */
const CONTEXT_LENGTH =
  /context (?:length|window)|maximum context|too many tokens|prompt is too long/i;

/**
 * Maps an HTTP failure to a category (FR-025). `message` is the provider's own text, which
 * may be shown; it never contains the key, which travels only in a request header.
 */
export function errorFromHttp(
  status: number,
  details: { message?: string; providerErrorType?: string; retryAfterMs?: number } = {},
): ProviderError {
  const text = details.message?.trim() || `HTTP ${status}`;
  const extra = {
    httpStatus: status,
    ...(details.providerErrorType !== undefined && {
      providerErrorType: details.providerErrorType,
    }),
    ...(details.retryAfterMs !== undefined && { retryAfterMs: details.retryAfterMs }),
  };
  if (CONTEXT_LENGTH.test(text) || status === 413) {
    return providerError("context_length", text, extra);
  }
  switch (status) {
    case 400:
    case 404:
    case 422:
      return providerError("invalid_request", text, extra);
    case 401:
      return providerError("auth", text, extra);
    case 402:
      return providerError("insufficient_credits", text, extra);
    case 403:
      // OpenRouter answers 403 when moderation flagged the input.
      return providerError("content_filter", text, extra);
    case 408:
    case 504:
      return providerError("timeout", text, extra);
    case 429:
      return providerError("rate_limited", text, extra);
    case 500:
    case 502:
    case 503:
    case 529:
      return providerError("provider_unavailable", text, extra);
    default:
      return providerError("unknown", text, extra);
  }
}

const CODES: Record<ProviderErrorCategory, JesutobitsErrorCode> = {
  auth: ErrorCodes.providerAuth,
  insufficient_credits: ErrorCodes.providerInsufficientCredits,
  rate_limited: ErrorCodes.providerRateLimited,
  context_length: ErrorCodes.providerContextLength,
  invalid_request: ErrorCodes.providerInvalidRequest,
  content_filter: ErrorCodes.providerContentFilter,
  provider_unavailable: ErrorCodes.providerUnavailable,
  timeout: ErrorCodes.providerTimeout,
  network: ErrorCodes.providerNetwork,
  cancelled: ErrorCodes.providerUnknown,
  unknown: ErrorCodes.providerUnknown,
};

/** Plain-language guidance per category (FR-025); the provider's text goes in details. */
const GUIDANCE: Record<ProviderErrorCategory, { message: string; userAction?: UserAction }> = {
  auth: {
    message: "OpenRouter did not accept the API key. Check it in Settings > Models & providers.",
    userAction: "open_settings",
  },
  insufficient_credits: {
    message: "Check your OpenRouter credits: the account has run out.",
    userAction: "check_credits",
  },
  rate_limited: {
    message: "OpenRouter is limiting requests right now. Try again in a minute.",
    userAction: "retry",
  },
  context_length: {
    message: "The conversation is too long for this model, even after summarising it.",
  },
  invalid_request: { message: "The model provider refused the request." },
  content_filter: { message: "The model provider's moderation blocked the request." },
  provider_unavailable: {
    message: "The model provider is unavailable right now. Try again shortly.",
    userAction: "retry",
  },
  timeout: { message: "The model took too long to answer.", userAction: "retry" },
  network: {
    message: "Jesutobits could not reach the model provider. Check your connection.",
    userAction: "retry",
  },
  cancelled: { message: "The request was cancelled." },
  unknown: { message: "The model request failed.", userAction: "retry" },
};

/** The turn-ending form of a provider failure (ARCHITECTURE.md section 9). */
export function providerFailure(error: ProviderError): JesutobitsError {
  if (error.category === "auth" && error.providerErrorType === "no_credentials") {
    return new JesutobitsError(
      ErrorCodes.providerNoCredentials,
      "No OpenRouter API key is stored. Add one in Settings > Models & providers.",
      { userAction: "open_settings", details: { category: "auth" } },
    );
  }
  const guidance = GUIDANCE[error.category];
  return new JesutobitsError(CODES[error.category], guidance.message, {
    retryable: error.retryable,
    ...(guidance.userAction && { userAction: guidance.userAction }),
    details: {
      category: error.category,
      providerMessage: error.message,
      ...(error.httpStatus !== undefined && { httpStatus: error.httpStatus }),
      ...(error.providerErrorType !== undefined && { providerErrorType: error.providerErrorType }),
    },
  });
}

/** A `Retry-After` header: seconds or an HTTP date. Undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
