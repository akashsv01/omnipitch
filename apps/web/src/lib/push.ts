/**
 * Web PubSub fast path (contracts/schemas/push.schema.json). The snapshot API stays authoritative: a push
 * never changes what the page shows by itself; it only asks for a snapshot sooner. Every (re)connect asks
 * for a snapshot too, so a missed message costs latency, never correctness.
 *
 * Ordering: `state` messages are applied in state_version order (older or equal versions are ignored).
 * `moment`, `insight` and `period_reconciled` messages are published after the state has moved on, so
 * they are deduplicated by message_id only. Dependencies are injected so the logic runs under a fake socket.
 */

export type PushType = 'state' | 'moment' | 'insight' | 'period_reconciled';
export type PushEnvelope = {
  schema_version: '1.0'; message_id: string; run_id: string; type: PushType;
  state_version: number; sent_at: string; payload: Record<string, unknown>;
};
export type Negotiated = { url: string; group: string; expires_at?: string };
/** refresh = incremental snapshot now; full = refetch everything (insights or reconciliation changed). */
export type PushSignal = { kind: 'refresh' | 'full'; reason: string; envelope: PushEnvelope | null };
export type PushState = 'off' | 'connecting' | 'live' | 'retrying' | 'unavailable';
export type PushStatus = {
  state: PushState; runId: string | null; received: number; ignored: number;
  lastType: PushType | null; lastAt: string | null; error: string | null;
};

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface PushDeps {
  /** null means the API has no push configured: stay on polling, do not retry. */
  negotiate(runId: string): Promise<Negotiated | null>;
  openSocket(url: string, protocol: string): SocketLike;
  validate(envelope: unknown): envelope is PushEnvelope;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const PUSH_PROTOCOL = 'json.webpubsub.azure.v1';
const MAX_SEEN = 500;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

export const OFF_STATUS: PushStatus = { state: 'off', runId: null, received: 0, ignored: 0, lastType: null, lastAt: null, error: null };

export class PushClient {
  private runId: string | null = null;
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private session = 0;
  private version = -1;
  private seen = new Set<string>();
  private status: PushStatus = { ...OFF_STATUS };

  constructor(private deps: PushDeps, private onSignal: (signal: PushSignal) => void,
              private onStatus: (status: PushStatus) => void) {}

  /** Follow one source run; null stops push. Calling again with the same run is a no-op. */
  start(runId: string | null): void {
    if (runId === this.runId && this.status.state !== 'off') return;
    this.stop();
    if (!runId) return;
    this.runId = runId;
    this.version = -1;
    this.seen.clear();
    this.update({ ...OFF_STATUS, state: 'connecting', runId });
    void this.connect(this.session);
  }

  stop(): void {
    this.session += 1;  // Invalidates callbacks from older sockets and negotiations.
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) { socket.onclose = null; socket.close(); }
    this.runId = null;
    this.attempt = 0;
    if (this.status.state !== 'off') this.update({ ...OFF_STATUS });
  }

  private update(next: PushStatus) {
    this.status = next;
    this.onStatus(next);
  }

  private async connect(session: number) {
    const runId = this.runId!;
    let negotiated: Negotiated | null;
    try {
      negotiated = await this.deps.negotiate(runId);
    } catch (error) {
      if (session === this.session) this.retry(session, `negotiate failed: ${message(error)}`);
      return;
    }
    if (session !== this.session) return;
    if (!negotiated) {
      this.update({ ...this.status, state: 'unavailable', error: 'push is not configured on the API; polling only' });
      return;
    }
    const socket = this.deps.openSocket(negotiated.url, PUSH_PROTOCOL);
    this.socket = socket;
    socket.onopen = () => {
      if (session !== this.session) return;
      this.attempt = 0;
      this.update({ ...this.status, state: 'live', error: null });
      this.onSignal({ kind: 'full', reason: 'connected', envelope: null });  // Snapshot recovery on every (re)connect.
    };
    socket.onmessage = event => { if (session === this.session) this.receive(event.data); };
    socket.onerror = () => { /* onclose follows and decides. */ };
    socket.onclose = event => {
      if (session !== this.session) return;
      this.socket = null;
      this.retry(session, `connection closed${event?.code ? ` (${event.code})` : ''}`);
    };
  }

  private retry(session: number, error: string) {
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.update({ ...this.status, state: 'retrying', error });
    // A new token every time: the old client URL may have expired.
    this.timer = this.deps.setTimer(() => { this.timer = null; if (session === this.session) void this.connect(session); }, delay);
  }

  private ignore(error: string | null = null) {
    this.update({ ...this.status, ignored: this.status.ignored + 1, error: error ?? this.status.error });
  }

  private receive(raw: unknown) {
    let frame: unknown;
    try { frame = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return this.ignore('frame was not JSON'); }
    if (!isRecord(frame) || frame.type !== 'message') return;  // System frames (connected, ack) carry no data.
    let envelope: unknown = frame.data;
    if (typeof envelope === 'string') {
      try { envelope = JSON.parse(envelope); } catch { return this.ignore('message data was not JSON'); }
    }
    if (!this.deps.validate(envelope)) return this.ignore('message does not match push.schema.json');
    if (envelope.run_id !== this.runId) return this.ignore();
    if (this.seen.has(envelope.message_id)) return this.ignore();  // Retried publication: same message_id.
    if (envelope.type === 'state' && envelope.state_version <= this.version) return this.ignore();  // Out of order.
    this.seen.add(envelope.message_id);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value as string);
    if (envelope.type === 'state') this.version = envelope.state_version;
    this.update({ ...this.status, received: this.status.received + 1, lastType: envelope.type, lastAt: envelope.sent_at });
    const full = envelope.type === 'insight' || envelope.type === 'period_reconciled';
    this.onSignal({ kind: full ? 'full' : 'refresh', reason: envelope.type, envelope });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
