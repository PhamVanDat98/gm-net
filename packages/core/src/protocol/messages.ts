/**
 * Message encode/decode theo design 002.
 * Control plane = JSON trong envelope binary; data plane = binary thuần.
 * Một packet = nhiều message nối tiếp; parser tự biết độ dài từ msgType.
 */

import { ByteReader, ByteWriter } from '../binary.js'

export const PROTOCOL_VERSION = 1

export const MSG = {
  HELLO: 0x01,
  WELCOME: 0x02,
  ERROR: 0x03,
  PING: 0x04,
  PONG: 0x05,
  ROOM_CREATE: 0x10,
  ROOM_JOIN: 0x11,
  ROOM_JOINED: 0x12,
  ROOM_LEAVE: 0x13,
  ROOM_LIST_REQ: 0x14,
  ROOM_LIST_RES: 0x15,
  ROOM_LEFT: 0x16,
  // 0x20 INPUT, 0x21 SNAPSHOT, 0x22 DELTA — Phase 2/3
  EVENT: 0x23,
} as const

export type ErrorCode =
  | 'PROTOCOL_MISMATCH'
  | 'SCHEMA_MISMATCH'
  | 'ROOM_FULL'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_TYPE_UNKNOWN'
  | 'ALREADY_IN_ROOM'
  | 'NOT_IN_ROOM'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'

export type RoomLeftReason = 'left' | 'kicked' | 'room_closed' | 'session_lost'

const ROOM_LEFT_REASONS: readonly RoomLeftReason[] = ['left', 'kicked', 'room_closed', 'session_lost']

export interface RoomListing {
  id: string
  type: string
  players: number
  maxPlayers: number
  metadata: Record<string, unknown>
}

export type Message =
  | { type: 'hello'; protocol: number; schemaHash: number; resumeKey?: string }
  | { type: 'welcome'; clientId: string; serverTime: number; tickRate: number; resumeKey: string; resumed: boolean }
  | { type: 'error'; code: ErrorCode; message: string }
  | { type: 'ping'; clientTime: number }
  | { type: 'pong'; clientTime: number; serverTime: number }
  | { type: 'roomCreate'; roomType: string; options?: unknown; private?: boolean }
  | { type: 'roomJoin'; roomId?: string; roomType?: string }
  | { type: 'roomJoined'; roomId: string; roomType: string; metadata: Record<string, unknown> }
  | { type: 'roomLeave' }
  | { type: 'roomLeft'; reason: RoomLeftReason }
  | { type: 'roomListReq'; roomType?: string }
  | { type: 'roomListRes'; rooms: RoomListing[] }
  | { type: 'event'; channel: number; data: Uint8Array }

export interface DecodeLimits {
  /** Cap payload JSON control plane (bytes). Mặc định 4096. */
  maxControlBytes?: number
  /** Cap payload EVENT (bytes). Mặc định 16384. */
  maxEventBytes?: number
  /** Cap số message trong một packet. Mặc định 64. */
  maxMessagesPerPacket?: number
}

export const MAX_EVENT_CHANNEL = 65535

