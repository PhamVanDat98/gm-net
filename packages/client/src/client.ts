/**
 * `GameClient` — runtime client transport-agnostic ([docs/design/004-netcode.md]
 * §2–4, §7). Điều phối clock sync, input pipeline (redundancy + adaptive lead),
 * snapshot receiver quanh một {@link ClientTransport}. Không import DOM, không
 * nhắc tên Colyseus — nhận `now()` để test bằng đồng hồ ảo.
 *
 * M3 dừng ở khung: gửi input "echo box", đo RTT/lead, nhận snapshot mới nhất.
 * Prediction/reconciliation (M4) và interpolation (M5) cắm vào qua `onSnapshot`
 * + `unackedInputs()` mà không phải sửa lớp này.
 */
import {
  MessageType,
  NO_ACK_TICK,
  ProtocolError,
  type ProtocolCodec,
  type Snapshot,
} from '@gm-net/core';
import { SERVER_TICK_MS, type Handshake } from '@gm-net/shared';
import { ClockSync, type ClockSyncOptions } from './clock.js';
import { InputPipeline, InputLeadController, type InputPipelineOptions, type InputLeadOptions } from './input.js';
import { SnapshotReceiver, type SnapshotListener, type SnapshotReceiverStats } from './snapshot.js';
import type { ClientTransport } from './transport.js';

export interface GameClientOptions<Input> {
  /** Codec wire (khớp cấu hình server: quantization + inputCodec + entityCodecs). */
  codec: ProtocolCodec<Input>;
  /** Đồng hồ (ms). Mặc định `Date.now`. Test tiêm đồng hồ ảo. */
  now?: () => number;
  /** Độ dài tick (ms). Mặc định `SERVER_TICK_MS`. */
  tickMs?: number;
  clock?: ClockSyncOptions;
  input?: InputPipelineOptions;
  lead?: InputLeadOptions;
  /** Nhận handshake JSON lúc join. */
  onHandshake?: (h: Handshake) => void;
  /** Nhận mỗi snapshot mới (đã bỏ bản cũ). */
  onSnapshot?: SnapshotListener;
}

export interface ClientMetrics {
  /** RTT ước lượng (ms) — `NaN` khi chưa sync. */
  rtt: number;
  jitter: number;
  inputLead: number;
  serverTickNow: number;
  pendingInputs: number;
  lastSnapshotTick: number;
}

export class GameClient<Input = unknown> {
  private readonly codec: ProtocolCodec<Input>;
  private readonly now: () => number;
  private readonly tickMs: number;

  private readonly clock: ClockSync;
  private readonly pipeline: InputPipeline<Input>;
  private readonly leadCtl: InputLeadController;
  private readonly snapshots: SnapshotReceiver<Input>;

  private readonly onHandshakeCb?: (h: Handshake) => void;

  private _handshake: Handshake | undefined;
  private _connected = false;

  constructor(
    private readonly transport: ClientTransport,
    opts: GameClientOptions<Input>,
  ) {
    this.codec = opts.codec;
    this.now = opts.now ?? (() => Date.now());
    this.tickMs = opts.tickMs ?? SERVER_TICK_MS;
    this.clock = new ClockSync({ tickMs: this.tickMs, ...opts.clock });
    this.pipeline = new InputPipeline<Input>(opts.input);
    this.leadCtl = new InputLeadController(opts.lead);
    this.snapshots = new SnapshotReceiver<Input>(this.codec);
    this.onHandshakeCb = opts.onHandshake;
    if (opts.onSnapshot) this.snapshots.onSnapshot(opts.onSnapshot);

    this.transport.onJson('handshake', (payload) => this.handleHandshake(payload));
    this.transport.onBytes((type, bytes) => this.handleBytes(type, bytes));
    this.transport.onLeave(() => {
      this._connected = false;
    });
  }

  /** Bắt đầu vòng đời client: neo mốc warmup ping. Gọi sau khi transport sẵn sàng. */
  start(): void {
    this._connected = true;
    this.clock.connect(this.now());
  }

  get connected(): boolean {
    return this._connected;
  }

  get handshake(): Handshake | undefined {
    return this._handshake;
  }

  /** Entity local player điều khiển (từ handshake); -1 khi chưa có. */
  get entityId(): number {
    return this._handshake ? this._handshake.entityId : -1;
  }

  get inputLead(): number {
    return this.leadCtl.lead;
  }

  get rtt(): number {
    return this.clock.rtt;
  }

  get latestSnapshot(): Snapshot | undefined {
    return this.snapshots.latest;
  }

  /** Đăng ký thêm listener snapshot (M4/M5 tiêu thụ). */
  onSnapshot(cb: SnapshotListener): () => void {
    return this.snapshots.onSnapshot(cb);
  }

  /** Delta/keyframe đã nhận ([005] §4) — HUD/debug/test. */
  snapshotStats(): SnapshotReceiverStats {
    return this.snapshots.snapshotStats();
  }

