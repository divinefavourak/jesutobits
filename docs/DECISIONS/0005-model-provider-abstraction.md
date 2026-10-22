# ADR-0005: Model provider abstraction and OpenRouter adapter

- **Status:** Accepted
- **Date:** 2026-10-19
- **Related:** RN-25 to RN-28, docs/AGENT_HARNESS.md section 2

## Context

Jesutobits starts with OpenRouter as the only provider, but must support direct providers (Anthropic, OpenAI, Google) and local models (for example Ollama) later without touching the agent loop. Providers differ in tool-calling formats, streaming shapes, error semantics, cancellation behaviour (RN-28) and capabilities.

## Decision

1. Define a provider-neutral contract in `packages/runtime/src/providers/types.ts`: `ModelProvider`, `ModelRequest`, `ModelStreamEvent`, `ModelInfo`, `ProviderError`. The agent loop only knows these types. The full contract is in AGENT_HARNESS.md section 2.
2. Implement the **OpenRouter adapter directly over `fetch` + an SSE parser** (`eventsource-parser`), against the Chat Completions endpoint. No vendor SDK in the core loop.
3. Adapters translate: our normalised messages and tools → provider request; provider stream → `ModelStreamEvent`s; provider errors → `ProviderError` with a `category` and `retryable` flag.
4. Capability data comes from the provider (`/api/v1/models` and `supported_parameters`, RN-25), cached in SQLite for 24 hours, and can be overridden per model in settings. Agent mode only offers models whose capabilities include `tools`.
5. Credentials never enter the adapter's configuration objects. The adapter receives a `getCredential()` callback that asks the Host (ADR-0003, `host.secrets.get`) and holds the value in memory only.
6. Provider-specific options (OpenRouter provider routing, fallbacks, attribution headers) live in a per-provider `options` object validated by that adapter's own Zod schema. The agent loop passes it through untouched.

## Alternatives considered

| Option | Assessment |
|---|---|
| **Vercel AI SDK** as the abstraction | Mature and multi-provider. Rejected for the core because its message and tool types would become our internal types, and its upgrade cadence would drive ours. An adapter may still use it internally later. |
| **OpenAI SDK with `baseURL`** pointed at OpenRouter | Works for OpenRouter, but ties us to OpenAI's types and hides OpenRouter-specific fields such as `error.metadata.error_type`. |
| **Responses API or Anthropic Messages skin of OpenRouter** | Viable. Chat Completions is the most widely supported skin across OpenRouter models, so it is the safest start. |

## Trade-offs

- We own an SSE parser loop and error mapping. That is about 300 lines plus tests, and it is the part most worth owning.
- Feature parity with every provider extension (reasoning tokens, prompt caching controls, multimodal outputs) is incremental. Each is added to `ModelStreamEvent` only when the agent loop actually uses it.

## Consequences

- Retry policy is owned by the agent loop's `ProviderCaller`, not by adapters: retries happen only for retryable errors that occur **before any content is emitted** (RN-27). Mid-stream failures discard the partial step and retry the step once.
- Cancellation calls `AbortController.abort()`. For providers where aborting does not stop billing (RN-28), the UI shows "Stopped. The provider may still bill for the full response." when the model's provider is on the known list. That list is data, not code.
- A `ScriptedProvider` implementing the same interface powers deterministic tests (TESTING_STRATEGY.md).

## Implementation notes

- Phase 2 (2026-10-22): the SSE parser is our own (`providers/openrouter/sse.ts`, about 80 lines) instead of `eventsource-parser`, because the npm registry was unreachable; it follows the WHATWG event-stream rules and has its own tests. SSE comments become a `keepalive` stream event, so the ProviderCaller's idle timer sees them. Requests send `usage: { include: true }` so the final chunk carries tokens and cost. A missing key is reported as `auth` with `providerErrorType: "no_credentials"` (turn error `provider.no_credentials`). The model list comes from one `GET /models`; `capabilities.tools` is read from each model's `supported_parameters`.

## Revisit when

A second provider needs a concept the contract cannot express without breaking changes (for example server-side tool execution or persistent server-side conversation state).
