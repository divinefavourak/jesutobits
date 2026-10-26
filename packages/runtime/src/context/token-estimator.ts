/**
 * Token estimates (AGENT_HARNESS.md section 4.3): 1 token per 3.5 characters to start, then
 * a per-model calibration factor learnt from what the provider reports, as an exponential
 * moving average, so budgets follow each model's real tokeniser.
 */
const CHARS_PER_TOKEN = 3.5;
/** Weight of each new observation. */
const ALPHA = 0.3;
/** A factor outside this band is a bad sample (a cached prompt, a tiny request). */
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 2.5;

export class TokenEstimator {
  private readonly factors = new Map<string, number>();

  estimate(model: string, text: string): number {
    return Math.ceil((text.length / CHARS_PER_TOKEN) * this.factor(model));
  }

  factor(model: string): number {
    return this.factors.get(model) ?? 1;
  }

  /** Learns from a request whose estimate was `estimated` and whose real size was `actual`. */
  observe(model: string, estimated: number, actual: number): void {
    if (estimated < 200 || actual <= 0) return;
    const sample = (actual / estimated) * this.factor(model);
    if (sample < MIN_FACTOR || sample > MAX_FACTOR) return;
    const current = this.factor(model);
    this.factors.set(model, current + ALPHA * (sample - current));
  }
}
