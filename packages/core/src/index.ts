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
  NO_ACK_TICK,
  MessageType,
  DeltaField,
  seqGreater,
  seqGreaterEqual,
  seqDistance,
  u32TimeDelta,
  ProtocolCodec,
  ProtocolError,
  peekMessageType,
  applySnapshotDelta,
  type ProtocolCodecOptions,
  type CustomCodec,
  type Snapshot,
  type SnapshotEntity,
  type SnapshotBaseline,
  type SnapshotDelta,
  type DeltaEntity,
  type InputMessage,
  type InputEntry,
  type PingMessage,
  type PongMessage,
} from './protocol/index.js';
