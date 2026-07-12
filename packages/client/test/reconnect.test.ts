/**
 * Resync phía client sau reconnect ([006] §5, M8).
 *
 * Hợp đồng: handshake **lần hai** trên cùng một `GameClient` = server đã nhận lại
 * ta sau khi rớt mạng → vứt state phiên cũ (snapshot + ring baseline + input chưa
 * ack) rồi dựng lại từ keyframe kế tiếp. Không tự "đoán" reconnect ở tầng transport:
 * transport chỉ nối lại socket, server mới là bên xác nhận.
 */
import { describe, expect, it } from 'vitest';
import { MessageType, NO_ACK_TICK, ProtocolCodec, type Snapshot, type SnapshotEntity } from '@gm-net/core';
import { GameClient } from '../src/index.js';
import type { ClientTransport } from '../src/transport.js';

const codec = new ProtocolCodec({
  quantization: { world: { minX: -100, maxX: 100, minY: -100, maxY: 100 }, vMax: 50 },
});

const handshake = { protocolVersion: 1, tickRate: 30, worldBounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 }, entityId: 1 };

function entity(id: number, posX: number): SnapshotEntity {
  return { entityId: id, entityType: 0, posX, posY: 0, rot: 0, velX: 0, velY: 0 };
}
function snap(tick: number, entities: SnapshotEntity[], lastProcessedSeq = 0): Snapshot {
  return { serverTick: tick, lastProcessedSeq, lateInputs: 0, entities };
}

/** Transport giả: ghi lại byte gửi lên, cho phép bơm message xuống. */
function fakeTransport() {
  let bytesCb: ((type: number, bytes: Uint8Array) => void) | undefined;
  const jsonCbs = new Map<string, (p: unknown) => void>();
  const sent: Array<{ type: number; bytes: Uint8Array }> = [];
  const transport: ClientTransport = {
    onBytes: (cb) => {
      bytesCb = cb;
    },
    onJson: (type, cb) => {
      jsonCbs.set(type, cb);
    },
    sendBytes: (type, bytes) => {
      sent.push({ type, bytes });
    },
    onLeave: () => {},
    leave: () => {},
  };
  return {
    transport,
    sent,
    handshake: (h: unknown) => jsonCbs.get('handshake')?.(h),
    snapshot: (s: Snapshot) => bytesCb?.(MessageType.Snapshot, codec.encodeSnapshot(s)),
    delta: (s: Snapshot, baseline: { serverTick: number; entities: SnapshotEntity[] }) =>
      bytesCb?.(MessageType.Delta, codec.encodeDelta(s, baseline)),
    lastInput: () => {
      const last = [...sent].reverse().find((m) => m.type === MessageType.Input);
      return last ? codec.decodeInput(last.bytes) : undefined;
    },
  };
}

describe('GameClient — resync sau reconnect', () => {
  it('handshake lần hai → vứt snapshot cũ, ack lại bằng NO_ACK_TICK', () => {
    const t = fakeTransport();
    const client = new GameClient(t.transport, { codec });
    client.start();

    t.handshake(handshake);
    t.snapshot(snap(100, [entity(1, 5)]));
    expect(client.latestSnapshot?.serverTick).toBe(100);

    // Rớt mạng → nối lại → server gửi handshake mới.
    t.handshake(handshake);

    expect(client.latestSnapshot).toBeUndefined(); // state cũ đã vứt
    client.sendInput({ dx: 1 }, Date.now(), 200);
    // Chưa có snapshot phiên mới → phải báo "chưa có gì", KHÔNG ack tick 100 cũ
    // (server đã reset baseline; ack tick cũ sẽ khiến nó tưởng ta còn baseline đó).
    expect(t.lastInput()?.ackTick).toBe(NO_ACK_TICK);
  });

  it('input chưa ack của phiên cũ bị bỏ (không replay lên timeline mới)', () => {
    const t = fakeTransport();
    const client = new GameClient(t.transport, { codec });
    client.start();
    t.handshake(handshake);

    client.sendInput({ dx: 1 }, Date.now(), 10);
    client.sendInput({ dx: 1 }, Date.now(), 11);
    expect(client.unackedInputs()).toHaveLength(2);

    t.handshake(handshake); // reconnect

    expect(client.unackedInputs()).toHaveLength(0);
  });

  it('ring baseline cũ bị xóa: delta dựa trên tick trước lúc rớt KHÔNG được áp', () => {
    const t = fakeTransport();
    const client = new GameClient(t.transport, { codec });
    client.start();
    t.handshake(handshake);
    t.snapshot(snap(100, [entity(1, 5)]));

    t.handshake(handshake); // reconnect

    // Delta "lạc" của phiên cũ (server thật sẽ không gửi, nhưng nếu có: phải bỏ).
    t.delta(snap(101, [entity(1, 9)]), { serverTick: 100, entities: [entity(1, 5)] });
    expect(client.latestSnapshot).toBeUndefined();

    // Keyframe resync dựng lại state.
    t.snapshot(snap(420, [entity(1, 9), entity(2, -3)]));
    expect(client.latestSnapshot?.serverTick).toBe(420);
    expect(client.latestSnapshot?.entities).toHaveLength(2);
    expect(client.snapshotStats().deltasDropped).toBe(1);
  });

  it('keyframe resync có tick NHỎ hơn tick cũ vẫn được nhận (server restart/room khác)', () => {
    const t = fakeTransport();
    const client = new GameClient(t.transport, { codec });
    client.start();
    t.handshake(handshake);
    t.snapshot(snap(500, [entity(1, 5)]));

    t.handshake(handshake); // reconnect
    t.snapshot(snap(3, [entity(1, 0)])); // tick nhỏ hơn — nếu không reset sẽ bị chặn "cũ hơn"

    expect(client.latestSnapshot?.serverTick).toBe(3);
  });
});
