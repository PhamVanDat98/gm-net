import { describe, expect, it } from 'vitest';
import {
  ANGLE_STEP,
  dequantizeAngle,
  dequantizeScalar,
  dequantizeVelocity,
  quantizeAngle,
  quantizeScalar,
  quantizeVelocity,
  scalarStep,
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

const TWO_PI = Math.PI * 2;

describe('quantize position (scalar u16)', () => {
  const MIN = -150;
  const MAX = 150; // dải 300m
  const halfStep = scalarStep(MIN, MAX) / 2;

  it('sai số round-trip ≤ nửa bước lượng tử', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 5000; i++) {
      const v = MIN + rng() * (MAX - MIN);
      const back = dequantizeScalar(quantizeScalar(v, MIN, MAX), MIN, MAX);
      expect(Math.abs(back - v)).toBeLessThanOrEqual(halfStep + 1e-6);
    }
  });

  it('phân giải 300m dưới ~4.6mm (như doc 005 §2)', () => {
    expect(scalarStep(MIN, MAX)).toBeLessThan(0.005);
  });

  it('clamp giá trị ngoài dải về biên', () => {
    expect(quantizeScalar(MIN - 999, MIN, MAX)).toBe(0);
    expect(quantizeScalar(MAX + 999, MIN, MAX)).toBe(65535);
  });

  it('idempotent: re-quantize giá trị đã dequantize cho cùng q (quy tắc reconcile §2)', () => {
    for (let q = 0; q <= 65535; q += 137) {
      const v = dequantizeScalar(q, MIN, MAX);
      expect(quantizeScalar(v, MIN, MAX)).toBe(q);
    }
    expect(quantizeScalar(dequantizeScalar(65535, MIN, MAX), MIN, MAX)).toBe(65535);
  });
});

describe('quantize angle (u16 quanh 2π)', () => {
  it('sai số round-trip ≤ nửa bước góc', () => {
    const rng = makeRng(2);
    for (let i = 0; i < 5000; i++) {
      const a = rng() * TWO_PI;
      const back = dequantizeAngle(quantizeAngle(a));
      let diff = Math.abs(back - a);
      if (diff > Math.PI) diff = TWO_PI - diff;
      expect(diff).toBeLessThanOrEqual(ANGLE_STEP / 2 + 1e-9);
    }
  });

  it('wrap-around: góc âm và +2π cho cùng mã', () => {
    expect(quantizeAngle(0)).toBe(0);
    expect(quantizeAngle(TWO_PI)).toBe(0);
    expect(quantizeAngle(-Math.PI / 2)).toBe(quantizeAngle((3 * Math.PI) / 2));
  });
});

describe('quantize velocity (i16 quanh 0)', () => {
  const V_MAX = 40;
  const halfStep = V_MAX / 32767 / 2;

  it('sai số round-trip ≤ nửa bước, đối xứng', () => {
    const rng = makeRng(3);
    for (let i = 0; i < 5000; i++) {
      const v = (rng() * 2 - 1) * V_MAX;
      const back = dequantizeVelocity(quantizeVelocity(v, V_MAX), V_MAX);
      expect(Math.abs(back - v)).toBeLessThanOrEqual(halfStep + 1e-6);
    }
  });

  it('clamp ngoài [-vMax, vMax]', () => {
    expect(quantizeVelocity(V_MAX * 5, V_MAX)).toBe(32767);
    expect(quantizeVelocity(-V_MAX * 5, V_MAX)).toBe(-32767);
  });

  it('0 map về 0', () => {
    expect(quantizeVelocity(0, V_MAX)).toBe(0);
    expect(dequantizeVelocity(0, V_MAX)).toBe(0);
  });
});
