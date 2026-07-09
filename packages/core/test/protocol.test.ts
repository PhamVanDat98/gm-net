import { describe, expect, it } from 'vitest'
import {
  decodePacket,
  encodePacket,
  ProtocolError,
  PROTOCOL_VERSION,
  type Message,
} from '../src/protocol/messages.js'

const roundtrip = (m: Message) => {
  const decoded = decodePacket(encodePacket([m]))
  expect(decoded).toHaveLength(1)
  return decoded[0]!
}

describe('protocol encode/decode', () => {
  it('roundtrips mọi control message', () => {
    const cases: Message[] = [
      { type: 'hello', protocol: PROTOCOL_VERSION, schemaHash: 0xdeadbeef, resumeKey: 'abc' },
      { type: 'hello', protocol: 1, schemaHash: 0 }, // không resumeKey
      { type: 'welcome', clientId: 'c1', serverTime: 1234.5, tickRate: 20, resumeKey: 'rk', resumed: true },
      { type: 'error', code: 'ROOM_FULL', message: 'Room is full' },
      { type: 'roomCreate', roomType: 'chat', options: { name: 'phòng #1' }, private: true },
      { type: 'roomJoin', roomId: 'ABCDE' },
      { type: 'roomJoin', roomType: 'chat' }, // quick-join
      { type: 'roomJoined', roomId: 'ABCDE', roomType: 'chat', metadata: { name: 'phòng #1' } },
      { type: 'roomLeave' },
      { type: 'roomLeft', reason: 'kicked' },
      { type: 'roomListReq', roomType: 'chat' },
      {
        type: 'roomListRes',
        rooms: [{ id: 'A', type: 'chat', players: 3, maxPlayers: 16, metadata: {} }],
      },
    ]
    for (const m of cases) {
      expect(roundtrip(m), `roundtrip ${m.type}`).toMatchObject(m as Record<string, unknown>)
    }
  })

  it('roundtrips data-plane messages (binary, không JSON)', () => {
    const t = 1720000000000.5
    expect(roundtrip({ type: 'ping', clientTime: t })).toEqual({ type: 'ping', clientTime: t })
    expect(roundtrip({ type: 'pong', clientTime: t, serverTime: t + 42 })).toEqual({
      type: 'pong',
      clientTime: t,
      serverTime: t + 42,
    })
    const data = new Uint8Array([1, 2, 3, 255])
    const ev = roundtrip({ type: 'event', channel: 300, data })
    expect(ev.type).toBe('event')
    if (ev.type === 'event') {
      expect(ev.channel).toBe(300)
      expect(new Uint8Array(ev.data)).toEqual(data)
    }
  })

  it('batching: nhiều message trong một packet, giữ thứ tự', () => {
    const packet = encodePacket([
      { type: 'ping', clientTime: 1 },
      { type: 'event', channel: 5, data: new Uint8Array([9]) },
      { type: 'roomLeave' },
    ])
    const decoded = decodePacket(packet)
    expect(decoded.map((m) => m.type)).toEqual(['ping', 'event', 'roomLeave'])
  })

  it('từ chối packet rỗng, message type lạ, JSON hỏng', () => {
    expect(() => decodePacket(new Uint8Array([]))).toThrow(ProtocolError)
    expect(() => decodePacket(new Uint8Array([0x00]))).toThrow(ProtocolError)
    expect(() => decodePacket(new Uint8Array([0xff]))).toThrow(ProtocolError)
    // HELLO với payload không phải JSON
    expect(() => decodePacket(new Uint8Array([0x01, 3, 0x61, 0x62, 0x63]))).toThrow(ProtocolError)
  })

  it('packet cụt (underrun) ném ProtocolError chứ không RangeError trần', () => {
    const packet = encodePacket([{ type: 'ping', clientTime: 123 }])
    expect(() => decodePacket(packet.subarray(0, 4))).toThrow(ProtocolError)
  })

  it('enforce cap: control bytes, event bytes, số message', () => {
    const big = 'x'.repeat(5000)
    const controlPacket = encodePacket([{ type: 'error', code: 'BAD_REQUEST', message: big }])
    expect(() => decodePacket(controlPacket)).toThrow(/exceeds cap/)
    expect(() => decodePacket(controlPacket, { maxControlBytes: 10_000 })).not.toThrow()

    const eventPacket = encodePacket([{ type: 'event', channel: 1, data: new Uint8Array(20_000) }])
    expect(() => decodePacket(eventPacket)).toThrow(/exceeds cap/)

    const many = encodePacket(Array.from({ length: 65 }, () => ({ type: 'ping', clientTime: 1 }) as Message))
    expect(() => decodePacket(many)).toThrow(/exceeds 64 messages/)
  })

  it('validate field: thiếu roomId lẫn roomType trong roomJoin', () => {
    const packet = encodePacket([{ type: 'roomJoin', roomId: 'X' }])
    // sửa payload thành {} — encode tay
    expect(() => decodePacket(encodeRoomJoinEmpty())).toThrow(ProtocolError)
    expect(() => decodePacket(packet)).not.toThrow()
  })

  it('từ chối event channel vượt giới hạn khi encode', () => {
    expect(() => encodePacket([{ type: 'event', channel: 70_000, data: new Uint8Array(0) }])).toThrow(RangeError)
    expect(() => encodePacket([{ type: 'event', channel: 1.5, data: new Uint8Array(0) }])).toThrow(RangeError)
  })
})

function encodeRoomJoinEmpty(): Uint8Array {
  const json = new TextEncoder().encode('{}')
  const out = new Uint8Array(2 + json.length)
  out[0] = 0x11 // ROOM_JOIN
  out[1] = json.length
  out.set(json, 2)
  return out
}
