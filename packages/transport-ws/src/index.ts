/**
 * Transport adapter phía client — dùng WebSocket API chuẩn (browser, Node >= 21).
 * KHÔNG import gì từ Node để bundler browser không kéo nhầm dependency.
 * Phía server (Node + thư viện `ws`): import từ '@gm-net/transport-ws/server'.
 */

import type { Transport } from '@gm-net/core'

/** Bọc một WebSocket chuẩn (đã hoặc đang mở) thành Transport. */
export function wrapWebSocket(ws: WebSocket): Transport {
  ws.binaryType = 'arraybuffer'
  const messageHandlers = new Set<(data: Uint8Array) => void>()
  const closeHandlers = new Set<(reason?: string) => void>()

  ws.addEventListener('message', (ev: MessageEvent) => {
    if (!(ev.data instanceof ArrayBuffer)) return // text frame không thuộc protocol — bỏ qua
    const data = new Uint8Array(ev.data)
    for (const handler of messageHandlers) handler(data)
  })
  ws.addEventListener('close', (ev: CloseEvent) => {
    for (const handler of closeHandlers) handler(ev.reason || undefined)
  })

  return {
    get isOpen() {
      return ws.readyState === WebSocket.OPEN
    },
    send(data: Uint8Array): void {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    },
    onMessage(handler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },
    onClose(handler) {
      closeHandlers.add(handler)
      return () => closeHandlers.delete(handler)
    },
    close(reason?: string): void {
      // 1000 = normal closure; reason bị WS giới hạn 123 bytes
      ws.close(1000, reason?.slice(0, 123))
    },
  }
}

/** Kết nối tới một gm-net server qua WebSocket. */
export function connectWebSocket(url: string, timeoutMs = 10_000): Promise<Transport> {
  return new Promise((resolve, reject) => {
    let settled = false
    const ws = new WebSocket(url)
    const transport = wrapWebSocket(ws) // gắn listener ngay, không để lọt message

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      ws.close()
      reject(new Error(`WebSocket connect timeout after ${timeoutMs}ms: ${url}`))
    }, timeoutMs)

    ws.addEventListener('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(transport)
    })
    ws.addEventListener('close', (ev) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`WebSocket closed before open (code ${ev.code}): ${url}`))
    })
    ws.addEventListener('error', () => {
      // 'error' luôn kèm 'close' ngay sau — để 'close' reject với thông tin đầy đủ hơn
    })
  })
}

export type { Transport }
