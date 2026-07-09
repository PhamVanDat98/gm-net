import type { RoomLeftReason } from '@gm-net/core'

/** Một client trong room, nhìn từ phía game logic. */
export interface RoomClient {
  readonly id: string
  /** false khi client đang rớt mạng (trong grace period chờ resume). */
  readonly isConnected: boolean
  /** Slot tự do cho user gắn state per-client (tên, đội, v.v.). */
  data: unknown
  sendEvent(channel: number, data: Uint8Array): void
  /** Đá client khỏi room (client nhận ROOM_LEFT reason 'kicked', vẫn giữ kết nối). */
  kick(): void
}

/** @internal Cầu nối do NetServer inject — user không chạm vào. */
export interface RoomInternal {
  broadcast(channel: number, data: Uint8Array, exceptClientId?: string): void
  closeRoom(): void
  kick(clientId: string): void
}

/**
 * Lớp cơ sở cho game logic một phòng. Kế thừa và override các hook cần thiết:
 *
 * ```ts
 * class ChatRoom extends Room<{ name: string }> {
 *   override onCreate(options) { this.metadata.name = options.name }
 *   override onMessage(client, channel, data) { this.broadcast(channel, data) }
 * }
 * server.define('chat', ChatRoom)
 * ```
 */
export abstract class Room<Options = unknown> {
  readonly id!: string
  readonly type!: string
  /** Hiện trong room listing và ROOM_JOINED. Chỉnh trong onCreate/handlers. */
  metadata: Record<string, unknown> = {}
  maxClients = 16
  /** Room private không hiện trong listing và không nhận quick-join. */
  isPrivate = false

  readonly clients = new Map<string, RoomClient>()

  /** @internal */
  _internal!: RoomInternal

  /** Gửi event tới mọi client trong room (bỏ qua client đang rớt mạng). */
  broadcast(channel: number, data: Uint8Array, except?: RoomClient): void {
    this._internal.broadcast(channel, data, except?.id)
  }

  /** Đóng room: mọi client nhận ROOM_LEFT 'room_closed', sau đó onDispose chạy. */
  closeRoom(): void {
    this._internal.closeRoom()
  }

  // ---- lifecycle hooks (override cái cần) ----
  onCreate?(options: Options): void
  onJoin?(client: RoomClient): void
  onMessage?(client: RoomClient, channel: number, data: Uint8Array): void
  onLeave?(client: RoomClient, reason: RoomLeftReason): void
  onDispose?(): void
}

export type RoomConstructor = new () => Room
