/**
 * Transport interface — hợp đồng duy nhất giữa gm-net và tầng mạng bên dưới.
 * Yêu cầu v1: reliable + ordered (WebSocket). Xem design 002, mục transport tương lai.
 */

export interface Transport {
  readonly isOpen: boolean
  /** Gửi một packet. Gọi khi đã đóng sẽ bị bỏ qua âm thầm. */
  send(data: Uint8Array): void
  /** Đăng ký nhận packet. Nhiều handler được phép. Trả về hàm hủy đăng ký. */
  onMessage(handler: (data: Uint8Array) => void): () => void
  /** Đăng ký sự kiện đóng kết nối. Trả về hàm hủy đăng ký. */
  onClose(handler: (reason?: string) => void): () => void
  close(reason?: string): void
}

class MemoryEndpoint implements Transport {
  peer!: MemoryEndpoint
  private open = true
  private messageHandlers = new Set<(data: Uint8Array) => void>()
  private closeHandlers = new Set<(reason?: string) => void>()

  get isOpen(): boolean {
    return this.open
  }

  send(data: Uint8Array): void {
    if (!this.open) return
    const peer = this.peer
    // Giao async (microtask) để mô phỏng ranh giới I/O thật — code dựa vào
    // delivery đồng bộ sẽ hỏng trên transport thật, nên ở đây cũng phải hỏng.
    queueMicrotask(() => peer.deliver(data))
  }

  private deliver(data: Uint8Array): void {
    if (!this.open) return
    for (const handler of this.messageHandlers) handler(data)
  }

  onMessage(handler: (data: Uint8Array) => void): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onClose(handler: (reason?: string) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close(reason?: string): void {
    if (!this.open) return
    this.open = false
    for (const handler of this.closeHandlers) handler(reason)
    queueMicrotask(() => {
      if (this.peer.open) this.peer.close(reason)
    })
  }
}

/**
 * Cặp transport in-memory nối với nhau — nền tảng cho test và cho netsim.
 * `[a, b]`: gửi vào a thì b nhận, và ngược lại.
 */
export function createMemoryPair(): [Transport, Transport] {
  const a = new MemoryEndpoint()
  const b = new MemoryEndpoint()
  a.peer = b
  b.peer = a
  return [a, b]
}
