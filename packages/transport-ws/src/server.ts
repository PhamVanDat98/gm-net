/**
 * Transport listener phía server — Node, dùng thư viện `ws`.
 */

import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import type { Transport } from '@gm-net/core'

export interface ListenOptions {
  /** Cổng lắng nghe. 0 = hệ điều hành tự cấp (lấy cổng thật từ `listener.port`). */
  port: number
  host?: string
}

export interface WebSocketListener {
  readonly port: number
  onConnection(handler: (transport: Transport) => void): void
  close(): Promise<void>
}

function wrapServerSocket(ws: WsSocket): Transport {
  const messageHandlers = new Set<(data: Uint8Array) => void>()
  const closeHandlers = new Set<(reason?: string) => void>()

  ws.on('message', (raw, isBinary) => {
    if (!isBinary) return
    const data: Uint8Array = Array.isArray(raw)
      ? concat(raw)
      : raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    for (const handler of messageHandlers) handler(data)
  })
  ws.on('close', (_code, reasonBuf) => {
    const reason = reasonBuf.length > 0 ? reasonBuf.toString('utf8') : undefined
    for (const handler of closeHandlers) handler(reason)
  })

  return {
    get isOpen() {
      return ws.readyState === ws.OPEN
    },
    send(data: Uint8Array): void {
      if (ws.readyState === ws.OPEN) ws.send(data)
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
      ws.close(1000, reason?.slice(0, 123))
    },
  }
}

function concat(parts: Buffer[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), offset)
    offset += p.byteLength
  }
  return out
}

export function listenWebSocket(options: ListenOptions): Promise<WebSocketListener> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: options.port, host: options.host })
    const connectionHandlers = new Set<(transport: Transport) => void>()

    wss.on('connection', (socket) => {
      const transport = wrapServerSocket(socket)
      for (const handler of connectionHandlers) handler(transport)
    })

    wss.once('error', reject)
    wss.once('listening', () => {
      const address = wss.address()
      const port = typeof address === 'object' && address !== null ? address.port : options.port
      resolve({
        port,
        onConnection(handler) {
          connectionHandlers.add(handler)
        },
        close() {
          return new Promise<void>((res) => {
            for (const socket of wss.clients) socket.terminate()
            wss.close(() => res())
          })
        },
      })
    })
  })
}

export type { Transport }
