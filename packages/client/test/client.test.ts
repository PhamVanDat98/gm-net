import { describe, expect, it } from 'vitest';
import { GameClient } from '../src/index.js';
import { Loopback, makeCodec, type EchoInput } from './loopback.js';

const TICK = 33;

/** Chạy N tick sim: đẩy đồng hồ mịn (1ms) rồi ping + gửi input + tick server. */
function drive(lb: Loopback, client: GameClient<EchoInput>, ticks: number, move: EchoInput): void {
  for (let t = 0; t < ticks; t++) {
    for (let ms = 0; ms < TICK; ms++) lb.advance(1);
    client.update(lb.now);
    client.sendInput(move, lb.now);
    lb.serverTick();
  }
}

describe('GameClient — nghiệm thu M3 (loopback)', () => {
  it('kết nối echo server, box di chuyển bằng input, RTT/lead đo được', () => {
    const lb = new Loopback(50); // trễ một chiều 50ms → RTT 100ms
    const client = new GameClient<EchoInput>(lb.transport, {
      codec: makeCodec(),
      now: () => lb.now,
      tickMs: TICK,
      clock: { warmupMs: 1000, warmupPingIntervalMs: 100, pingIntervalMs: 300 },
    });
    client.start();
    lb.join();

    drive(lb, client, 300, { dx: 1, dy: 0 });

    // Handshake mang entityId local player.
    expect(client.entityId).toBe(1);
    expect(client.handshake?.tickRate).toBe(30);

    // Clock sync: RTT ≈ 100ms (trễ cố định → min chuẩn).
    expect(Math.abs(client.rtt - 100)).toBeLessThanOrEqual(2);

    // inputLead thích ứng theo RTT (base = ceil(50/33)+1 = 3), ≥ 1.
    expect(client.inputLead).toBeGreaterThanOrEqual(1);

    // Box đã tiến sang phải theo input (echo cộng dồn, quantize clamp ≤ maxX).
    const me = client.latestSnapshot!.entities.find((e) => e.entityId === 1)!;
    expect(me.posX).toBeGreaterThan(20);

    // Ack tiến → pendingInputs không phình vô hạn (redundancy được cắt).
    expect(client.metrics().pendingInputs).toBeLessThan(60);
  });

  it('serverTickNow tiến gần tick server thật khi đã sync', () => {
    const lb = new Loopback(30);
    const client = new GameClient<EchoInput>(lb.transport, {
      codec: makeCodec(),
      now: () => lb.now,
      tickMs: TICK,
      clock: { warmupMs: 800, warmupPingIntervalMs: 100 },
    });
    client.start();
    lb.join();
    drive(lb, client, 120, { dx: 0, dy: 0 });

    const est = client.serverTickNow(lb.now);
    expect(Math.abs(est - lb.server.tick)).toBeLessThan(3);
  });
});
