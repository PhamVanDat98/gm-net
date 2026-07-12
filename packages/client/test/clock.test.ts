import { describe, expect, it } from 'vitest';
import { ProtocolCodec } from '@gm-net/core';
import { ClockSync } from '../src/index.js';

const tickMs = 33;

const codec = new ProtocolCodec({
  quantization: { world: { minX: -100, maxX: 100, minY: -100, maxY: 100 }, vMax: 50 },
});

/** PING đi qua dây thật (clientTime cắt còn u32 — [005] §6b) rồi server echo về PONG. */
function roundTripPong(clientTime: number, serverTick: number) {
  const ping = codec.decodePing(codec.encodePing({ clientTime }));
  return codec.decodePong(
    codec.encodePong({ clientTime: ping.clientTime, serverTime: 0, serverTick }),
  );
}

describe('ClockSync — đồng hồ thật (epoch ms > u32)', () => {
  // Hồi quy: `Date.now()` (~1.78e12) không lọt u32 nên clientTime trên dây bị cắt.
  // Trừ thẳng receivedAt (đầy đủ) cho clientTime (đã cắt) → RTT ~1.78e12 ms →
  // serverTickNow ~2.7e10 → PredictionWorld.advance() step Rapier hàng tỉ lần → treo cứng.
  // [005] §6b chốt: client phải trừ theo số học wrap u32 ("trừ với chính đồng hồ mình").
  it('RTT đúng khi clientTime bị cắt u32 trên dây', () => {
    const clock = new ClockSync({ tickMs });
    const sentAt = 1_783_000_000_000; // Date.now() thật (2026)
    const pong = roundTripPong(sentAt, 1000);

    clock.onPong(pong, sentAt + 200);

    expect(clock.rtt).toBe(200);
    expect(clock.serverTickNow(sentAt + 200)).toBeCloseTo(1000 + 100 / tickMs, 6);
  });

  it('RTT đúng khi đồng hồ u32 wrap giữa ping và pong (~49 ngày)', () => {
    const clock = new ClockSync({ tickMs });
    // Ping gửi ngay trước mốc wrap 2^32 ms, pong về sau mốc.
    const sentAt = 4_294_967_296 - 50; // clientTime trên dây = 2^32 - 50
    const pong = roundTripPong(sentAt, 1000);

    clock.onPong(pong, sentAt + 200); // receivedAt đã vượt 2^32 → u32 wrap về 150

    expect(clock.rtt).toBe(200);
  });
});

describe('ClockSync', () => {
  it('RTT hội tụ về min cửa sổ với jitter, jitter > 0', () => {
    const clock = new ClockSync({ tickMs, rttWindow: 10 });
    // jitter một chiều (ms); có mẫu 0 để min = baseRtt chuẩn.
    const jitters = [20, 0, 10, 5, 15, 8, 0, 12, 7, 3];
    const baseRtt = 100;
    for (let i = 0; i < jitters.length; i++) {
      const sendTime = i * 500;
      const rtt = baseRtt + jitters[i] * 2;
      const receivedAt = sendTime + rtt;
      const serverTickAtSend = Math.round((sendTime + rtt / 2) / tickMs);
      clock.onPong({ clientTime: sendTime, serverTime: 0, serverTick: serverTickAtSend }, receivedAt);
    }
    expect(clock.rtt).toBe(baseRtt); // min chọn mẫu jitter 0
    expect(clock.jitter).toBeGreaterThan(0);
  });

  it('serverTickNow bám tick server thật (sai < 2 tick)', () => {
    const clock = new ClockSync({ tickMs });
    const baseRtt = 100;
    let lastRecv = 0;
    for (let i = 0; i < 8; i++) {
      const sendTime = i * 500;
      const rtt = baseRtt + (i % 3) * 10;
      lastRecv = sendTime + rtt;
      const serverTickAtSend = Math.round((sendTime + rtt / 2) / tickMs);
      clock.onPong({ clientTime: sendTime, serverTime: 0, serverTick: serverTickAtSend }, lastRecv);
    }
    const est = clock.serverTickNow(lastRecv);
    const trueTick = lastRecv / tickMs; // server advances 1 tick / tickMs từ mốc 0
    expect(Math.abs(est - trueTick)).toBeLessThan(2);
  });

  it('baseInputLead = ceil(RTT/2 / TICK_MS) + 1', () => {
    const clock = new ClockSync({ tickMs });
    expect(Number.isNaN(clock.baseInputLead())).toBe(true); // chưa sync
    clock.onPong({ clientTime: 0, serverTime: 0, serverTick: 0 }, 100); // RTT 100
    expect(clock.baseInputLead()).toBe(Math.ceil(100 / 2 / tickMs) + 1); // = 3
  });

  it('bỏ mẫu RTT âm (đồng hồ lùi / gói hỏng)', () => {
    const clock = new ClockSync({ tickMs });
    clock.onPong({ clientTime: 500, serverTime: 0, serverTick: 0 }, 400); // âm
    expect(clock.hasSync).toBe(false);
  });

  it('ping dày trong warmup rồi thưa dần', () => {
    const clock = new ClockSync({ warmupMs: 2000, warmupPingIntervalMs: 250, pingIntervalMs: 500 });
    clock.connect(0);
    expect(clock.shouldPing(0)).toBe(true); // lần đầu
    clock.markPinged(0);
    expect(clock.shouldPing(200)).toBe(false); // < 250 trong warmup
    expect(clock.shouldPing(250)).toBe(true); // đủ nhịp warmup
    clock.markPinged(250);
    expect(clock.shouldPing(400)).toBe(false); // vẫn warmup, < 250 kể từ 250
    expect(clock.shouldPing(500)).toBe(true); // đủ 250 kể từ 250
    clock.markPinged(2100); // đã qua warmup (>2000)
    expect(clock.shouldPing(2400)).toBe(false); // < 500
    expect(clock.shouldPing(2600)).toBe(true); // ≥ 500 nhịp thường
  });
});
