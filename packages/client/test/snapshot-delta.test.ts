/**
 * `SnapshotReceiver` với DELTA ([005] §4, M7).
 *
 * Điểm thiết kế mấu chốt: ack đi kèm INPUT nên tới server TRỄ → baseline server
 * chọn thường là snapshot CŨ của client, không phải bản mới nhất. Client vì thế
 * giữ **ring** snapshot gần đây; delta không khớp baseline nào → bỏ, ack đứng
 * yên, server sẽ gửi keyframe (tự lành).
 */
import { describe, expect, it } from 'vitest';
import { ProtocolCodec, type Snapshot, type SnapshotEntity } from '@gm-net/core';
import { SnapshotReceiver } from '../src/index.js';

const codec = new ProtocolCodec({
  quantization: { world: { minX: -100, maxX: 100, minY: -100, maxY: 100 }, vMax: 50 },
});

function entity(id: number, posX: number): SnapshotEntity {
  return { entityId: id, entityType: 0, posX, posY: 0, rot: 0, velX: 0, velY: 0 };
}

function snap(tick: number, entities: SnapshotEntity[]): Snapshot {
  return { serverTick: tick, lastProcessedSeq: 0, lateInputs: 0, entities };
}

describe('SnapshotReceiver — DELTA', () => {
  it('áp delta dựa trên baseline CŨ (không phải bản mới nhất) — ack trễ', () => {
    const rx = new SnapshotReceiver(codec);

    // Client nhận keyframe tick 10, rồi delta 11, 12 (baseline vẫn là 10 vì ack trễ).
    rx.receive(codec.encodeSnapshot(snap(10, [entity(1, 0)])));
    rx.receiveDelta(codec.encodeDelta(snap(11, [entity(1, 5)]), { serverTick: 10, entities: [entity(1, 0)] }));
    const latest = rx.receiveDelta(
      codec.encodeDelta(snap(12, [entity(1, 9)]), { serverTick: 10, entities: [entity(1, 0)] }),
    );

    expect(latest?.serverTick).toBe(12);
    expect(latest?.entities[0].posX).toBeCloseTo(9, 2);
    expect(rx.latestTick).toBe(12);
    expect(rx.snapshotStats()).toMatchObject({ deltasApplied: 2, keyframes: 1, deltasDropped: 0 });
  });

  it('delta có baselineTick không nằm trong ring → bỏ, giữ nguyên state', () => {
    const rx = new SnapshotReceiver(codec);
    rx.receive(codec.encodeSnapshot(snap(10, [entity(1, 0)])));

    const orphan = codec.encodeDelta(snap(11, [entity(1, 5)]), {
      serverTick: 7, // client không có tick 7
      entities: [entity(1, 0)],
    });

    expect(rx.receiveDelta(orphan)).toBeUndefined();
    expect(rx.latestTick).toBe(10); // state không đổi
    expect(rx.snapshotStats().deltasDropped).toBe(1);
  });

  it('keyframe sau khi bỏ delta → client bắt nhịp lại (tự lành)', () => {
    const rx = new SnapshotReceiver(codec);
    rx.receive(codec.encodeSnapshot(snap(10, [entity(1, 0)])));
    rx.receiveDelta(codec.encodeDelta(snap(11, [entity(1, 5)]), { serverTick: 7, entities: [] }));

    const recovered = rx.receive(codec.encodeSnapshot(snap(12, [entity(1, 9), entity(2, -3)])));

    expect(recovered?.serverTick).toBe(12);
    expect(recovered?.entities).toHaveLength(2);
    expect(rx.latestTick).toBe(12);
  });

  it('delta cũ hơn bản mới nhất → bỏ (không lùi tick)', () => {
    const rx = new SnapshotReceiver(codec);
    rx.receive(codec.encodeSnapshot(snap(10, [entity(1, 0)])));
    rx.receive(codec.encodeSnapshot(snap(12, [entity(1, 9)])));

    // Delta tick 11 (baseline 10 vẫn còn trong ring) nhưng đã lỗi thời.
    const stale = codec.encodeDelta(snap(11, [entity(1, 5)]), { serverTick: 10, entities: [entity(1, 0)] });

    expect(rx.receiveDelta(stale)).toBeUndefined();
    expect(rx.latestTick).toBe(12);
  });

  it('despawn trong delta xóa entity khỏi state tái dựng', () => {
    const rx = new SnapshotReceiver(codec);
    const base = [entity(1, 0), entity(2, 4)];
    rx.receive(codec.encodeSnapshot(snap(10, base)));

    const after = rx.receiveDelta(
      codec.encodeDelta(snap(11, [entity(1, 0)]), { serverTick: 10, entities: base }),
    );

    expect(after?.entities.map((e) => e.entityId)).toEqual([1]);
  });
});
