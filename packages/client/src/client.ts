import {
  decodePacket,
  encodePacket,
  PROTOCOL_VERSION,
  ProtocolError,
  type ErrorCode,
  type Message,
  type RoomLeftReason,
  type RoomListing,
  type Transport,
} from '@gm-net/core'

export type TransportFactory = () => Promise<Transport> | Transport

export type ClientStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

/** Lỗi từ server (message ERROR), giữ nguyên mã lỗi protocol. */
export class NetError extends Error {
  override name = 'NetError'
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface NetClientOptions {
  /** Hash schema state (Phase 2). 0 khi chưa dùng schema. */
  schemaHash?: number
  /** Timeout cho mỗi request control (join, list...). */
  requestTimeoutMs?: number
  /** Tự reconnect + resume khi rớt mạng. */
  reconnect?: boolean
  /** Chuỗi delay giữa các lần reconnect (ms). Hết chuỗi = bỏ cuộc. */
  reconnectDelaysMs?: number[]
  pingIntervalMs?: number
}

type PendingKind = 'connect' | 'join' | 'leave' | 'list'

interface Pending {
  resolve: (value: never) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ClockSample {
  rtt: number
  offset: number
}

/** Room nhìn từ phía client. */
export class ClientRoom {
  private eventHandlers = new Map<number | '*', Set<(channel: number, data: Uint8Array) => void>>()
  private leaveHandlers = new Set<(reason: RoomLeftReason) => void>()

  constructor(
    readonly id: string,
    readonly type: string,
    readonly metadata: Record<string, unknown>,
    private client: NetClient,
  ) {}

  send(channel: number, data: Uint8Array): void {
    this.client._sendEvent(channel, data)
  }

  /** Nghe event theo channel, hoặc '*' cho mọi channel. Trả về hàm hủy. */
  onEvent(channel: number | '*', handler: (channel: number, data: Uint8Array) => void): () => void {
    let set = this.eventHandlers.get(channel)
    if (!set) {
      set = new Set()
      this.eventHandlers.set(channel, set)
    }
    set.add(handler)
    return () => set.delete(handler)
  }

  onLeave(handler: (reason: RoomLeftReason) => void): () => void {
    this.leaveHandlers.add(handler)
    return () => this.leaveHandlers.delete(handler)
  }

  leave(): Promise<void> {
    return this.client.leaveRoom()
  }

  /** @internal */
  _dispatchEvent(channel: number, data: Uint8Array): void {
    for (const handler of this.eventHandlers.get(channel) ?? []) handler(channel, data)
    for (const handler of this.eventHandlers.get('*') ?? []) handler(channel, data)
  }

  /** @internal */
  _emitLeave(reason: RoomLeftReason): void {
    for (const handler of this.leaveHandlers) handler(reason)
  }
}

export class NetClient {
  private transport: Transport | null = null
  private pending = new Map<PendingKind, Pending>()
  private statusHandlers = new Set<(status: ClientStatus) => void>()
  private errorHandlers = new Set<(err: NetError) => void>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private clockSamples: ClockSample[] = []
  private reconnecting = false
  private intentionalClose = false

  private readonly schemaHash: number
  private readonly requestTimeoutMs: number
  private readonly reconnectEnabled: boolean
  private readonly reconnectDelaysMs: number[]
  private readonly pingIntervalMs: number

  status: ClientStatus = 'idle'
  clientId: string | null = null
  resumeKey: string | null = null
  /** RTT gần nhất (ms), NaN khi chưa có mẫu. */
  rtt = Number.NaN
  room: ClientRoom | null = null

  constructor(
    private transportFactory: TransportFactory,
    options: NetClientOptions = {},
  ) {
    this.schemaHash = options.schemaHash ?? 0
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.reconnectEnabled = options.reconnect ?? true
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? [500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000]
    this.pingIntervalMs = options.pingIntervalMs ?? 500
  }

  async connect(): Promise<void> {
    if (this.status !== 'idle') throw new Error(`connect() called in status '${this.status}'`)
    this.setStatus('connecting')
    try {
      await this.establish()
      this.setStatus('connected')
    } catch (err) {
      this.setStatus('closed')
      throw err
    }
  }

  async createRoom(roomType: string, options?: unknown, opts?: { private?: boolean }): Promise<ClientRoom> {
    return this.request<ClientRoom>('join', {
      type: 'roomCreate',
      roomType,
      options,
      private: opts?.private,
    })
  }

  joinRoom(roomId: string): Promise<ClientRoom> {
    return this.request<ClientRoom>('join', { type: 'roomJoin', roomId })
  }

  quickJoin(roomType: string): Promise<ClientRoom> {
    return this.request<ClientRoom>('join', { type: 'roomJoin', roomType })
  }

  async listRooms(roomType?: string): Promise<RoomListing[]> {
    return this.request<RoomListing[]>('list', { type: 'roomListReq', roomType })
  }

  async leaveRoom(): Promise<void> {
    if (!this.room) return
    await this.request<void>('leave', { type: 'roomLeave' })
  }

  /** Thời gian phía server ước lượng từ clock sync (ms epoch). */
  serverNow(): number {
    return Date.now() + this.clockOffset()
  }

