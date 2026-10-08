/**
 * Small synthesized sound set (no audio files). While muted no AudioContext is even
 * created, so a muted run is guaranteed silent; unmuting (the M key or the HUD speaker)
 * is itself a user gesture, which is what browsers require before audio may start.
 */

import type { SoundName } from '../sim/SimEvents';

export type { SoundName };

const MASTER_VOLUME = 0.45;

export class Audio {
  private _muted: boolean;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private humGain: GainNode | null = null;
  private humLevel = 0;
  private readonly listeners = new Set<(muted: boolean) => void>();

  constructor(muted: boolean) {
    this._muted = muted;
    const wake = () => {
      if (!this._muted) this.ensureContext();
    };
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
  }

  get muted(): boolean {
    return this._muted;
  }

  onChange(fn: (muted: boolean) => void): void {
    this.listeners.add(fn);
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (!muted) this.ensureContext();
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : MASTER_VOLUME, this.ctx.currentTime, 0.02);
    }
    for (const fn of this.listeners) fn(muted);
  }

  toggle(): void {
    this.setMuted(!this._muted);
  }

  private ensureContext(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : MASTER_VOLUME;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Continuous laser hum; its level follows the nearest beam (see setHum).
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 92;
    const humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.value = 420;
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    hum.connect(humFilter).connect(this.humGain).connect(this.master);
    hum.start();
  }

  /** 0..1 loudness of the laser hum, updated every frame by the session. */
  setHum(level: number): void {
    if (Math.abs(level - this.humLevel) < 0.01) return;
    this.humLevel = level;
    if (this.humGain && this.ctx) this.humGain.gain.setTargetAtTime(level * 0.12, this.ctx.currentTime, 0.08);
  }

  play(name: SoundName, volume = 1): void {
    if (this._muted || !this.ctx || !this.master || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = volume;
    out.connect(this.master);

    switch (name) {
      case 'shootOrange':
      case 'shootBlue': {
        const base = name === 'shootOrange' ? 520 : 680;
        this.tone(out, 'square', base, base * 1.9, t, 0.09, 0.18);
        this.burst(out, t, 0.06, 2600, 0.12);
        break;
      }
      case 'portalOpen':
        this.tone(out, 'sine', 180, 520, t, 0.35, 0.3);
        this.burst(out, t, 0.3, 900, 0.08);
        break;
      case 'fizzle':
        this.burst(out, t, 0.25, 1800, 0.25);
        this.tone(out, 'sawtooth', 300, 90, t, 0.22, 0.12);
        break;
      case 'teleport':
        this.tone(out, 'sine', 880, 330, t, 0.25, 0.18);
        this.burst(out, t, 0.18, 4000, 0.06);
        break;
      case 'hurt':
        this.burst(out, t, 0.12, 700, 0.35);
        this.tone(out, 'square', 140, 90, t, 0.12, 0.15);
        break;
      case 'death':
        this.tone(out, 'sawtooth', 300, 40, t, 0.7, 0.25);
        this.burst(out, t, 0.5, 500, 0.3);
        break;
      case 'respawn':
        this.tone(out, 'sine', 300, 600, t, 0.25, 0.15);
        break;
      case 'goal':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(out, 'triangle', f, f, t + i * 0.09, 0.35, 0.2));
        break;
      case 'slam':
        this.tone(out, 'sine', 90, 30, t, 0.45, 0.8);
        this.burst(out, t, 0.25, 400, 0.7);
        break;
      case 'warn':
        this.tone(out, 'square', 980, 980, t, 0.08, 0.12);
        break;
      case 'door':
        this.tone(out, 'sawtooth', 70, 110, t, 0.6, 0.15);
        this.burst(out, t, 0.5, 300, 0.12);
        break;
      case 'sizzle':
        this.burst(out, t, 0.6, 5000, 0.3);
        break;
      case 'orb':
        this.tone(out, 'triangle', 988, 988, t, 0.12, 0.2);
        this.tone(out, 'triangle', 1480, 1480, t + 0.07, 0.25, 0.2);
        this.tone(out, 'sine', 2960, 2960, t + 0.07, 0.2, 0.05);
        break;
      case 'steal':
        this.tone(out, 'sawtooth', 220, 880, t, 0.18, 0.12);
        this.tone(out, 'sine', 1320, 660, t + 0.12, 0.3, 0.18);
        this.burst(out, t, 0.2, 3000, 0.1);
        break;
      case 'land':
        this.burst(out, t, 0.08, 350, 0.3);
        break;
      case 'click':
        this.tone(out, 'square', 1400, 1400, t, 0.03, 0.08);
        break;
    }
  }

  private tone(out: AudioNode, type: OscillatorType, f0: number, f1: number, t: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private burst(out: AudioNode, t: number, dur: number, cutoff: number, vol: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(out);
    src.start(t);
    src.stop(t + dur + 0.05);
  }
}
