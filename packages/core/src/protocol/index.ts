export { PROTOCOL_VERSION, MessageType } from './constants.js';
export {
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
} from './messages.js';
