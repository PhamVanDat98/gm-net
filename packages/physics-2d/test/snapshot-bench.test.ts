/**
 * Test cho bench harness M6 ([008 §4](../../../docs/design/008-roadmap.md)).
 *
 * Không assert số liệu hiệu năng (máy CI khác máy dev — sẽ flaky vô nghĩa); assert rằng
 * **phép đo là hợp lệ**: world thật sự có va chạm, snapshot lớn dần theo số body, thời
 * gian đo được là số hữu hạn dương, và restore+replay đắt hơn restore trần.
 * Số nhỏ + samples ít để test chạy nhanh; số liệu công bố lấy từ `pnpm --filter
 * @gm-net/physics-2d bench`.
 */
import { describe, expect, it } from 'vitest';
import { benchSnapshot, formatMarkdown, type BenchResult } from '../bench/snapshot-bench.js';

const fast = { samples: 3, warmupTicks: 20 };

describe('bench snapshot harness', () => {
  it('đo được world đang va chạm thật sự', async () => {
    const r = await benchSnapshot({ bodies: 40, ...fast });

    // Nếu bóng không chạm nhau thì bench đo sai kịch bản (snapshot của world rỗng contact
    // rẻ hơn thực tế) — đây là điều kiện tiên quyết của phép đo.
    expect(r.contactPairs).toBeGreaterThan(0);
    expect(r.samples).toBe(3);
    expect(r.replayTicks).toBe(7);
  });

  it('trả về thời gian hữu hạn dương và snapshot khác rỗng', async () => {
    const r = await benchSnapshot({ bodies: 20, ...fast });

    expect(r.snapshotBytes).toBeGreaterThan(0);
    expect(r.ringMB).toBeCloseTo((r.snapshotBytes * 30) / (1024 * 1024), 6);

    for (const t of [r.takeSnapshot, r.restore, r.restoreReplay, r.step]) {
      expect(Number.isFinite(t.meanMs)).toBe(true);
      expect(t.meanMs).toBeGreaterThan(0);
      expect(t.maxMs).toBeGreaterThanOrEqual(t.p99Ms);
      expect(t.p99Ms).toBeGreaterThanOrEqual(0);
    }

    // restore + replay 7 tick phải đắt hơn restore trần — nếu không, replay đã không chạy.
    expect(r.restoreReplay.meanMs).toBeGreaterThan(r.restore.meanMs);
  });

  it('snapshot lớn dần theo số body', async () => {
    const small = await benchSnapshot({ bodies: 10, ...fast });
    const large = await benchSnapshot({ bodies: 100, ...fast });

    expect(large.snapshotBytes).toBeGreaterThan(small.snapshotBytes);
    expect(large.ringMB).toBeGreaterThan(small.ringMB);
  });

  it('formatMarkdown xuất bảng dán được vào doc', () => {
    const row: BenchResult = {
      bodies: 50,
      replayTicks: 7,
      samples: 30,
      contactPairs: 42,
      snapshotBytes: 4096,
      ringMB: 0.12,
      takeSnapshot: { meanMs: 0.1, p99Ms: 0.2, maxMs: 0.2 },
      restore: { meanMs: 0.3, p99Ms: 0.4, maxMs: 0.4 },
      restoreReplay: { meanMs: 1.2, p99Ms: 1.5, maxMs: 1.6 },
      step: { meanMs: 0.05, p99Ms: 0.06, maxMs: 0.06 },
    };
    const md = formatMarkdown([row]);

    expect(md.split('\n')).toHaveLength(3); // header + separator + 1 hàng
    expect(md).toContain('| 50 | 42 | 4.0 KB | 0.12 MB |');
  });
});
