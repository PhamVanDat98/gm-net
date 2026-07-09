/**
 * Network simulator — giả lập latency/jitter/loss/duplicate trên bất kỳ Transport nào.
 * Công cụ bắt buộc để test netcode (design 003, Phase 0).
 *
 * Lưu ý ngữ nghĩa: với transport TCP-like (WebSocket), packet loss thực tế biểu hiện
 * thành latency spike chứ không mất hẳn — dùng `latencyMs`/`jitterMs` để mô phỏng WS.
 * `packetLoss`/`ordered:false` dành cho kênh unreliable (WebRTC, phase sau) và cho
 * việc kiểm tra protocol tự phục hồi.
 */

import type { Transport } from './transport.js'

export interface NetConditions {
  /** Độ trễ một chiều cơ bản (ms). Mặc định 0. */
  latencyMs?: number
  /** Nhiễu độ trễ, phân bố đều trong ±jitterMs. Mặc định 0. */
  jitterMs?: number
  /** Xác suất rơi packet, 0..1. Mặc định 0. */
  packetLoss?: number
  /** Xác suất nhân đôi packet, 0..1. Mặc định 0. */
  duplicate?: number
  /** Giữ thứ tự như TCP (packet sau không vượt packet trước). Mặc định true. */
  ordered?: boolean
}

/** PRNG tất định (mulberry32) — dùng seed cố định để test netcode lặp lại được. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Một chiều truyền có điều kiện mạng: nhận hàm deliver, trả về hàm push. */
function createLane(
  conditions: NetConditions,
  rng: () => number,
  deliver: (data: Uint8Array) => void,
): (data: Uint8Array) => void {
  const { latencyMs = 0, jitterMs = 0, packetLoss = 0, duplicate = 0, ordered = true } = conditions
  let lastDeliveryAt = 0

  const scheduleOne = (data: Uint8Array) => {
    const jitter = jitterMs > 0 ? (rng() * 2 - 1) * jitterMs : 0
    let deliverAt = Date.now() + Math.max(0, latencyMs + jitter)
    if (ordered) {
      deliverAt = Math.max(deliverAt, lastDeliveryAt)
      lastDeliveryAt = deliverAt
    }
    setTimeout(() => deliver(data), Math.max(0, deliverAt - Date.now()))
  }

  return (data: Uint8Array) => {
    if (packetLoss > 0 && rng() < packetLoss) return
    scheduleOne(data)
    if (duplicate > 0 && rng() < duplicate) scheduleOne(data)
  }
}

/**
 * Bọc một Transport với điều kiện mạng giả lập, áp dụng cho CẢ HAI chiều gửi/nhận
 * (mỗi chiều chịu điều kiện độc lập — tổng RTT ≈ 2 × latencyMs).
 */
export function withSimulation(
  inner: Transport,
  conditions: NetConditions,
  rng: () => number = Math.random,
): Transport {
  const messageHandlers = new Set<(data: Uint8Array) => void>()

  const outbound = createLane(conditions, rng, (data) => {
    if (inner.isOpen) inner.send(data)
  })
  const inbound = createLane(conditions, rng, (data) => {
    if (!inner.isOpen) return
    for (const handler of messageHandlers) handler(data)
  })

  inner.onMessage(inbound)

  return {
    get isOpen() {
      return inner.isOpen
    },
    send(data: Uint8Array): void {
      if (inner.isOpen) outbound(data)
    },
    onMessage(handler: (data: Uint8Array) => void): () => void {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },
    onClose(handler: (reason?: string) => void): () => void {
      return inner.onClose(handler)
    },
    close(reason?: string): void {
      inner.close(reason)
    },
  }
}
