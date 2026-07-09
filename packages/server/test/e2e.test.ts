import { afterEach, describe, expect, it } from 'vitest'
import {
  createMemoryPair,
  decodePacket,
  encodePacket,
  mulberry32,
  withSimulation,
  type Message,
  type Transport,
} from '@gm-net/core'
import { NetClient, NetError, type ClientRoom } from '@gm-net/client'
import { NetServer, Room, type RoomClient } from '../src/index.js'

const CHAT = 1
const KICK_ME = 99
const enc = new TextEncoder()
const dec = new TextDecoder()
const text = (s: string) => enc.encode(s)

class ChatRoom extends Room<{ name?: string }> {
  override maxClients = 4
  override onCreate(options: { name?: string } | undefined): void {
    this.metadata = { name: options?.name ?? 'phòng chat' }
  }
  override onMessage(client: RoomClient, channel: number, data: Uint8Array): void {
    if (channel === KICK_ME) {
      client.kick()
      return
    }
    this.broadcast(channel, data)
  }
}

const servers: NetServer[] = []
const clients: NetClient[] = []

function makeServer(options?: ConstructorParameters<typeof NetServer>[0]): NetServer {
  const server = new NetServer(options)
  server.define('chat', ChatRoom)
  servers.push(server)
  return server
}

function makeClient(server: NetServer, options?: ConstructorParameters<typeof NetClient>[1]) {
  const state = { last: null as Transport | null }
  const client = new NetClient(async () => {
    const [clientSide, serverSide] = createMemoryPair()
    server.handleConnection(serverSide)
    state.last = clientSide
    return clientSide
  }, { reconnectDelaysMs: [10, 20, 40], ...options })
  clients.push(client)
  return { client, state }
}

afterEach(() => {
  for (const c of clients) c.close()
  for (const s of servers) s.close()
  clients.length = 0
  servers.length = 0
})

async function waitFor<T>(fn: () => T | undefined | null | false, what = 'condition', timeoutMs = 3000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('e2e: handshake & lobby', () => {
  it('connect: nhận clientId, resumeKey, status connected', async () => {
    const server = makeServer()
    const { client } = makeClient(server)
    await client.connect()
    expect(client.status).toBe('connected')
    expect(client.clientId).toMatch(/^c_/)
    expect(client.resumeKey).toHaveLength(32)
    expect(server.sessionCount).toBe(1)
  })

  it('create → quickJoin → broadcast chat 2 chiều', async () => {
    const server = makeServer()
    const { client: alice } = makeClient(server)
    const { client: bob } = makeClient(server)
    await alice.connect()
    await bob.connect()

    const aliceRoom = await alice.createRoom('chat', { name: 'sảnh' })
    expect(aliceRoom.metadata).toEqual({ name: 'sảnh' })

    const bobRoom = await bob.quickJoin('chat')
    expect(bobRoom.id).toBe(aliceRoom.id)

    const aliceGot: string[] = []
    const bobGot: string[] = []
    aliceRoom.onEvent(CHAT, (_ch, d) => aliceGot.push(dec.decode(d)))
    bobRoom.onEvent(CHAT, (_ch, d) => bobGot.push(dec.decode(d)))

    bobRoom.send(CHAT, text('chào Alice'))
    await waitFor(() => aliceGot.length > 0 && bobGot.length > 0, 'chat broadcast')
    expect(aliceGot).toEqual(['chào Alice'])
    expect(bobGot).toEqual(['chào Alice']) // broadcast gồm cả người gửi
  })

  it('listRooms: room public hiện với số người, room private ẩn', async () => {
    const server = makeServer()
    const { client: a } = makeClient(server)
    const { client: b } = makeClient(server)
    const { client: c } = makeClient(server)
    await Promise.all([a.connect(), b.connect(), c.connect()])

    const publicRoom = await a.createRoom('chat', { name: 'công khai' })
    await b.createRoom('chat', { name: 'bí mật' }, { private: true })

    const listing = await c.listRooms('chat')
    expect(listing).toHaveLength(1)
    expect(listing[0]).toMatchObject({
      id: publicRoom.id,
      type: 'chat',
      players: 1,
      maxPlayers: 4,
      metadata: { name: 'công khai' },
    })
  })

  it('joinRoom theo mã; ROOM_FULL khi hết chỗ; quickJoin không có phòng → ROOM_NOT_FOUND', async () => {
    const server = makeServer()
    const members = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const { client } = makeClient(server)
        await client.connect()
        return client
      }),
    )
    const room = await members[0]!.createRoom('chat')
    await members[1]!.joinRoom(room.id)
    await members[2]!.joinRoom(room.id)
    await members[3]!.joinRoom(room.id) // đủ 4/4

    await expect(members[4]!.joinRoom(room.id)).rejects.toMatchObject({ code: 'ROOM_FULL' })
    await expect(members[4]!.joinRoom('XXXXX')).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' })
    await expect(members[4]!.quickJoin('nonexistent-type')).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' })
    await expect(members[3]!.createRoom('chat')).rejects.toMatchObject({ code: 'ALREADY_IN_ROOM' })
  })

  it('leave: room dispose khi trống; kick đẩy client ra với reason kicked', async () => {
    const server = makeServer()
    const { client: alice } = makeClient(server)
    const { client: bob } = makeClient(server)
    await Promise.all([alice.connect(), bob.connect()])

    const aliceRoom = await alice.createRoom('chat')
    const bobRoom = await bob.joinRoom(aliceRoom.id)
    expect(server.roomCount).toBe(1)

    const bobLeftReason = new Promise((resolve) => bobRoom.onLeave(resolve))
    bobRoom.send(KICK_ME, text('')) // ChatRoom sẽ kick người gửi channel 99
    expect(await bobLeftReason).toBe('kicked')
    expect(bob.room).toBeNull()

    await aliceRoom.leave()
    expect(alice.room).toBeNull()
    await waitFor(() => server.roomCount === 0, 'room disposed')
  })
})

