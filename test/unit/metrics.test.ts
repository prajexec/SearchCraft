import test from 'node:test';
import assert from 'node:assert/strict';

import { Metrics } from '../../src/observability/metrics';

test('metrics expose bounded observations and Prometheus output', () => {
  const metrics = new Metrics();
  metrics.increment('searchcraft_test_total', 2);
  metrics.setGauge('searchcraft_test_gauge', 7);
  metrics.observe('searchcraft_test_duration_ms', 4);
  metrics.observe('searchcraft_test_duration_ms', 8);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.searchcraft_test_total, 2);
  assert.equal(snapshot.gauges.searchcraft_test_gauge, 7);
  assert.equal(snapshot.histograms.searchcraft_test_duration_ms?.count, 2);
  assert.equal(snapshot.histograms.searchcraft_test_duration_ms?.p50, 4);
  assert.match(metrics.toPrometheus(), /searchcraft_test_total 2/);
  assert.match(metrics.toPrometheus(), /searchcraft_test_duration_ms_count 2/);
});