/** Packet không hợp lệ — bên nhận nên đóng kết nối (design 002). */
export class ProtocolError extends Error {
  override name = 'ProtocolError'
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function writeJson(w: ByteWriter, value: unknown): void {
  const bytes = textEncoder.encode(JSON.stringify(value))
  w.varint(bytes.length)
  w.bytes(bytes)
}

function readJson(r: ByteReader, cap: number): Record<string, unknown> {
  const length = r.varint()
  if (length > cap) {
    throw new ProtocolError(`Control payload ${length}B exceeds cap ${cap}B`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(textDecoder.decode(r.bytes(length)))
  } catch {
    throw new ProtocolError('Control payload is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError('Control payload must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function reqString(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new ProtocolError(`Field '${name}' must be a string`)
  return v
}

function reqNumber(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ProtocolError(`Field '${name}' must be a number`)
  return v
}

function optString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined
  return reqString(v, name)
}

function asMetadata(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new ProtocolError('metadata must be a JSON object')
  return v as Record<string, unknown>
}

export function encodeMessage(w: ByteWriter, m: Message): void {
  switch (m.type) {
    case 'hello':
      w.u8(MSG.HELLO)
      writeJson(w, { protocol: m.protocol, schemaHash: m.schemaHash, resumeKey: m.resumeKey })
      break
    case 'welcome':
      w.u8(MSG.WELCOME)
      writeJson(w, {
        clientId: m.clientId,
        serverTime: m.serverTime,
        tickRate: m.tickRate,
        resumeKey: m.resumeKey,
        resumed: m.resumed,
      })
      break
    case 'error':
      w.u8(MSG.ERROR)
      writeJson(w, { code: m.code, message: m.message })
      break
    case 'ping':
      w.u8(MSG.PING)
      w.f64(m.clientTime)
      break
    case 'pong':
      w.u8(MSG.PONG)
      w.f64(m.clientTime)
      w.f64(m.serverTime)
      break
    case 'roomCreate':
      w.u8(MSG.ROOM_CREATE)
      writeJson(w, { roomType: m.roomType, options: m.options, private: m.private })
      break
    case 'roomJoin':
      w.u8(MSG.ROOM_JOIN)
      writeJson(w, { roomId: m.roomId, roomType: m.roomType })
      break
    case 'roomJoined':
      w.u8(MSG.ROOM_JOINED)
      writeJson(w, { roomId: m.roomId, roomType: m.roomType, metadata: m.metadata })
      break
    case 'roomLeave':
      w.u8(MSG.ROOM_LEAVE)
      writeJson(w, {})
      break
    case 'roomLeft':
      w.u8(MSG.ROOM_LEFT)
      writeJson(w, { reason: m.reason })
      break
    case 'roomListReq':
      w.u8(MSG.ROOM_LIST_REQ)
      writeJson(w, { roomType: m.roomType })
      break
    case 'roomListRes':
      w.u8(MSG.ROOM_LIST_RES)
      writeJson(w, { rooms: m.rooms })
      break
    case 'event': {
      if (!Number.isInteger(m.channel) || m.channel < 0 || m.channel > MAX_EVENT_CHANNEL) {
        throw new RangeError(`Event channel must be an integer in [0, ${MAX_EVENT_CHANNEL}], got ${m.channel}`)
      }
      w.u8(MSG.EVENT)
      w.varint(m.channel)
      w.varint(m.data.length)
      w.bytes(m.data)
      break
    }
  }
}

export function encodePacket(messages: Message[]): Uint8Array {
  const w = new ByteWriter()
  for (const m of messages) encodeMessage(w, m)
  return w.finish()
}

function decodeMessage(r: ByteReader, controlCap: number, eventCap: number): Message {
  const typeId = r.u8()
  switch (typeId) {
    case MSG.HELLO: {
      const j = readJson(r, controlCap)
      return {
        type: 'hello',
        protocol: reqNumber(j.protocol, 'protocol'),
        schemaHash: reqNumber(j.schemaHash, 'schemaHash'),
        resumeKey: optString(j.resumeKey, 'resumeKey'),
      }
    }
    case MSG.WELCOME: {
      const j = readJson(r, controlCap)
      return {
        type: 'welcome',
        clientId: reqString(j.clientId, 'clientId'),
        serverTime: reqNumber(j.serverTime, 'serverTime'),
        tickRate: reqNumber(j.tickRate, 'tickRate'),
        resumeKey: reqString(j.resumeKey, 'resumeKey'),
        resumed: j.resumed === true,
      }
    }
    case MSG.ERROR: {
      const j = readJson(r, controlCap)
      return {
        type: 'error',
        code: reqString(j.code, 'code') as ErrorCode,
        message: reqString(j.message, 'message'),
      }
    }
    case MSG.PING:
      return { type: 'ping', clientTime: r.f64() }
    case MSG.PONG:
      return { type: 'pong', clientTime: r.f64(), serverTime: r.f64() }
    case MSG.ROOM_CREATE: {
      const j = readJson(r, controlCap)
      return {
        type: 'roomCreate',
        roomType: reqString(j.roomType, 'roomType'),
        options: j.options,
        private: j.private === true,
      }
    }
    case MSG.ROOM_JOIN: {
      const j = readJson(r, controlCap)
      const roomId = optString(j.roomId, 'roomId')
      const roomType = optString(j.roomType, 'roomType')
      if (!roomId && !roomType) throw new ProtocolError('roomJoin requires roomId or roomType')
      return { type: 'roomJoin', roomId, roomType }
    }
    case MSG.ROOM_JOINED: {
      const j = readJson(r, controlCap)
      return {
        type: 'roomJoined',
        roomId: reqString(j.roomId, 'roomId'),
        roomType: reqString(j.roomType, 'roomType'),
        metadata: asMetadata(j.metadata),
      }
    }
    case MSG.ROOM_LEAVE:
      readJson(r, controlCap)
      return { type: 'roomLeave' }
    case MSG.ROOM_LEFT: {
      const j = readJson(r, controlCap)
      const reason = reqString(j.reason, 'reason') as RoomLeftReason
      if (!ROOM_LEFT_REASONS.includes(reason)) throw new ProtocolError(`Unknown roomLeft reason '${reason}'`)
      return { type: 'roomLeft', reason }
    }
    case MSG.ROOM_LIST_REQ: {
      const j = readJson(r, controlCap)
      return { type: 'roomListReq', roomType: optString(j.roomType, 'roomType') }
    }
    case MSG.ROOM_LIST_RES: {
      const j = readJson(r, controlCap)
      if (!Array.isArray(j.rooms)) throw new ProtocolError("Field 'rooms' must be an array")
      const rooms: RoomListing[] = j.rooms.map((raw: unknown) => {
        if (typeof raw !== 'object' || raw === null) throw new ProtocolError('Room listing must be an object')
        const o = raw as Record<string, unknown>
        return {
          id: reqString(o.id, 'rooms[].id'),
          type: reqString(o.type, 'rooms[].type'),
          players: reqNumber(o.players, 'rooms[].players'),
          maxPlayers: reqNumber(o.maxPlayers, 'rooms[].maxPlayers'),
          metadata: asMetadata(o.metadata),
        }
      })
      return { type: 'roomListRes', rooms }
    }
    case MSG.EVENT: {
      const channel = r.varint()
      if (channel > MAX_EVENT_CHANNEL) throw new ProtocolError(`Event channel ${channel} exceeds ${MAX_EVENT_CHANNEL}`)
      const length = r.varint()
      if (length > eventCap) throw new ProtocolError(`Event payload ${length}B exceeds cap ${eventCap}B`)
      return { type: 'event', channel, data: r.bytes(length) }
    }
    default:
      throw new ProtocolError(`Unknown message type 0x${typeId.toString(16)}`)
  }
}

export function decodePacket(bytes: Uint8Array, limits: DecodeLimits = {}): Message[] {
  const { maxControlBytes = 4096, maxEventBytes = 16384, maxMessagesPerPacket = 64 } = limits
  const r = new ByteReader(bytes)
  const messages: Message[] = []
  try {
    while (r.remaining > 0) {
      if (messages.length >= maxMessagesPerPacket) {
        throw new ProtocolError(`Packet exceeds ${maxMessagesPerPacket} messages`)
      }
      messages.push(decodeMessage(r, maxControlBytes, maxEventBytes))
    }
  } catch (err) {
    // RangeError từ ByteReader (buffer underrun) cũng là packet hỏng
    if (err instanceof RangeError) throw new ProtocolError(err.message)
    throw err
  }
  if (messages.length === 0) throw new ProtocolError('Empty packet')
  return messages
}