  /** Input chưa ack (M4 replay reconciliation). */
  unackedInputs(): ReadonlyArray<{ seq: number; tick: number; payload: Input }> {
    return this.pipeline.unacked();
  }

  serverTickNow(now = this.now()): number {
    return this.clock.serverTickNow(now);
  }

  /** Tick server client nên nhắm input tới = `ceil(serverTickNow) + inputLead`. */
  targetTick(now = this.now()): number {
    const est = this.clock.serverTickNow(now);
    const base = Number.isFinite(est) ? Math.ceil(est) : Math.max(0, this.snapshots.latestTick);
    return base + this.leadCtl.lead;
  }

  metrics(now = this.now()): ClientMetrics {
    return {
      rtt: this.clock.rtt,
      jitter: this.clock.jitter,
      inputLead: this.leadCtl.lead,
      serverTickNow: this.clock.serverTickNow(now),
      pendingInputs: this.pipeline.pendingCount,
      lastSnapshotTick: this.snapshots.latestTick,
    };
  }

  /**
   * Nhịp định kỳ (host gọi mỗi frame/tick): gửi ping khi tới hạn. Tách khỏi
   * `sendInput` để host tự quyết cadence sim.
   */
  update(now = this.now()): void {
    if (this.clock.shouldPing(now)) {
      this.transport.sendBytes(MessageType.Ping, this.codec.encodePing({ clientTime: now }));
      this.clock.markPinged(now);
    }
  }

  /**
   * Lấy mẫu + gửi một input, nhắm `tick` (mặc định `targetTick(now)`; M4 truyền
   * `PredictionWorld.nextInputTick(...)` để giữ timeline dự đoán liên tục). Trả
   * `seq`/`tick` đã gán (map seq→tick vào ring local). Kèm redundancy N input
   * chưa ack.
   */
  sendInput(
    payload: Input,
    now = this.now(),
    tick = this.targetTick(now),
    /** Interp delay hiện tại (ms) — server rewind hit detection theo nó ([006] §4, M10). */
    interpDelayMs = 0,
  ): { seq: number; tick: number } {
    // Chưa nhận snapshot nào → sentinel, KHÔNG phải 0: tick 0 là tick thật, server
    // sẽ delta dựa trên baseline mà client join giữa chừng chưa từng nhận ([005] §6).
    const latest = this.snapshots.latestTick;
    const ackTick = latest < 0 ? NO_ACK_TICK : latest;
    const sampled = this.pipeline.sample(payload, tick, ackTick, interpDelayMs);
    this.transport.sendBytes(MessageType.Input, this.codec.encodeInput(sampled.packet));
    return { seq: sampled.seq, tick: sampled.tick };
  }

  leave(): void {
    this._connected = false;
    this.transport.leave();
  }

  /**
   * Resync sau reconnect ([006] §5, M8): vứt state phiên cũ — snapshot + ring
   * baseline (server đã reset baseline phía nó), input chưa ack (server không
   * nhận được, world đã chạy tiếp), và neo lại clock (kết nối mới, ping warmup
   * dày trở lại). Prediction/interpolation do lớp trên (`GameSession`) tự dựng lại
   * từ keyframe kế tiếp.
   */
  resync(now = this.now()): void {
    this.snapshots.reset();
    this.pipeline.reset();
    this.clock.connect(now);
    this._connected = true;
  }

  private handleHandshake(payload: unknown): void {
    const h = payload as Handshake;
    // Handshake lần hai trên cùng một GameClient = server đã nhận lại ta sau khi
    // rớt mạng ([006] §5) — không phải join mới.
    const isReconnect = this._handshake !== undefined;
    this._handshake = h;
    if (isReconnect) this.resync();
    this.onHandshakeCb?.(h);
  }

  /** State mới (từ SNAPSHOT hoặc DELTA): ack input đã xử lý + nuôi adaptive lead. */
  private onState(snap: Snapshot | undefined): void {
    if (!snap) return;
    this.pipeline.ack(snap.lastProcessedSeq);
    this.leadCtl.onSnapshot(snap.lateInputs); // đã là "late trong cửa sổ" (server consume-on-read)
  }

  private handleBytes(type: number, bytes: Uint8Array): void {
    try {
      if (type === MessageType.Snapshot) {
        this.onState(this.snapshots.receive(bytes));
      } else if (type === MessageType.Delta) {
        // Delta dựng lại từ baseline trong ring; không khớp → bỏ, ack đứng yên,
        // server sẽ gửi keyframe ([005] §4).
        this.onState(this.snapshots.receiveDelta(bytes));
      } else if (type === MessageType.Pong) {
        const pong = this.codec.decodePong(bytes);
        this.clock.onPong(pong, this.now());
        this.leadCtl.applyBase(this.clock.baseInputLead());
      }
      // Type lạ: bỏ qua (forward-compat).
    } catch (err) {
      if (err instanceof ProtocolError) return; // byte hỏng từ mạng: nuốt
      throw err;
    }
  }
}
