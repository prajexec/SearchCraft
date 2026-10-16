interface HistogramState {
  readonly values: number[];
  nextIndex: number;
  total: number;
  sum: number;
}

export interface MetricsSnapshot {
  readonly counters: Record<string, number>;
  readonly gauges: Record<string, number>;
  readonly histograms: Record<
    string,
    {
      readonly count: number;
      readonly sum: number;
      readonly p50: number;
      readonly p95: number;
      readonly p99: number;
    }
  >;
}

const MAX_HISTOGRAM_SAMPLES = 2_048;

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, HistogramState>();

  public increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  public setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  public observe(name: string, value: number): void {
    let histogram = this.histograms.get(name);
    if (histogram === undefined) {
      histogram = { values: [], nextIndex: 0, total: 0, sum: 0 };
      this.histograms.set(name, histogram);
    }

    histogram.total += 1;
    histogram.sum += value;
    if (histogram.values.length < MAX_HISTOGRAM_SAMPLES) {
      histogram.values.push(value);
    } else {
      histogram.values[histogram.nextIndex] = value;
      histogram.nextIndex = (histogram.nextIndex + 1) % MAX_HISTOGRAM_SAMPLES;
    }
  }

  public snapshot(): MetricsSnapshot {
    const histograms: MetricsSnapshot['histograms'] = {};
    for (const [name, histogram] of this.histograms) {
      histograms[name] = {
        count: histogram.total,
        sum: histogram.sum,
        p50: percentile(histogram.values, 0.5),
        p95: percentile(histogram.values, 0.95),
        p99: percentile(histogram.values, 0.99),
      };
    }

    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms,
    };
  }

  public toPrometheus(): string {
    const lines: string[] = [];
    for (const [name, value] of this.counters) {
      lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
    }
    for (const [name, value] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
    }
    for (const [name, histogram] of this.histograms) {
      lines.push(`# TYPE ${name} summary`);
      lines.push(`${name}{quantile="0.5"} ${percentile(histogram.values, 0.5)}`);
      lines.push(`${name}{quantile="0.95"} ${percentile(histogram.values, 0.95)}`);
      lines.push(`${name}{quantile="0.99"} ${percentile(histogram.values, 0.99)}`);
      lines.push(`${name}_count ${histogram.total}`);
      lines.push(`${name}_sum ${histogram.sum}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
