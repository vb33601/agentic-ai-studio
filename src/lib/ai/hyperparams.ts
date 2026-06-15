/**
 * Per-model sampling parameters.
 *
 * Two layers:
 *  1. A TUNED registry (`hyperparams-tuned.json`, keyed by "provider:id") that the
 *     tuning harness (scripts/tune-hyperparams.mts) populates with the best config
 *     found for each model against the eval suite. Wins when present.
 *  2. A safe HEURISTIC default for any model without a tuned profile.
 *
 * IMPORTANT (the realistic framing): sampling params extract the BEST out of a
 * given model — they do NOT make a weak/free model as capable or as fast as a
 * frontier model. The high-value, low-risk wins here are:
 *  - lower temperature for code (determinism → fewer bugs),
 *  - a repetition penalty for the FREE tier to curb runaway verbosity / re-emission
 *    (the free model streamed multi-MB and looped) → faster + cleaner output,
 *  - only sending OpenAI-style penalties to providers that accept them (NOT
 *    Anthropic, which rejects/ignores frequency/presence penalties).
 */
import type { ModelCandidate } from "./providers";
import TUNED_PROFILES from "./hyperparams-tuned.json";

export interface SamplingParams {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxOutputTokens?: number;
}

// Providers whose API accepts OpenAI-style frequency/presence penalties.
// Anthropic-direct does NOT (its API has no such fields) — sending them there
// produces provider warnings, so we omit them for `anthropic`.
const PENALTY_PROVIDERS = new Set([
  "openrouter", "aimlapi", "kilocode", "huggingface", "openai", "together", "fireworks", "groq",
]);

const tuned = TUNED_PROFILES as Record<string, SamplingParams>;

export interface SamplingContext {
  /** The agent's configured temperature (used as the chat/base temperature). */
  baseTemperature: number;
  /** The per-call output-token ceiling already resolved for this candidate. */
  baseMaxTokens: number;
  /** True for artifact-producing (code) builds — wants determinism. */
  isCodeBuild: boolean;
}

/**
 * Resolve the sampling params for a candidate: the tuned profile if one exists,
 * else the heuristic. The result is spread directly into `streamText`.
 */
export function samplingFor(candidate: ModelCandidate, ctx: SamplingContext): SamplingParams {
  const maxOutputTokens = candidate.maxOutputTokens ?? ctx.baseMaxTokens;

  // 1. Tuned profile wins (keep the candidate's resolved token cap unless the
  //    profile explicitly overrides it).
  const profile = tuned[`${candidate.provider}:${candidate.id}`];
  if (profile) return { maxOutputTokens, ...profile };

  // 2. Heuristic default.
  const p: SamplingParams = {
    // Code wants determinism; plain chat keeps the agent's tuned temperature.
    temperature: ctx.isCodeBuild ? Math.min(ctx.baseTemperature, 0.2) : ctx.baseTemperature,
    maxOutputTokens,
  };

  // Curb the free tier's runaway verbosity / re-emission (faster + cleaner), but
  // only where the provider accepts these fields. Values kept modest so they don't
  // distort legitimate code repetition (`import`, `const`, closing braces, …).
  if (candidate.free && PENALTY_PROVIDERS.has(candidate.provider)) {
    p.frequencyPenalty = 0.3;
    p.presencePenalty = 0.1;
    p.topP = 0.9;
  }

  return p;
}
