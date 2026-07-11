import { describe, expect, it } from 'vitest';
import {
  BitReader,
  BitWriter,
  MessageType,
  ProtocolCodec,
  ProtocolError,
  peekMessageType,
  type CustomCodec,
  type Snapshot,
  type SnapshotEntity,
} from '../src/index.js';

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const QUANT = {
  world: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
  vMax: 50,
};
const POS_HALF_STEP = 200 / 65535 / 2;
const VEL_HALF_STEP = 50 / 32767 / 2;

const plain = new ProtocolCodec({ quantization: QUANT });

describe('golden bytes — đổi format là test đỏ (ép cập nhật doc 005)', () => {
  it('PING', () => {
    const bytes = plain.encodePing({ clientTime: 0x01020304 });
    expect([...bytes]).toEqual([0x02, 0x04, 0x03, 0x02, 0x01]);
  });

  it('INPUT (không payload)', () => {
    const bytes = plain.encodeInput({
      ackTick: 100,
      latestSeq: 9,
      inputs: [{ tick: 50 }, { tick: 51 }],
    });
    // prettier-ignore
    expect([...bytes]).toEqual([
      0x00,                    // type INPUT
      0x64, 0x00, 0x00, 0x00,  // ackTick 100
      0x09, 0x00,              // latestSeq 9
      0x02,                    // count
      0x32, 0x00, 0x00, 0x00,  // tick 50
      0x33, 0x00, 0x00, 0x00,  // tick 51
    ]);
  });

  it('SNAPSHOT 1 entity với config identity', () => {
    const identity = new ProtocolCodec({
      quantization: { world: { minX: 0, maxX: 65535, minY: 0, maxY: 65535 }, vMax: 32767 },
    });
    const bytes = identity.encodeSnapshot({
      serverTick: 42,
      lastProcessedSeq: 7,
      lateInputs: 3,
      entities: [
        { entityId: 1000, entityType: 0, posX: 1000, posY: 2000, rot: 0, velX: 5, velY: -5 },
      ],
    });
    // prettier-ignore
    expect([...bytes]).toEqual([
      0x01,                    // type SNAPSHOT
      0x2a, 0x00, 0x00, 0x00,  // serverTick 42
      0x07, 0x00,              // lastProcessedSeq 7
      0x03,                    // lateInputs 3
      0x01, 0x00,              // entityCount 1
      0xe8, 0x03,              // entityId 1000
      0x00,                    // entityType 0
      0xe8, 0x03,              // posX 1000
      0xd0, 0x07,              // posY 2000
      0x00, 0x00,              // rot 0
      0x05, 0x00,              // velX 5
      0xfb, 0xff,              // velY -5
    ]);
  });
});

describe('nghiệm thu M1 — kích thước SNAPSHOT ([005] §7)', () => {
  it('10 entity transform-only = 13 byte/entity + 10 byte header = 140 byte', () => {
    const entities: SnapshotEntity[] = [];
    for (let i = 0; i < 10; i++) {
      entities.push({ entityId: i, entityType: 0, posX: i, posY: -i, rot: 0.1 * i, velX: i, velY: -i });
    }
    const bytes = plain.encodeSnapshot({ serverTick: 1, lastProcessedSeq: 0, lateInputs: 0, entities });
    expect(bytes.byteLength).toBe(140);
    const HEADER = 10;
    expect((bytes.byteLength - HEADER) / 10).toBe(13);
  });
});

describe('round-trip mọi message', () => {
  it('PING / PONG', () => {
    expect(plain.decodePing(plain.encodePing({ clientTime: 999 }))).toEqual({ clientTime: 999 });
    const pong = { clientTime: 111, serverTime: 222, serverTick: 333 };
    expect(plain.decodePong(plain.encodePong(pong))).toEqual(pong);
  });

  it('property: SNAPSHOT ngẫu nhiên round-trip trong sai số quantize', () => {
    const rng = makeRng(7);
    for (let iter = 0; iter < 300; iter++) {
      const n = Math.floor(rng() * 12);
      const entities: SnapshotEntity[] = [];
      for (let i = 0; i < n; i++) {
        entities.push({
          entityId: Math.floor(rng() * 65536),
          entityType: 0,
          posX: -100 + rng() * 200,
          posY: -100 + rng() * 200,
          rot: rng() * Math.PI * 2,
          velX: (rng() * 2 - 1) * 50,
          velY: (rng() * 2 - 1) * 50,
        });
      }
      const snap: Snapshot = {
        serverTick: Math.floor(rng() * 0xffffffff),
        lastProcessedSeq: Math.floor(rng() * 65536),
        lateInputs: Math.floor(rng() * 256),
        entities,
      };
      const decoded = plain.decodeSnapshot(plain.encodeSnapshot(snap));
      expect(decoded.serverTick).toBe(snap.serverTick);
      expect(decoded.lastProcessedSeq).toBe(snap.lastProcessedSeq);
      expect(decoded.lateInputs).toBe(snap.lateInputs);
      expect(decoded.entities.length).toBe(n);
      for (let i = 0; i < n; i++) {
        const a = snap.entities[i];
        const b = decoded.entities[i];
        expect(b.entityId).toBe(a.entityId);
        expect(Math.abs(b.posX - a.posX)).toBeLessThanOrEqual(POS_HALF_STEP + 1e-6);
        expect(Math.abs(b.posY - a.posY)).toBeLessThanOrEqual(POS_HALF_STEP + 1e-6);
        expect(Math.abs(b.velX - a.velX)).toBeLessThanOrEqual(VEL_HALF_STEP + 1e-6);
        expect(Math.abs(b.velY - a.velY)).toBeLessThanOrEqual(VEL_HALF_STEP + 1e-6);
      }
    }
  });

  it('property: INPUT ngẫu nhiên round-trip (seq mới nhất + count)', () => {
    const rng = makeRng(8);
    for (let iter = 0; iter < 300; iter++) {
      const count = 1 + Math.floor(rng() * 5); // redundancy 3–5 (thử 1–5)
      const inputs = Array.from({ length: count }, () => ({ tick: Math.floor(rng() * 0xffffffff) }));
      const msg = { ackTick: Math.floor(rng() * 0xffffffff), latestSeq: Math.floor(rng() * 65536), inputs };
      const decoded = plain.decodeInput(plain.encodeInput(msg));
      expect(decoded.ackTick).toBe(msg.ackTick);
      expect(decoded.latestSeq).toBe(msg.latestSeq);
      expect(decoded.inputs.map((e) => e.tick)).toEqual(inputs.map((e) => e.tick));
    }
  });
});

