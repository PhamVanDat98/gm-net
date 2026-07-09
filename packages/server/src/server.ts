import {
  decodePacket,
  encodePacket,
  PROTOCOL_VERSION,
  ProtocolError,
  type DecodeLimits,
  type ErrorCode,
  type Message,
  type RoomLeftReason,
  type RoomListing,
  type Transport,
} from '@gm-net/core'
import { Room, type RoomClient, type RoomConstructor } from './room.js'

export interface NetServerOptions {
  /** Hash schema state (Phase 2). 0 khi chưa dùng schema. */
  schemaHash?: number
  /** Quảng bá trong WELCOME cho client biết nhịp server (Phase 2 mới dùng thật). */
  tickRate?: number
  /** Client phải gửi HELLO trong khoảng này sau khi kết nối. */
  helloTimeoutMs?: number
  /** Giữ session sau khi rớt mạng, chờ resume. */
  graceMs?: number
  /** Không nhận được message nào (kể cả PING) trong khoảng này → coi như rớt. */
  heartbeatTimeoutMs?: number
  /** Rate limit control plane (msg/s), burst = 2×. */
  controlRatePerSec?: number
  /** Rate limit data plane (msg/s), burst = 2×. */
  dataRatePerSec?: number
  decodeLimits?: DecodeLimits
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // bỏ I,O,0,1 dễ nhầm

function randomChars(alphabet: string, length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length]
  return out
}

class TokenBucket {
  private tokens: number
  private last: number

  constructor(private ratePerSec: number, private burst: number) {
    this.tokens = burst
    this.last = Date.now()
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec)
    this.last = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

class Session {
  transport: Transport | null
  room: Room | null = null
  client: ServerClient
  lastSeen = Date.now()
  /** Khác null khi đang rớt mạng — quá hạn thì session bị hủy. */
  graceDeadline: number | null = null
  control: TokenBucket
  data: TokenBucket

  constructor(
    readonly id: string,
    readonly resumeKey: string,
    transport: Transport,
    server: NetServer,
    controlRate: number,
    dataRate: number,
  ) {
    this.transport = transport
    this.client = new ServerClient(this, server)
    this.control = new TokenBucket(controlRate, controlRate * 2)
    this.data = new TokenBucket(dataRate, dataRate * 2)
  }

  send(message: Message): void {
    if (this.transport?.isOpen) this.transport.send(encodePacket([message]))
  }
}

class ServerClient implements RoomClient {
  data: unknown = undefined

  constructor(
    private session: Session,
    private server: NetServer,
  ) {}

  get id(): string {
    return this.session.id
  }

  get isConnected(): boolean {
    return this.session.transport?.isOpen === true
  }

  sendEvent(channel: number, data: Uint8Array): void {
    this.session.send({ type: 'event', channel, data })
  }

  kick(): void {
    this.server._leaveRoom(this.session, 'kicked')
  }
}

export class NetServer {
  private roomTypes = new Map<string, RoomConstructor>()
  private rooms = new Map<string, Room>()
  private sessions = new Map<string, Session>()
  private byResumeKey = new Map<string, Session>()
  private sweepTimer: ReturnType<typeof setInterval>
  private closed = false

  private readonly schemaHash: number
  private readonly tickRate: number
  private readonly helloTimeoutMs: number
  private readonly graceMs: number
  private readonly heartbeatTimeoutMs: number
  private readonly controlRatePerSec: number
  private readonly dataRatePerSec: number
  private readonly decodeLimits: DecodeLimits

  constructor(options: NetServerOptions = {}) {
    this.schemaHash = options.schemaHash ?? 0
    this.tickRate = options.tickRate ?? 20
    this.helloTimeoutMs = options.helloTimeoutMs ?? 5000
    this.graceMs = options.graceMs ?? 30_000
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 15_000
    this.controlRatePerSec = options.controlRatePerSec ?? 5
    this.dataRatePerSec = options.dataRatePerSec ?? 60
    this.decodeLimits = options.decodeLimits ?? {}
    this.sweepTimer = setInterval(() => this.sweep(), 1000)
  }

  /** Đăng ký một loại room. Gọi trước khi nhận kết nối. */
  define(type: string, ctor: RoomConstructor): void {
    this.roomTypes.set(type, ctor)
  }

