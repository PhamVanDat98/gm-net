export { FixedTimestep, type FixedTimestepOptions } from './fixed-timestep.js';
export { TickRing } from './tick-ring.js';

export {
  BitWriter,
  BitReader,
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
} from './serialization/index.js';

export {
  PROTOCOL_VERSION,
  MessageType,
  seqGreater,
  seqGreaterEqual,
  seqDistance,
  ProtocolCodec,
  ProtocolError,
  peekMessageType,
  type ProtocolCodecOptions,
  type CustomCodec,
  type Snapshot,
  type SnapshotEntity,
  type InputMessage,
  type InputEntry,
  type PingMessage,
  type PongMessage,
} from './protocol/index.js';
