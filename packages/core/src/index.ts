// Public API của @gm-net/core — cái gì không re-export ở đây là private (design 003).

export { ByteWriter, ByteReader } from './binary.js'
export { createMemoryPair } from './transport.js'
export type { Transport } from './transport.js'
export { withSimulation, mulberry32 } from './netsim.js'
export type { NetConditions } from './netsim.js'
export {
  PROTOCOL_VERSION,
  MSG,
  MAX_EVENT_CHANNEL,
  ProtocolError,
  encodeMessage,
  encodePacket,
  decodePacket,
} from './protocol/messages.js'
export type {
  Message,
  ErrorCode,
  RoomLeftReason,
  RoomListing,
  DecodeLimits,
} from './protocol/messages.js'
