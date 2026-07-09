// Demo milestone Phase 1: chat room qua WebSocket thật, viết bằng JS thuần
// (không build step) — đúng trải nghiệm người dùng thư viện.
//
// Chạy: pnpm build (ở root, một lần) rồi: pnpm --filter example-chat-node start

import { NetServer, Room } from '@gm-net/server'
import { NetClient } from '@gm-net/client'
import { connectWebSocket } from '@gm-net/transport-ws'
import { listenWebSocket } from '@gm-net/transport-ws/server'

const CHAT = 1
const enc = new TextEncoder()
const dec = new TextDecoder()
const say = (text) => enc.encode(JSON.stringify({ text }))

// ---- phía server: game logic của một phòng chat ----
class ChatRoom extends Room {
  onCreate(options) {
    this.metadata = { name: options?.name ?? 'phòng chat' }
  }
  onJoin(client) {
    client.data = { name: `khách-${this.clients.size}` }
    this.broadcast(CHAT, enc.encode(JSON.stringify({ from: '📢', text: `${client.data.name} đã vào phòng` })))
  }
  onMessage(client, channel, data) {
    if (channel !== CHAT) return
    const { text } = JSON.parse(dec.decode(data))
    this.broadcast(CHAT, enc.encode(JSON.stringify({ from: client.data.name, text })))
  }
  onLeave(client, reason) {
    this.broadcast(CHAT, enc.encode(JSON.stringify({ from: '📢', text: `${client.data.name} đã rời (${reason})` })))
  }
}

const server = new NetServer()
server.define('chat', ChatRoom)
const listener = await listenWebSocket({ port: 0 })
listener.onConnection((transport) => server.handleConnection(transport))
const url = `ws://127.0.0.1:${listener.port}`
console.log(`✅ server lắng nghe tại ${url}\n`)

// ---- phía client ----
async function join(who, roomId) {
  const client = new NetClient(() => connectWebSocket(url))
  await client.connect()
  const room = roomId ? await client.joinRoom(roomId) : await client.createRoom('chat', { name: 'sảnh chính' })
  room.onEvent(CHAT, (_channel, data) => {
    const { from, text } = JSON.parse(dec.decode(data))
    console.log(`  [màn hình của ${who}]  ${from}: ${text}`)
  })
  return { client, room }
}

const alice = await join('Alice')
console.log(`Alice tạo phòng '${alice.room.metadata.name}' — mã phòng: ${alice.room.id}`)

const lobby = new NetClient(() => connectWebSocket(url))
await lobby.connect()
console.log('Lobby thấy:', await lobby.listRooms('chat'))
lobby.close()

const bob = await join('Bob', alice.room.id)
await sleep(100)

bob.room.send(CHAT, say('Chào Alice! Mình vào bằng mã phòng.'))
await sleep(100)
alice.room.send(CHAT, say('Chào Bob 👋 ping của mình: ' + (Number.isNaN(alice.client.rtt) ? 'đang đo...' : alice.client.rtt + 'ms')))
await sleep(300)

console.log('\nBob rời phòng...')
await bob.room.leave()
await sleep(100)

bob.client.close()
alice.client.close()
server.close()
await listener.close()
console.log('\n✅ demo hoàn tất — server, client, room lifecycle đều hoạt động')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
