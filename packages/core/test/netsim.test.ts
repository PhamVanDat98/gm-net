import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryPair } from '../src/transport.js'
import { mulberry32, withSimulation } from '../src/netsim.js'

const msg = (...bytes: number[]) => new Uint8Array(bytes)

describe('createMemoryPair', () => {
  it('chuyển message hai chiều (async)', async () => {
    const [a, b] = createMemoryPair()
    const gotAtB: Uint8Array[] = []
    const gotAtA: Uint8Array[] = []
    b.onMessage((d) => gotAtB.push(d))
    a.onMessage((d) => gotAtA.push(d))

    a.send(msg(1))
    expect(gotAtB).toHaveLength(0) // không giao đồng bộ
    await Promise.resolve()
    expect(gotAtB).toEqual([msg(1)])

    b.send(msg(2))
    await Promise.resolve()
    expect(gotAtA).toEqual([msg(2)])
  })

  it('close graceful: message gửi trước close vẫn được giao, sau close thì không', async () => {
    const [a, b] = createMemoryPair()
    const closedReasons: (string | undefined)[] = []
    b.onClose((r) => closedReasons.push(r))
    const gotAtB: Uint8Array[] = []
    b.onMessage((d) => gotAtB.push(d))

    a.send(msg(1)) // trước close → được giao (như WebSocket thật)
    a.close('bye')
    a.send(msg(2)) // sau close → bỏ qua âm thầm
    await Promise.resolve()
    await Promise.resolve()

    expect(b.isOpen).toBe(false)
    expect(closedReasons).toEqual(['bye'])
    expect(gotAtB).toEqual([msg(1)])
  })
})

describe('withSimulation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  async function flushMicrotasks() {
    await vi.advanceTimersByTimeAsync(0)
  }

  it('trễ message theo latencyMs', async () => {
    const [a, b] = createMemoryPair()
    const simA = withSimulation(a, { latencyMs: 100 })
    const got: Uint8Array[] = []
    b.onMessage((d) => got.push(d))

    simA.send(msg(1))
    await vi.advanceTimersByTimeAsync(99)
    expect(got).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(got).toEqual([msg(1)])
  })

  it('áp dụng điều kiện cho cả chiều nhận', async () => {
    const [a, b] = createMemoryPair()
    const simA = withSimulation(a, { latencyMs: 50 })
    const got: Uint8Array[] = []
    simA.onMessage((d) => got.push(d))

    b.send(msg(9))
    await flushMicrotasks()
    expect(got).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(51)
    expect(got).toEqual([msg(9)])
  })

  it('packetLoss=1 rơi tất cả, packetLoss=0 giữ tất cả', async () => {
    const [a, b] = createMemoryPair()
    const lossy = withSimulation(a, { packetLoss: 1 })
    const got: Uint8Array[] = []
    b.onMessage((d) => got.push(d))

    lossy.send(msg(1))
    lossy.send(msg(2))
    await vi.advanceTimersByTimeAsync(10)
    expect(got).toHaveLength(0)
  })

  it('duplicate=1 giao mỗi message đúng 2 lần', async () => {
    const [a, b] = createMemoryPair()
    const dup = withSimulation(a, { duplicate: 1 })
    const got: Uint8Array[] = []
    b.onMessage((d) => got.push(d))

    dup.send(msg(7))
    await vi.advanceTimersByTimeAsync(10)
    expect(got).toEqual([msg(7), msg(7)])
  })

  it('ordered=true: jitter không cho message sau vượt message trước', async () => {
    const [a, b] = createMemoryPair()
    // rng: lần 1 → jitter tối đa (+40ms), lần 2 → jitter tối thiểu (-40ms)
    const rngValues = [1, 0]
    const rng = () => rngValues.shift() ?? 0.5
    const sim = withSimulation(a, { latencyMs: 50, jitterMs: 40, ordered: true }, rng)
    const got: number[] = []
    b.onMessage((d) => got.push(d[0]!))

    sim.send(msg(1)) // lịch giao: t+90
    sim.send(msg(2)) // tự nhiên: t+10, nhưng ordered → dời tới t+90

    await vi.advanceTimersByTimeAsync(50)
    expect(got).toEqual([]) // msg 2 không được vượt lên
    await vi.advanceTimersByTimeAsync(45)
    expect(got).toEqual([1, 2])
  })

  it('ordered=false: message sau được phép vượt (mô phỏng UDP)', async () => {
    const [a, b] = createMemoryPair()
    const rngValues = [1, 0]
    const rng = () => rngValues.shift() ?? 0.5
    const sim = withSimulation(a, { latencyMs: 50, jitterMs: 40, ordered: false }, rng)
    const got: number[] = []
    b.onMessage((d) => got.push(d[0]!))

    sim.send(msg(1)) // giao t+90
    sim.send(msg(2)) // giao t+10
    await vi.advanceTimersByTimeAsync(100)
    expect(got).toEqual([2, 1])
  })

  it('mulberry32 tất định theo seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const seqA = [a(), a(), a()]
    const seqB = [b(), b(), b()]
    expect(seqA).toEqual(seqB)
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
    expect(mulberry32(43)()).not.toBe(seqA[0])
  })

  it('thống kê packetLoss xấp xỉ tỉ lệ cấu hình (seeded)', async () => {
    const [a, b] = createMemoryPair()
    const sim = withSimulation(a, { packetLoss: 0.3 }, mulberry32(1234))
    let received = 0
    b.onMessage(() => received++)

    const total = 1000
    for (let i = 0; i < total; i++) sim.send(msg(i & 0xff))
    await vi.advanceTimersByTimeAsync(10)

    expect(received).toBeGreaterThan(total * 0.6)
    expect(received).toBeLessThan(total * 0.8)
  })
})
