/** Small benchmark statistics helper: warmup, measured samples, p50/p95. */

export interface TimingResult {
  samples: number[];
  p50: number;
  p95: number;
}

export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) {
    throw new Error("percentile needs at least one sample");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export function summarize(samples: readonly number[]): TimingResult {
  return {
    samples: [...samples],
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
  };
}

/** Run warmup passes, then collect `iterations` wall-clock samples. */
export async function timeAsync(
  warmup: number,
  iterations: number,
  operation: () => Promise<void>,
): Promise<TimingResult> {
  for (let index = 0; index < warmup; index += 1) {
    await operation();
  }
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

export function timeSync(warmup: number, iterations: number, operation: () => void): TimingResult {
  for (let index = 0; index < warmup; index += 1) {
    operation();
  }
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    operation();
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

export function formatMilliseconds(value: number): string {
  return `${value.toFixed(1)} ms`;
}