  onStatus(handler: (status: ClientStatus) => void): () => void {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  /** Lỗi server không gắn với request nào đang chờ. */
  onError(handler: (err: NetError) => void): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  close(): void {
    this.intentionalClose = true
    this.stopPing()
    this.rejectAllPending(new Error('client closed'))
    this.transport?.close('client closed')
    this.transport = null
    this.setStatus('closed')
  }

  /** @internal */
  _sendEvent(channel: number, data: Uint8Array): void {
    if (!this.transport?.isOpen) {
      throw new Error(`Cannot send event in status '${this.status}' — wait for reconnect`)
    }
    this.transport.send(encodePacket([{ type: 'event', channel, data }]))
  }

  // ---- internal ----

  private setStatus(status: ClientStatus): void {
    if (this.status === status) return
    this.status = status
    for (const handler of this.statusHandlers) handler(status)
  }

  private async establish(): Promise<void> {
    const transport = await this.transportFactory()
    this.transport = transport

    transport.onMessage((bytes) => {
      if (this.transport !== transport) return
      let messages: Message[]
      try {
        messages = decodePacket(bytes)
      } catch (err) {
        if (err instanceof ProtocolError) {
          transport.close('protocol error')
          return
        }
        throw err
      }
      for (const m of messages) this.handleMessage(m)
    })

    transport.onClose(() => {
      if (this.transport !== transport) return
      this.transport = null
      this.stopPing()
      this.rejectAllPending(new Error('connection lost'))
      if (this.intentionalClose || this.status === 'closed') return
      if (this.reconnectEnabled && this.status === 'connected') {
        void this.reconnectLoop()
      } else if (this.status === 'connected') {
        this.setStatus('closed')
      }
    })

    const welcome = await this.request<Extract<Message, { type: 'welcome' }>>(
      'connect',
      { type: 'hello', protocol: PROTOCOL_VERSION, schemaHash: this.schemaHash, resumeKey: this.resumeKey ?? undefined },
      transport,
    )

    this.clientId = welcome.clientId
    this.resumeKey = welcome.resumeKey
    this.clockSamples = [{ rtt: 0, offset: welcome.serverTime - Date.now() }]
    this.startPing()

    // Session cũ không resume được → room phía client không còn tồn tại trên server
    if (!welcome.resumed && this.room) {
      const room = this.room
      this.room = null
      room._emitLeave('session_lost')
    }
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true
    this.setStatus('reconnecting')
    try {
      for (const delayMs of this.reconnectDelaysMs) {
        await sleep(delayMs)
        if (this.intentionalClose) return
        try {
          await this.establish()
          this.setStatus('connected')
          return
        } catch {
          // thử tiếp với delay kế
        }
      }
      // hết kiên nhẫn
      const room = this.room
      this.room = null
      this.setStatus('closed')
      room?._emitLeave('session_lost')
    } finally {
      this.reconnecting = false
    }
  }

  private request<T>(kind: PendingKind, message: Message, transport?: Transport): Promise<T> {
    const t = transport ?? this.transport
    if (!t?.isOpen) return Promise.reject(new Error(`Not connected (status '${this.status}')`))
    if (this.pending.has(kind)) {
      return Promise.reject(new Error(`Another '${kind}' request is already in flight`))
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(kind)
        reject(new Error(`Request '${kind}' timed out after ${this.requestTimeoutMs}ms`))
      }, this.requestTimeoutMs)
      this.pending.set(kind, { resolve: resolve as (value: never) => void, reject, timer })
      t.send(encodePacket([message]))
    })
  }

  private resolvePending(kind: PendingKind, value: unknown): boolean {
    const pending = this.pending.get(kind)
    if (!pending) return false
    this.pending.delete(kind)
    clearTimeout(pending.timer)
    pending.resolve(value as never)
    return true
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }

  private handleMessage(m: Message): void {
    switch (m.type) {
      case 'welcome':
        this.resolvePending('connect', m)
        break
      case 'pong': {
        const now = Date.now()
        const rtt = now - m.clientTime
        this.rtt = rtt
        this.clockSamples.push({ rtt, offset: m.serverTime + rtt / 2 - now })
        if (this.clockSamples.length > 10) this.clockSamples.shift()
        break
      }
      case 'roomJoined': {
        this.room = new ClientRoom(m.roomId, m.roomType, m.metadata, this)
        this.resolvePending('join', this.room)
        break
      }
      case 'roomLeft': {
        const room = this.room
        this.room = null
        this.resolvePending('leave', undefined)
        room?._emitLeave(m.reason)
        break
      }
      case 'roomListRes':
        this.resolvePending('list', m.rooms)
        break
      case 'event':
        this.room?._dispatchEvent(m.channel, m.data)
        break
      case 'error': {
        const err = new NetError(m.code, m.message)
        let handled = false
        for (const [kind, pending] of [...this.pending]) {
          this.pending.delete(kind)
          clearTimeout(pending.timer)
          pending.reject(err)
          handled = true
        }
        if (!handled) {
          for (const handler of this.errorHandlers) handler(err)
        }
        break
      }
      default:
        // Message chỉ client gửi (hello, ping, roomCreate...) mà server lại gửi xuống — bỏ qua
        break
    }
  }

  private clockOffset(): number {
    if (this.clockSamples.length === 0) return 0
    // Mẫu có RTT nhỏ nhất là mẫu ít nhiễu hàng đợi nhất (design 002, clock sync)
    let best = this.clockSamples[0]!
    for (const sample of this.clockSamples) {
      if (sample.rtt < best.rtt) best = sample
    }
    return best.offset
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.transport?.isOpen) {
        this.transport.send(encodePacket([{ type: 'ping', clientTime: Date.now() }]))
      }
    }, this.pingIntervalMs)
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
