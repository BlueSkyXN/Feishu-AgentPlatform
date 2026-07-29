type Labels = Record<string, string | number | boolean>;

interface MetricValue {
  name: string;
  help: string;
  type: 'counter' | 'gauge';
  labels: Labels;
  value: number;
}

export class MetricsRegistry {
  private readonly values = new Map<string, MetricValue>();

  increment(name: string, help: string, labels: Labels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`Counter increment must be a finite non-negative number: ${name}`);
    }
    const metric = this.getOrCreate(name, help, 'counter', labels);
    metric.value += amount;
  }

  setGauge(name: string, help: string, labels: Labels, value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`Gauge value must be finite: ${name}`);
    }
    const metric = this.getOrCreate(name, help, 'gauge', labels);
    metric.value = value;
  }

  renderPrometheus(): string {
    const groups = new Map<string, MetricValue[]>();
    for (const metric of this.values.values()) {
      const group = groups.get(metric.name) ?? [];
      group.push(metric);
      groups.set(metric.name, group);
    }

    const lines: string[] = [];
    for (const [name, metrics] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const first = metrics[0];
      if (!first) continue;
      lines.push(`# HELP ${name} ${escapeHelp(first.help)}`);
      lines.push(`# TYPE ${name} ${first.type}`);
      for (const metric of metrics.sort((a, b) => labelKey(a.labels).localeCompare(labelKey(b.labels)))) {
        const labels = renderLabels(metric.labels);
        lines.push(`${name}${labels} ${Number.isFinite(metric.value) ? metric.value : 0}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  snapshot(): Array<{ name: string; labels: Labels; value: number }> {
    return [...this.values.values()].map(({ name, labels, value }) => ({
      name,
      labels: { ...labels },
      value,
    }));
  }

  private getOrCreate(
    name: string,
    help: string,
    type: MetricValue['type'],
    labels: Labels,
  ): MetricValue {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
      throw new Error(`Invalid Prometheus metric name: ${name}`);
    }
    for (const label of Object.keys(labels)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label) || label === '__name__') {
        throw new Error(`Invalid Prometheus label name: ${label}`);
      }
    }
    const key = `${name}|${labelKey(labels)}`;
    const existing = this.values.get(key);
    if (existing) {
      if (existing.type !== type) throw new Error(`Metric type mismatch for ${name}.`);
      if (existing.help !== help) throw new Error(`Metric help mismatch for ${name}.`);
      return existing;
    }
    const metric: MetricValue = {
      name,
      help,
      type,
      labels: { ...labels },
      value: 0,
    };
    this.values.set(key, metric);
    return metric;
  }
}

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(',');
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return `{${entries
    .map(([key, value]) => `${key}="${escapeLabel(String(value))}"`)
    .join(',')}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}
