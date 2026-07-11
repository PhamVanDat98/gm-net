import { describe, expect, it } from 'vitest';
import { SnapshotReceiver } from '../src/index.js';
import { makeCodec, type EchoInput } from './loopback.js';

const codec = makeCodec();
const mk = (tick: number) =>
  codec.encodeSnapshot({ serverTick: tick, lastProcessedSeq: 0, lateInputs: 0, entities: [] });

describe('SnapshotReceiver', () => {
  it('nhận bản mới, bỏ bản cũ/trùng, phát cho listener', () => {
    const r = new SnapshotReceiver<EchoInput>(codec);
    const seen: number[] = [];
    r.onSnapshot((s) => seen.push(s.serverTick));

    expect(r.latestTick).toBe(-1);
    expect(r.receive(mk(5))?.serverTick).toBe(5);
    expect(r.receive(mk(6))?.serverTick).toBe(6);
    expect(r.receive(mk(4))).toBeUndefined(); // cũ hơn → bỏ
    expect(r.receive(mk(6))).toBeUndefined(); // trùng bản mới nhất → bỏ
    expect(r.latestTick).toBe(6);
    expect(seen).toEqual([5, 6]); // listener chỉ chạy cho bản được nhận
  });

  it('gỡ listener qua hàm trả về', () => {
    const r = new SnapshotReceiver<EchoInput>(codec);
    let count = 0;
    const off = r.onSnapshot(() => count++);
    r.receive(mk(1));
    off();
    r.receive(mk(2));
    expect(count).toBe(1);
  });
});
