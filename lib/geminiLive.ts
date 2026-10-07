"use client";

/**
 * Gemini Live voice session, straight from the browser.
 *
 * Same idea as the Jarvis assistant: a bidirectional Live API session carrying
 * mic audio up (16 kHz PCM) and the model's voice down (24 kHz PCM). The page
 * talks to Google over a WebSocket with the visitor's own API key - nothing
 * goes through this app's server and no extra npm package is needed.
 *
 *   mic -> AudioWorklet -> 16 kHz Int16 -> { realtimeInput.audio } ->
 *   Gemini -> { serverContent.modelTurn.parts[].inlineData } -> speakers
 */

export const LIVE_MODEL = "models/gemini-3.1-flash-live-preview";
export const VOICE_NAME = "Charon"; // Live prebuilt voices: Charon, Puck, Kore, Fenrir, Aoede

const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const SEND_RATE = 16000;
const RECV_RATE = 24000;
const SETUP_TIMEOUT_MS = 15000;

const SYSTEM_PROMPT =
  "You are Apex, an autonomous AI chief of staff speaking with the user by voice. " +
  "Be concise, concrete and calm: give your assessment in the first sentence. " +
  "Reply in the language the user speaks to you.";

export type LivePhase = "connecting" | "listening" | "thinking" | "speaking";
export type LiveEvents = {
  onPhase: (p: LivePhase) => void;
  onError: (message: string) => void;
  onClosed: () => void;
};

// AudioWorklet source, loaded from a Blob so there is no extra file to serve.
const WORKLET_SRC = `
class ApexMic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("apex-mic", ApexMic);
`;

