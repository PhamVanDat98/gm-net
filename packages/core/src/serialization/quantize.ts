/**
 * Quantization helpers ([docs/design/005-serialization.md] §2).
 *
 * - **Position:** map dải thế giới `[min, max]` vào u16 (65536 mức).
 * - **Rotation 2D:** góc → u16 trên trọn vòng 2π (wrap-around).
 * - **Velocity:** dải `[-vMax, vMax]` → i16 per trục.
 *
 * Quy tắc quan trọng ([005] §2): khi reconcile, so *giá trị đã quantize* với
 * *giá trị đã quantize* — nếu không sai số quantize bị đọc nhầm thành
 * misprediction. Vì thế các hàm này là điểm tham chiếu duy nhất cho cả hai phía.
 */

const U16_MAX = 65535;
/** Đối xứng quanh 0 nên bỏ mức -32768 để +/- cùng bước. */
const I16_MAX = 32767;
const TWO_PI = Math.PI * 2;

/** Biên thế giới game (config của game trong `shared`, không hard-code framework). */
export interface WorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Tham số quantize dùng chung cho encode/decode transform. */
export interface QuantizationConfig {
  world: WorldBounds;
  /** Tốc độ tối đa mỗi trục (m/s) để map velocity vào i16. */
  vMax: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Map `value ∈ [min, max]` vào u16 `[0, 65535]`. Ngoài dải → clamp. */
export function quantizeScalar(value: number, min: number, max: number): number {
  const span = max - min;
  const t = span > 0 ? (value - min) / span : 0;
  return Math.round(clamp(t, 0, 1) * U16_MAX);
}

/** Nghịch đảo {@link quantizeScalar}. */
export function dequantizeScalar(q: number, min: number, max: number): number {
  return min + (q / U16_MAX) * (max - min);
}

/** Bước lượng tử (sai số tối đa = nửa giá trị này) của một dải scalar. */
export function scalarStep(min: number, max: number): number {
  return (max - min) / U16_MAX;
}

/** Góc radian (bất kỳ) → u16 trên trọn vòng 2π. */
export function quantizeAngle(rad: number): number {
  let a = rad % TWO_PI;
  if (a < 0) a += TWO_PI;
  // 65536 mức trên vòng tròn; 65536 wrap về 0 (≡ 2π) qua & 0xffff.
  return Math.round((a / TWO_PI) * 65536) & 0xffff;
}

/** Nghịch đảo {@link quantizeAngle}, trả về góc trong `[0, 2π)`. */
export function dequantizeAngle(q: number): number {
  return (q / 65536) * TWO_PI;
}

/** Sai số góc tối đa (radian) = nửa bước lượng tử. */
export const ANGLE_STEP = TWO_PI / 65536;

/** Velocity `[-vMax, vMax]` → i16. Ngoài dải → clamp. */
export function quantizeVelocity(value: number, vMax: number): number {
  const t = vMax > 0 ? clamp(value / vMax, -1, 1) : 0;
  return Math.round(t * I16_MAX);
}

/** Nghịch đảo {@link quantizeVelocity}. */
export function dequantizeVelocity(q: number, vMax: number): number {
  return (q / I16_MAX) * vMax;
}