  /** Gắn một kết nối mới (từ bất kỳ listener nào: ws, memory pair, netsim...). */
  handleConnection(transport: Transport): void {
    if (this.closed) {
      transport.close('server closed')
      return
    }
    const holder: { session: Session | null } = { session: null }
    const helloTimer = setTimeout(() => {
      if (!holder.session) transport.close('hello timeout')
    }, this.helloTimeoutMs)

    transport.onMessage((bytes) => {
      let messages: Message[]
      try {
        messages = decodePacket(bytes, this.decodeLimits)
      } catch (err) {
        if (err instanceof ProtocolError) {
          transport.close('protocol error')
          return
        }
        throw err
      }
      for (const m of messages) {
        if (holder.session) {
          this.dispatch(holder.session, m)
        } else if (m.type === 'hello') {
          clearTimeout(helloTimer)
          holder.session = this.handleHello(transport, m)
          if (!holder.session) return // bị từ chối, transport đã đóng
        } else {
          this.sendError(transport, 'BAD_REQUEST', 'Expected HELLO first')
          transport.close('no hello')
          return
        }
      }
    })

    transport.onClose(() => {
      clearTimeout(helloTimer)
      const session = holder.session
      if (session && session.transport === transport) {
        session.transport = null
        session.graceDeadline = Date.now() + this.graceMs
      }
    })
  }

  close(): void {
    this.closed = true
    clearInterval(this.sweepTimer)
    for (const session of [...this.sessions.values()]) {
      session.transport?.close('server closed')
      this.destroySession(session)
    }
    this.rooms.clear()
  }

