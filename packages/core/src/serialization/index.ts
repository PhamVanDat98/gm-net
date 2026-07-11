export { BitWriter } from './bit-writer.js';
export { BitReader } from './bit-reader.js';
export {
  quantizeScalar,
  dequantizeScalar,
  scalarStep,
  quantizeAngle,
  dequantizeAngle,
  ANGLE_STEP,
  quantizeVelocity,
  dequantizeVelocity,
  type WorldBounds,
  type QuantizationConfig,
} from './quantize.js';