describe('e2e: resume & độ bền', () => {
  it('rớt mạng → tự reconnect với resumeKey, giữ nguyên session và room', async () => {
    const server = makeServer()
    const { client: alice } = makeClient(server)
    const { client: bob, state: bobState } = makeClient(server)
    await Promise.all([alice.connect(), bob.connect()])

    const aliceRoom = await alice.createRoom('chat')
    const bobRoom = await bob.joinRoom(aliceRoom.id)
    const bobId = bob.clientId

    const statuses: string[] = []
    bob.onStatus((s) => statuses.push(s))

    bobState.last!.close() // giả lập đứt mạng (không phải client.close())
    await waitFor(() => bob.status === 'connected', 'reconnect')

    expect(statuses).toEqual(['reconnecting', 'connected'])
    expect(bob.clientId).toBe(bobId) // vẫn session cũ
    expect(bob.room).toBe(bobRoom) // vẫn room cũ, không phải object mới
    expect(server.sessionCount).toBe(2)

    // Chat vẫn chạy sau resume
    const aliceGot: string[] = []
    aliceRoom.onEvent(CHAT, (_ch, d) => aliceGot.push(dec.decode(d)))
    bobRoom.send(CHAT, text('vẫn sống!'))
    await waitFor(() => aliceGot.length > 0, 'chat after resume')
    expect(aliceGot).toEqual(['vẫn sống!'])
  })

  it('spam event vượt rate limit → ERROR RATE_LIMITED + đóng kết nối', async () => {
    const server = makeServer({ dataRatePerSec: 5 }) // burst 10
    const { client } = makeClient(server, { reconnect: false })
    await client.connect()
    await client.createRoom('chat')

    const errors: NetError[] = []
    client.onError((e) => errors.push(e))

    for (let i = 0; i < 30 && client.status === 'connected'; i++) {
      try {
        client.room!.send(CHAT, text(`spam ${i}`))
      } catch {
        break // transport đóng giữa chừng — đúng kỳ vọng
      }
      await new Promise((r) => setTimeout(r, 1))
    }

    await waitFor(() => client.status === 'closed', 'client closed by rate limit')
    expect(errors.some((e) => e.code === 'RATE_LIMITED')).toBe(true)
  })

  it('HELLO sai protocol version → ERROR PROTOCOL_MISMATCH rồi đóng', async () => {
    const server = makeServer()
    const [clientSide, serverSide] = createMemoryPair()
    server.handleConnection(serverSide)

    const received: Message[] = []
    clientSide.onMessage((d) => received.push(...decodePacket(d)))
    const closeReason = new Promise((resolve) => clientSide.onClose(resolve))

    clientSide.send(encodePacket([{ type: 'hello', protocol: 99, schemaHash: 0 }]))
    expect(await closeReason).toBe('protocol mismatch')
    expect(received[0]).toMatchObject({ type: 'error', code: 'PROTOCOL_MISMATCH' })
  })

  it('toàn bộ flow chạy được qua mạng giả lập 30ms latency + jitter', async () => {
    const server = makeServer()
    const rng = mulberry32(2026)
    const client = new NetClient(async () => {
      const [clientSide, serverSide] = createMemoryPair()
      server.handleConnection(serverSide)
      return withSimulation(clientSide, { latencyMs: 30, jitterMs: 10 }, rng)
    })
    clients.push(client)

    await client.connect()
    const room = await client.createRoom('chat', { name: 'lag' })
    const got: string[] = []
    room.onEvent(CHAT, (_ch, d) => got.push(dec.decode(d)))
    room.send(CHAT, text('xuyên qua lag'))
    await waitFor(() => got.length > 0, 'echo through simulated latency')
    expect(got).toEqual(['xuyên qua lag'])
  })
})