/** Box-filter downsample of mono float samples to 16 kHz Int16 PCM. */
function toPcm16k(input: Float32Array, inRate: number): Int16Array {
  const ratio = inRate / SEND_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const s = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class GeminiLiveSession {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private micNode: AudioWorkletNode | null = null;
  private srcNode: MediaStreamAudioSourceNode | null = null;
  private muteNode: GainNode | null = null;
  private workletUrl: string | null = null;
  private sinks = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private ready = false;
  private closed = false;
  private turnDone = true;
  private speaking = false;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private key: string, private ev: LiveEvents) {}

  /** Must be called from a user gesture (click / key press) so audio may start. */
  async start(): Promise<void> {
    this.ev.onPhase("connecting");

    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return this.fail("The microphone needs https:// or localhost.");
    }
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return this.fail("This browser has no Web Audio support.");

    // Created inside the click so the browser lets it run.
    this.ctx = new Ctx();
    void this.ctx.resume();

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      return this.fail(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access was blocked. Allow it in the address bar and tap again."
          : "No microphone could be opened."
      );
    }
    if (this.closed) { this.teardown(); return; }

    try {
      await this.setupMic();
    } catch {
      return this.fail("Could not start audio capture in this browser.");
    }
    if (this.closed) { this.teardown(); return; }

    this.connect();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardown();
  }

  // ── setup ────────────────────────────────────────────────────────────────

  private async setupMic() {
    const ctx = this.ctx!;
    this.workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(this.workletUrl);

    this.srcNode = ctx.createMediaStreamSource(this.stream!);
    this.micNode = new AudioWorkletNode(ctx, "apex-mic");
    // A muted sink keeps the graph pulling audio without echoing the mic back.
    this.muteNode = ctx.createGain();
    this.muteNode.gain.value = 0;
    this.srcNode.connect(this.micNode);
    this.micNode.connect(this.muteNode);
    this.muteNode.connect(ctx.destination);

    this.micNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!this.ready || this.closed || this.ws?.readyState !== WebSocket.OPEN) return;
      const pcm = toPcm16k(e.data, ctx.sampleRate);
      this.send({
        realtimeInput: {
          audio: { data: bytesToBase64(new Uint8Array(pcm.buffer)), mimeType: `audio/pcm;rate=${SEND_RATE}` },
        },
      });
    };
  }

  private connect() {
    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.key)}`);
    this.ws = ws;

    this.setupTimer = setTimeout(() => {
      if (!this.ready) this.fail("Timed out connecting to Gemini.");
    }, SETUP_TIMEOUT_MS);

    ws.onopen = () => {
      this.send({
        setup: {
          model: LIVE_MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
          },
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      });
    };

    ws.onmessage = async (e: MessageEvent) => {
      try {
        const raw = typeof e.data === "string" ? e.data : await (e.data as Blob).text();
        this.handle(JSON.parse(raw));
      } catch { /* ignore a malformed frame */ }
    };

    ws.onerror = () => { /* the close event that follows carries the reason */ };

    ws.onclose = (e: CloseEvent) => {
      if (this.closed) return;
      const reason = (e.reason || "").trim();
      if (e.code !== 1000 || !this.ready) {
        this.fail(reason ? `Gemini: ${reason}` : `Connection closed (code ${e.code}).`);
      } else {
        this.stop();
        this.ev.onClosed();
      }
    };
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  private handle(msg: any) {
    if (msg.setupComplete) {
      this.ready = true;
      if (this.setupTimer) { clearTimeout(this.setupTimer); this.setupTimer = null; }
      this.ev.onPhase("listening");
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) this.flushPlayback();

    if (sc.inputTranscription?.text && !this.speaking) this.ev.onPhase("thinking");

    const parts = sc.modelTurn?.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        const data: string | undefined = p?.inlineData?.data;
        if (data) this.enqueue(base64ToBytes(data));
      }
    }

    if (sc.turnComplete) {
      this.turnDone = true;
      this.maybeListening();
    }
  }

  // ── playback ─────────────────────────────────────────────────────────────

  private enqueue(bytes: Uint8Array) {
    const ctx = this.ctx;
    if (!ctx || this.closed || bytes.length < 2) return;

    const n = Math.floor(bytes.length / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    const buf = ctx.createBuffer(1, n, RECV_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 0x8000;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.02, this.nextAt);
    src.start(at);
    this.nextAt = at + buf.duration;

    this.sinks.add(src);
    src.onended = () => {
      this.sinks.delete(src);
      this.maybeListening();
    };

    this.turnDone = false;
    if (!this.speaking) {
      this.speaking = true;
      this.ev.onPhase("speaking");
    }
  }

  private flushPlayback() {
    this.sinks.forEach((s) => { s.onended = null; try { s.stop(); } catch { /* already stopped */ } });
    this.sinks.clear();
    this.nextAt = 0;
    this.turnDone = true;
    this.maybeListening();
  }

  private maybeListening() {
    if (this.closed || !this.ready) return;
    if (this.turnDone && this.sinks.size === 0 && this.speaking) {
      this.speaking = false;
      this.ev.onPhase("listening");
    }
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private fail(message: string) {
    if (this.closed) return;
    this.closed = true;
    this.teardown();
    this.ev.onError(message);
    this.ev.onClosed();
  }

  private teardown() {
    if (this.setupTimer) { clearTimeout(this.setupTimer); this.setupTimer = null; }
    this.sinks.forEach((s) => { s.onended = null; try { s.stop(); } catch { /* ignore */ } });
    this.sinks.clear();
    if (this.micNode) { this.micNode.port.onmessage = null; try { this.micNode.disconnect(); } catch { /* ignore */ } }
    try { this.srcNode?.disconnect(); } catch { /* ignore */ }
    try { this.muteNode?.disconnect(); } catch { /* ignore */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
      try { this.ws.close(1000); } catch { /* ignore */ }
    }
    if (this.ctx && this.ctx.state !== "closed") void this.ctx.close();
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
    this.ws = null; this.ctx = null; this.stream = null; this.micNode = null;
    this.srcNode = null; this.muteNode = null; this.workletUrl = null;
    this.ready = false; this.speaking = false;
  }
}
