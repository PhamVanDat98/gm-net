/**
 * Cấu hình game demo-2d dùng chung cho server, client browser và e2e test —
 * quantization/codec PHẢI trùng nhau hai phía ([005] §2), nên chốt một chỗ.
 */
import { ProtocolCodec, type QuantizationConfig, type WorldBounds } from '@gm-net/core';
import { boxInputCodec, type BoxInput } from '@gm-net/shared/box-sim';

/** Khung thế giới 32×18m (tỉ lệ 16:9 cho canvas). */
export const DEMO_BOUNDS: WorldBounds = { minX: -16, maxX: 16, minY: -9, maxY: 9 };

/** Tốc độ tối đa mỗi trục để quantize velocity (m/s). */
export const DEMO_VMAX = 20;

/** Tốc độ box khi |move| = 1 (m/s). */
export const MOVE_SPEED = 8;

export const DEMO_PORT = 2567;
export const PROXY_PORT = 2568;

export const quantization: QuantizationConfig = { world: DEMO_BOUNDS, vMax: DEMO_VMAX };

export function makeDemoCodec(): ProtocolCodec<BoxInput> {
  return new ProtocolCodec<BoxInput>({ quantization, inputCodec: boxInputCodec });
}

/** Chỗ spawn tách xa nhau — box không đè lên nhau lúc vào. */
export const SPAWN_POINTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: -8, y: 0 },
  { x: 8, y: 0 },
  { x: 0, y: 5 },
  { x: 0, y: -5 },
  { x: -8, y: 5 },
  { x: 8, y: -5 },
  { x: -8, y: -5 },
  { x: 8, y: 5 },
];
