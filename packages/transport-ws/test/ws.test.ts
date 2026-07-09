import { afterEach, describe, expect, it } from 'vitest'
import type { Transport } from '@gm-net/core'
import { connectWebSocket } from '../src/index.js'
import { listenWebSocket, type WebSocketListener } from '../src/server.js'

let listener: WebSocketListener | undefined

afterEach(async () => {
  await listener?.close()
  listener = undefined
})

const nextMessage = (t: Transport) =>
  new Promise<Uint8Array>((resolve) => {
    const unsub = t.onMessage((d) => {
      unsub()
      resolve(d)
    })
  })

const closed = (t: Transport) =>
  new Promise<string | undefined>((resolve) => t.onClose(resolve))

describe('transport-ws', () => {
  it('client ↔ server roundtrip binary qua WebSocket thật', async () => {
    listener = await listenWebSocket({ port: 0 })
    listener.onConnection((t) => {
      t.onMessage((d) => {
        const echoed = new Uint8Array(d.length + 1)
        echoed.set(d)
        echoed[d.length] = 0xff
        t.send(echoed)
      })
    })

    const client = await connectWebSocket(`ws://127.0.0.1:${listener.port}`)
    expect(client.isOpen).toBe(true)

    const reply = nextMessage(client)
    client.send(new Uint8Array([1, 2, 3]))
    expect(new Uint8Array(await reply)).toEqual(new Uint8Array([1, 2, 3, 0xff]))
    client.close()
  })

  it('close từ client truyền reason sang server', async () => {
    listener = await listenWebSocket({ port: 0 })
    const serverSide = new Promise<Transport>((resolve) => listener!.onConnection(resolve))
    const client = await connectWebSocket(`ws://127.0.0.1:${listener.port}`)
    const server = await serverSide

    const reason = closed(server)
    client.close('goodbye')
    expect(await reason).toBe('goodbye')
    expect(client.isOpen).toBe(false)
  })

  it('connect tới cổng chết reject thay vì treo', async () => {
    await expect(connectWebSocket('ws://127.0.0.1:9', 2000)).rejects.toThrow(/closed before open|timeout/)
  })
})