  get roomCount(): number {
    return this.rooms.size
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  // ---- internal ----

  private handleHello(
    transport: Transport,
    m: Extract<Message, { type: 'hello' }>,
  ): Session | null {
    if (m.protocol !== PROTOCOL_VERSION) {
      this.sendError(transport, 'PROTOCOL_MISMATCH', `Server speaks protocol ${PROTOCOL_VERSION}, client sent ${m.protocol}`)
      transport.close('protocol mismatch')
      return null
    }
    if (m.schemaHash !== this.schemaHash) {
      this.sendError(transport, 'SCHEMA_MISMATCH', 'Client schema differs from server — rebuild client with the shared schema module')
      transport.close('schema mismatch')
      return null
    }

    // Resume session cũ nếu resumeKey hợp lệ
    if (m.resumeKey) {
      const existing = this.byResumeKey.get(m.resumeKey)
      if (existing) {
        existing.transport?.close('replaced by resumed connection')
        existing.transport = transport
        existing.graceDeadline = null
        existing.lastSeen = Date.now()
        this.sendWelcome(existing, true)
        return existing
      }
      // resumeKey hết hạn → rơi xuống tạo session mới (resumed=false, client tự biết)
    }

    const session = new Session(
      'c_' + randomChars('abcdefghijklmnopqrstuvwxyz0123456789', 12),
      randomChars('abcdef0123456789', 32),
      transport,
      this,
      this.controlRatePerSec,
      this.dataRatePerSec,
    )
    this.sessions.set(session.id, session)
    this.byResumeKey.set(session.resumeKey, session)
    this.sendWelcome(session, false)
    return session
  }

  private sendWelcome(session: Session, resumed: boolean): void {
    session.send({
      type: 'welcome',
      clientId: session.id,
      serverTime: Date.now(),
      tickRate: this.tickRate,
      resumeKey: session.resumeKey,
      resumed,
    })
  }

  private dispatch(session: Session, m: Message): void {
    session.lastSeen = Date.now()
    const isControl = m.type !== 'ping' && m.type !== 'event'
    const bucket = isControl ? session.control : session.data
    if (!bucket.take()) {
      session.send({ type: 'error', code: 'RATE_LIMITED', message: `Too many ${isControl ? 'control' : 'data'} messages` })
      session.transport?.close('rate limited')
      return
    }

    switch (m.type) {
      case 'ping':
        session.send({ type: 'pong', clientTime: m.clientTime, serverTime: Date.now() })
        break
      case 'roomCreate':
        this.handleRoomCreate(session, m)
        break
      case 'roomJoin':
        this.handleRoomJoin(session, m)
        break
      case 'roomLeave':
        if (!session.room) {
          session.send({ type: 'error', code: 'NOT_IN_ROOM', message: 'Not in a room' })
          break
        }
        this._leaveRoom(session, 'left')
        break
      case 'roomListReq':
        session.send({ type: 'roomListRes', rooms: this.listRooms(m.roomType) })
        break
      case 'event': {
        const room = session.room
        if (!room) {
          session.send({ type: 'error', code: 'NOT_IN_ROOM', message: 'Join a room before sending events' })
          break
        }
        room.onMessage?.(session.client, m.channel, m.data)
        break
      }
      case 'hello':
        session.send({ type: 'error', code: 'BAD_REQUEST', message: 'Duplicate HELLO' })
        break
      default:
        // Message chỉ server được gửi (welcome, pong, roomJoined...) mà client lại gửi lên
        session.send({ type: 'error', code: 'BAD_REQUEST', message: `Unexpected ${m.type} from client` })
        break
    }
  }

  private handleRoomCreate(session: Session, m: Extract<Message, { type: 'roomCreate' }>): void {
    if (session.room) {
      session.send({ type: 'error', code: 'ALREADY_IN_ROOM', message: 'Leave current room first' })
      return
    }
    const ctor = this.roomTypes.get(m.roomType)
    if (!ctor) {
      session.send({ type: 'error', code: 'ROOM_TYPE_UNKNOWN', message: `Room type '${m.roomType}' is not defined` })
      return
    }

    const room = new ctor()
    let id: string
    do {
      id = randomChars(ROOM_CODE_ALPHABET, 5)
    } while (this.rooms.has(id))
    Object.assign(room, { id, type: m.roomType })
    if (m.private) room.isPrivate = true
    room._internal = {
      broadcast: (channel, data, exceptClientId) => {
        const packet = encodePacket([{ type: 'event', channel, data }])
        for (const client of room.clients.values()) {
          if (client.id === exceptClientId) continue
          const s = this.sessions.get(client.id)
          if (s?.transport?.isOpen) s.transport.send(packet)
        }
      },
      closeRoom: () => this.disposeRoom(room, 'room_closed'),
      kick: (clientId) => {
        const s = this.sessions.get(clientId)
        if (s && s.room === room) this._leaveRoom(s, 'kicked')
      },
    }
    this.rooms.set(id, room)
    room.onCreate?.(m.options)
    this.joinRoom(session, room)
  }

  private handleRoomJoin(session: Session, m: Extract<Message, { type: 'roomJoin' }>): void {
    if (session.room) {
      session.send({ type: 'error', code: 'ALREADY_IN_ROOM', message: 'Leave current room first' })
      return
    }
    let room: Room | undefined
    if (m.roomId) {
      room = this.rooms.get(m.roomId)
      if (!room) {
        session.send({ type: 'error', code: 'ROOM_NOT_FOUND', message: `No room '${m.roomId}'` })
        return
      }
    } else {
      // quick-join: room public đầu tiên cùng loại còn chỗ
      for (const candidate of this.rooms.values()) {
        if (candidate.type === m.roomType && !candidate.isPrivate && candidate.clients.size < candidate.maxClients) {
          room = candidate
          break
        }
      }
      if (!room) {
        session.send({ type: 'error', code: 'ROOM_NOT_FOUND', message: `No open '${m.roomType}' room to quick-join` })
        return
      }
    }
    if (room.clients.size >= room.maxClients) {
      session.send({ type: 'error', code: 'ROOM_FULL', message: `Room '${room.id}' is full (${room.maxClients})` })
      return
    }
    this.joinRoom(session, room)
  }

  private joinRoom(session: Session, room: Room): void {
    room.clients.set(session.id, session.client)
    session.room = room
    session.send({ type: 'roomJoined', roomId: room.id, roomType: room.type, metadata: room.metadata })
    room.onJoin?.(session.client)
  }

  /** @internal Rời room + báo client. Dispose room khi trống. */
  _leaveRoom(session: Session, reason: RoomLeftReason): void {
    const room = session.room
    if (!room) return
    room.clients.delete(session.id)
    session.room = null
    room.onLeave?.(session.client, reason)
    session.send({ type: 'roomLeft', reason })
    if (room.clients.size === 0) this.disposeRoom(room, 'room_closed')
  }

  private disposeRoom(room: Room, reason: RoomLeftReason): void {
    for (const client of [...room.clients.values()]) {
      const s = this.sessions.get(client.id)
      if (s) {
        room.clients.delete(s.id)
        s.room = null
        room.onLeave?.(s.client, reason)
        s.send({ type: 'roomLeft', reason })
      }
    }
    this.rooms.delete(room.id)
    room.onDispose?.()
  }

  private listRooms(roomType?: string): RoomListing[] {
    const out: RoomListing[] = []
    for (const room of this.rooms.values()) {
      if (room.isPrivate) continue
      if (roomType && room.type !== roomType) continue
      out.push({
        id: room.id,
        type: room.type,
        players: room.clients.size,
        maxPlayers: room.maxClients,
        metadata: room.metadata,
      })
    }
    return out
  }

  private sweep(): void {
    const now = Date.now()
    for (const session of [...this.sessions.values()]) {
      if (session.transport && now - session.lastSeen > this.heartbeatTimeoutMs) {
        // im lặng quá lâu → coi như rớt, vào grace chờ resume
        session.transport.close('heartbeat timeout')
        session.transport = null
        session.graceDeadline = now + this.graceMs
      }
      if (!session.transport && session.graceDeadline !== null && now > session.graceDeadline) {
        this.destroySession(session)
      }
    }
  }

  private destroySession(session: Session): void {
    if (session.room) {
      const room = session.room
      room.clients.delete(session.id)
      session.room = null
      room.onLeave?.(session.client, 'session_lost')
      if (room.clients.size === 0) this.disposeRoom(room, 'room_closed')
    }
    this.sessions.delete(session.id)
    this.byResumeKey.delete(session.resumeKey)
  }

  private sendError(transport: Transport, code: ErrorCode, message: string): void {
    if (transport.isOpen) transport.send(encodePacket([{ type: 'error', code, message }]))
  }
}