describe('custom codec của game (§5)', () => {
  interface Hp {
    hp: number;
    flag: number;
  }
  const hpCodec: CustomCodec<Hp> = {
    encode: (w, s) => {
      w.writeU16(s.hp);
      w.writeU8(s.flag);
    },
    decode: (r) => ({ hp: r.readU16(), flag: r.readU8() }),
  };
  interface Btn {
    buttons: number;
    aimX: number;
  }
  const inputCodec: CustomCodec<Btn> = {
    encode: (w, s) => {
      w.writeU8(s.buttons);
      w.writeI16(s.aimX);
    },
    decode: (r) => ({ buttons: r.readU8(), aimX: r.readI16() }),
  };

  const codec = new ProtocolCodec<Btn>({
    quantization: QUANT,
    entityCodecs: new Map([[7, hpCodec as CustomCodec]]),
    inputCodec: inputCodec as CustomCodec,
  });

  it('SNAPSHOT mang custom state theo entityType', () => {
    const snap: Snapshot = {
      serverTick: 5,
      lastProcessedSeq: 1,
      lateInputs: 0,
      entities: [
        { entityId: 1, entityType: 7, posX: 0, posY: 0, rot: 0, velX: 0, velY: 0, custom: { hp: 250, flag: 3 } },
        { entityId: 2, entityType: 0, posX: 10, posY: 10, rot: 1, velX: 1, velY: 1 },
      ],
    };
    const decoded = codec.decodeSnapshot(codec.encodeSnapshot(snap));
    expect(decoded.entities[0].custom).toEqual({ hp: 250, flag: 3 });
    expect(decoded.entities[1].custom).toBeUndefined();
  });

  it('INPUT mang payload của game', () => {
    const msg = { ackTick: 0, latestSeq: 3, inputs: [{ tick: 1, payload: { buttons: 5, aimX: -30 } }] };
    const decoded = codec.decodeInput(codec.encodeInput(msg));
    expect(decoded.inputs[0]).toEqual({ tick: 1, payload: { buttons: 5, aimX: -30 } });
  });
});

describe('an toàn decoder', () => {
  it('peekMessageType đọc byte đầu', () => {
    expect(peekMessageType(plain.encodePing({ clientTime: 1 }))).toBe(MessageType.Ping);
    expect(() => peekMessageType(new Uint8Array(0))).toThrow(ProtocolError);
  });

  it('sai messageType → ProtocolError', () => {
    const ping = plain.encodePing({ clientTime: 1 });
    expect(() => plain.decodeSnapshot(ping)).toThrow(ProtocolError);
  });

  it('fuzz: bytes rác không crash/hang, chỉ ném Error', () => {
    const rng = makeRng(99);
    const decoders = [
      (b: Uint8Array) => plain.decodeSnapshot(b),
      (b: Uint8Array) => plain.decodeInput(b),
      (b: Uint8Array) => plain.decodePing(b),
      (b: Uint8Array) => plain.decodePong(b),
    ];
    for (let iter = 0; iter < 3000; iter++) {
      const len = Math.floor(rng() * 40);
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = Math.floor(rng() * 256);
      for (const decode of decoders) {
        try {
          decode(bytes);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }
    }
  });
});

describe('BitWriter/BitReader export từ core', () => {
  it('có sẵn để game viết custom codec', () => {
    expect(typeof BitWriter).toBe('function');
    expect(typeof BitReader).toBe('function');
  });
});
