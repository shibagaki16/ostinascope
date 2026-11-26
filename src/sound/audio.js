// Ostinascope — Web Audio engine.
//
// One shared clock (BPM) for everything. Each detected pattern owns a
// voice: a loop of steps scheduled ahead of time on that clock.
//   - a new voice starts on the next beat and fades in
//   - structural changes (new subdivision, new ratio…) wait for a bar line
//     and must be requested a few times in a row (hysteresis)
//   - a lost pattern fades its voice out over 1–2 bars
// All sounds are synthesised; no samples to load.

import { mtof } from './mapping.js';

const LOOKAHEAD = 0.12; // seconds scheduled ahead
const TICK_MS = 25;
const REVERB_SEND = { hat: 0.05, kick: 0.04, mallet: 0.3, blip: 0.35, drone: 0.4 };

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.bpm = 108;
    this.voices = new Map();
    this.events = [];
    this.t0 = 0;
    this.timer = null;
    this.volume = 0.9;
    this.muted = false; // the output faded to 0 (page hidden)
    this.broken = false; // the context no longer works: make a new one on the next tap
    this.watched = null;
  }

  /** Must be called synchronously inside a user gesture (iOS). */
  unlock() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    try {
      // iOS 16.4+: play through the speaker even with the silent switch on
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch {
      /* not supported */
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const b = ctx.createBuffer(1, 1, ctx.sampleRate);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    s.start(0);
    ctx.resume();
    this._build();
  }

  _build() {
    const ctx = this.ctx;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 10;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.75;
    this.bus.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.6);
    this.revIn = ctx.createGain();
    this.revOut = ctx.createGain();
    this.revOut.gain.value = 0.32;
    this.revIn.connect(this.reverb);
    this.reverb.connect(this.revOut);
    this.revOut.connect(this.comp);

    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  _impulse(sec) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * sec);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const k = i / len;
        lp += 0.35 * (Math.random() * 2 - 1 - lp); // soften the tail
        data[i] = lp * (1 - k) ** 3.2 * (i < rate * 0.012 ? i / (rate * 0.012) : 1);
      }
    }
    return buf;
  }

  start() {
    if (this.timer) return;
    this.t0 = this.ctx.currentTime + 0.1;
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }
  /** Whether sound comes out (false: not started, suspended, — iOS — interrupted, or broken). */
  get running() {
    return !!this.ctx && this.ctx.state === 'running' && !this.broken;
  }
  get beat() {
    return 60 / this.bpm;
  }
  get bar() {
    return 4 * this.beat;
  }
  get latency() {
    const c = this.ctx;
    return c ? (c.outputLatency || 0) + (c.baseLatency || 0) : 0;
  }

  setBpm(bpm) {
    if (this.ctx && this.timer) {
      const now = this.ctx.currentTime;
      const pos = (now - this.t0) / this.beat;
      this.bpm = bpm;
      this.t0 = now - pos * this.beat;
      for (const v of this.voices.values()) if (v.drone) this._retimeDrone(v);
    } else {
      this.bpm = bpm;
    }
  }

  setVolume(v) {
    this.volume = v;
    if (this.master && !this.muted) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Beats since start (fractional), for the HUD. */
  position(t = this.now) {
    const beats = Math.max(0, (t - this.t0 - this.latency) / this.beat);
    return { bar: Math.floor(beats / 4), beat: Math.floor(beats) % 4, beats };
  }

  nextBeatTime(t) {
    return this.t0 + Math.ceil((t - this.t0) / this.beat - 1e-6) * this.beat;
  }
  nextBarTime(t) {
    return this.t0 + Math.ceil((t - this.t0) / this.bar - 1e-6) * this.bar;
  }

  /** Phase (0..1) of a voice's loop as currently heard. */
  loopPhase(v, t = this.now) {
    const dur = v.spec.loopBars * this.bar;
    const x = (t - this.latency - this.t0) / dur;
    return x - Math.floor(x);
  }

  get playingCount() {
    let n = 0;
    for (const v of this.voices.values()) if (v.state !== 'fading') n++;
    return n;
  }

  // -- voices ------------------------------------------------------------

  addVoice(id, spec, level, pan) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const startAt = this.nextBeatTime(now + 0.03);
    const env = ctx.createGain();
    const lvl = ctx.createGain();
    const send = ctx.createGain();
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    lvl.gain.value = level;
    send.gain.value = REVERB_SEND[spec.inst] ?? 0.2;
    env.connect(lvl);
    if (panner) {
      panner.pan.value = pan;
      lvl.connect(panner);
      panner.connect(this.bus);
      panner.connect(send);
    } else {
      lvl.connect(this.bus);
      lvl.connect(send);
    }
    send.connect(this.revIn);

    const v = {
      id, spec, env, lvl, send, panner,
      pending: null, pendingSeen: 0,
      startAt, schedUntil: startAt,
      state: 'playing', fadeEnd: 0,
      ramp: null, drone: null, lastHit: new Map(),
    };
    const fadeIn = spec.kind === 'drone' ? this.bar : 2 * this.beat;
    this._ramp(v, 0, 0.35, 1, startAt, startAt + fadeIn);
    if (spec.kind === 'drone') v.drone = this._startDrone(v, spec, startAt);
    this.voices.set(id, v);
    return v;
  }

  updateVoice(id, spec, level, pan) {
    const v = this.voices.get(id);
    if (!v) return;
    const now = this.ctx.currentTime;
    v.lvl.gain.setTargetAtTime(level, now, 0.25);
    if (v.panner) v.panner.pan.setTargetAtTime(pan, now, 0.3);
    if (spec.sig === v.spec.sig) {
      v.pending = null;
      v.pendingSeen = 0;
      v.spec.tone = spec.tone; // timbre may follow continuously
    } else if (v.pending && v.pending.sig === spec.sig) {
      v.pending = spec;
      v.pendingSeen++;
    } else {
      v.pending = spec;
      v.pendingSeen = 1;
    }
  }

  fadeOut(id, bars) {
    const v = this.voices.get(id);
    if (!v || v.state === 'fading') return;
    const now = this.ctx.currentTime;
    const dur = Math.max(0.05, bars * this.bar);
    const cur = this._envAt(v, now);
    this._ramp(v, cur, cur, 0, now, now + dur);
    v.state = 'fading';
    v.fadeEnd = now + dur;
  }

  resume(id) {
    const v = this.voices.get(id);
    if (!v || v.state !== 'fading') return;
    const now = this.ctx.currentTime;
    const cur = this._envAt(v, now);
    this._ramp(v, cur, cur, 1, now, now + this.beat);
    v.state = 'playing';
  }

  // Envelope automation we can query ourselves (AudioParam.value is not
  // reliable mid-ramp in every browser).
  _ramp(v, pre, a, b, t0, t1) {
    const g = v.env.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(pre, now);
    g.setValueAtTime(a, Math.max(now, t0));
    g.linearRampToValueAtTime(b, Math.max(now, t1));
    v.ramp = { pre, a, b, t0, t1 };
  }
  _envAt(v, t) {
    const r = v.ramp;
    if (!r) return 1;
    if (t < r.t0) return r.pre;
    if (t >= r.t1) return r.b;
    return r.a + ((r.b - r.a) * (t - r.t0)) / (r.t1 - r.t0);
  }

  _remove(v) {
    if (v.drone) for (const o of v.drone.oscs) try { o.stop(); } catch { /* already stopped */ }
    setTimeout(() => {
      try {
        v.env.disconnect();
        v.lvl.disconnect();
        v.send.disconnect();
        if (v.panner) v.panner.disconnect();
      } catch { /* ignore */ }
    }, 200);
    this.voices.delete(v.id);
  }

  stopAll() {
    for (const v of [...this.voices.values()]) this._remove(v);
  }

  /** Visual events whose sound is being heard now. */
  drainEvents() {
    const t = this.now - this.latency;
    const out = [];
    let i = 0;
    while (i < this.events.length && this.events[i].t <= t) out.push(this.events[i++]);
    if (i) this.events.splice(0, i);
    return out;
  }

  // -- scheduler ---------------------------------------------------------

  _tick() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state !== 'running') {
      // Stopped (iOS: a call, another app's sound, a screen recording
      // starting): the context's clock stands still, so no fade ever ends
      // and the voices of lost patterns would pile up. Nothing is heard
      // anyway: drop the fading ones now. Unless we stopped it ourselves
      // (page hidden), ask it to run again now and then.
      for (const v of [...this.voices.values()]) if (v.state === 'fading') this._remove(v);
      const t = Date.now();
      if (!this.held && t >= (this.retryAt || 0)) {
        this.retryAt = t + 1000;
        try {
          const p = ctx.resume();
          if (p && p.catch) p.catch(() => {});
        } catch { /* not now */ }
      }
      return;
    }
    const now = ctx.currentTime;
    const until = now + LOOKAHEAD;
    for (const v of [...this.voices.values()]) {
      if (v.state === 'fading' && now > v.fadeEnd + 0.05) {
        this._remove(v);
        continue;
      }
      let from = Math.max(v.schedUntil, now);
      if (from >= until) continue;
      if (v.pending && v.pendingSeen >= 3) {
        const b = this.nextBarTime(from);
        if (b < until) {
          this._sched(v, from, b);
          this._apply(v, v.pending, b);
          v.pending = null;
          v.pendingSeen = 0;
          from = b;
        }
      }
      this._sched(v, from, until);
      v.schedUntil = until;
    }
    this.events.sort((a, b) => a.t - b.t);
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
  }

  _sched(v, a, b) {
    const spec = v.spec;
    const loopDur = spec.loopBars * this.bar;
    const k0 = Math.floor((a - this.t0) / loopDur);
    const k1 = Math.floor((b - this.t0) / loopDur);
    for (let k = k0; k <= k1; k++) {
      for (let s = 0; s < spec.steps.length; s++) {
        const st = spec.steps[s];
        const t = this.t0 + (k + st.pos) * loopDur;
        if (t < a || t >= b || t < v.startAt - 1e-4) continue;
        this._play(v, st, t);
        this.events.push({ t, id: v.id, step: s, layer: st.layer || 0, vel: st.vel });
      }
    }
  }

  _apply(v, spec, t) {
    v.spec = spec;
    if (v.drone) this._retuneDrone(v, spec, t);
  }

  _play(v, st, t) {
    const tone = v.spec.tone || {};
    const vel = st.vel;
    switch (v.spec.inst) {
      case 'kick':
        return this._kick(v.env, t, vel, tone);
      case 'hat':
        return this._hat(v.env, t, vel, tone);
      case 'mallet':
        return this._mallet(v.env, t, vel, tone, st.midi);
      case 'blip':
        return this._blip(v.env, t, vel, tone, st.midi);
      case 'wood':
        return this._wood(v.env, t, vel, tone, st.midi);
      default:
        return undefined; // drone: continuous, steps are visual only
    }
  }

  // -- instruments -------------------------------------------------------

  _env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t + attack + decay);
  }

  _kick(dest, t, vel, tone) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const dec = tone.decay ?? 0.4;
    o.frequency.setValueAtTime(tone.f0 ?? 150, t);
    o.frequency.exponentialRampToValueAtTime(tone.f1 ?? 48, t + 0.09);
    this._env(g, t, vel, 0.002, dec);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dec + 0.05);
    if (tone.click > 0) this._noiseBurst(dest, t, vel * tone.click * 0.35, 0.012, 'bandpass', 3200);
  }

  _hat(dest, t, vel, tone) {
    this._noiseBurst(dest, t, vel * 0.55, tone.decay ?? 0.05, 'highpass', tone.cutoff ?? 7500);
  }

  _noiseBurst(dest, t, peak, decay, type, freq) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (type === 'bandpass') f.Q.value = 1.2;
    const g = ctx.createGain();
    this._env(g, t, peak, 0.001, decay);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.8, decay + 0.05);
  }

  _mallet(dest, t, vel, tone, midi) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const dec = tone.decay ?? 0.4;
    const g = ctx.createGain();
    this._env(g, t, vel * 0.5, 0.003, dec);
    const o1 = ctx.createOscillator();
    o1.frequency.value = f;
    o1.connect(g);
    const o2 = ctx.createOscillator();
    o2.frequency.value = f * 3.98;
    const g2 = ctx.createGain();
    this._env(g2, t, vel * 0.22 * (0.5 + (tone.hard ?? 0.5)), 0.001, dec * 0.18);
    o2.connect(g2);
    g.connect(dest);
    g2.connect(dest);
    for (const o of [o1, o2]) {
      o.start(t);
      o.stop(t + dec + 0.1);
    }
  }

  // A small woody knock: a pitched triangle that drops onto its note, plus
  // a band-passed click.
  _wood(dest, t, vel, tone, midi) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const dec = tone.decay ?? 0.16;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f * 1.5, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.018);
    const g = ctx.createGain();
    this._env(g, t, vel * 0.55 * (tone.body ?? 1), 0.001, dec);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dec + 0.05);
    this._noiseBurst(dest, t, vel * 0.25, 0.015, 'bandpass', Math.min(9000, f * 6));
  }

  _blip(dest, t, vel, tone, midi) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const dec = tone.decay ?? 0.18;
    const car = ctx.createOscillator();
    car.type = 'sine';
    car.frequency.value = f;
    const mod = ctx.createOscillator();
    mod.frequency.value = f * 2;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(f * (tone.fm ?? 1.5), t);
    mg.gain.exponentialRampToValueAtTime(f * 0.05, t + dec * 0.6);
    mod.connect(mg).connect(car.frequency);
    const g = ctx.createGain();
    this._env(g, t, vel * 0.4, Math.max(0.001, tone.attack ?? 0.004), dec);
    car.connect(g).connect(dest);
    for (const o of [car, mod]) {
      o.start(t);
      o.stop(t + dec + 0.1);
    }
  }

  _startDrone(v, spec, t) {
    const ctx = this.ctx;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 5;
    filt.frequency.value = spec.tone.cutoff;
    const amp = ctx.createGain();
    amp.gain.value = 0.85;
    const oscs = [];
    const voices = [];
    spec.notes.forEach((m, i) => {
      for (const cents of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(m) * 2 ** (cents / 1200);
        const g = ctx.createGain();
        g.gain.value = i === 0 ? 0.16 : 0.1;
        o.connect(g).connect(filt);
        oscs.push(o);
        voices.push({ o, note: i, cents });
      }
    });
    const sub = ctx.createOscillator();
    sub.frequency.value = mtof(spec.notes[0] - 12);
    const sg = ctx.createGain();
    sg.gain.value = 0.22;
    sub.connect(sg).connect(amp);
    oscs.push(sub);

    // tempo-synced swell: filter sweep + a little amplitude movement
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 1 / (spec.lfoBeats * this.beat);
    const lfoF = ctx.createGain();
    lfoF.gain.value = spec.tone.cutoff * 0.8 * spec.tone.depth;
    const lfoA = ctx.createGain();
    lfoA.gain.value = 0.18 * spec.tone.depth;
    lfo.connect(lfoF).connect(filt.frequency);
    lfo.connect(lfoA).connect(amp.gain);
    oscs.push(lfo);

    filt.connect(amp).connect(v.env);
    for (const o of oscs) o.start(t);
    return { oscs, voices, sub, lfo, lfoF, filt };
  }

  _retuneDrone(v, spec, t) {
    const d = v.drone;
    for (const { o, note, cents } of d.voices) {
      const m = spec.notes[Math.min(note, spec.notes.length - 1)];
      o.frequency.setTargetAtTime(mtof(m) * 2 ** (cents / 1200), t, 0.4);
    }
    d.sub.frequency.setTargetAtTime(mtof(spec.notes[0] - 12), t, 0.4);
    d.filt.frequency.setTargetAtTime(spec.tone.cutoff, t, 0.5);
    d.lfoF.gain.setTargetAtTime(spec.tone.cutoff * 0.8 * spec.tone.depth, t, 0.5);
    d.lfo.frequency.setValueAtTime(1 / (spec.lfoBeats * this.beat), t);
  }

  _retimeDrone(v) {
    const now = this.ctx.currentTime;
    v.drone.lfo.frequency.setValueAtTime(1 / (v.spec.lfoBeats * this.beat), now);
  }

  // The output to 0 (or back to the volume) — quickly, without a click.
  _mute(on) {
    this.muted = on;
    if (!this.master) return;
    const g = this.master.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(on ? 0 : this.volume, t + (on ? 0.03 : 0.15));
  }

  // Page hidden (or going away). Silence first, then stop: stopped in the
  // middle of a note — by us, or by iOS taking the sound away when the app
  // goes to the background or is closed — the last few milliseconds can
  // keep sounding as a whine. So the output goes to 0 first; if the page
  // is frozen before the timer, it is silence that iOS stops.
  suspend() {
    this.held = true; // on purpose: _tick leaves it stopped
    const ctx = this.ctx;
    if (!ctx) return;
    this._mute(true);
    setTimeout(() => {
      if (!this.held || this.ctx !== ctx || ctx.state !== 'running') return;
      const p = ctx.suspend();
      if (p && p.catch) p.catch(() => {});
    }, 60);
  }
  resumeContext() {
    this.held = false;
    if (!this.ctx) return;
    if (this.muted) this._mute(false); // ramps up once the clock runs again
    if (this.ctx.state !== 'running') {
      const p = this.ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
  }

  /**
   * Called on every frame while the page is shown. iOS, back from the
   * background, can leave the context "running" with its clock standing
   * still (no sound), or never let it run again. Either way it does not
   * come back by itself — only a reload helped: say it is broken, and the
   * next tap makes a new one (revive).
   */
  watch(nowMs = performance.now()) {
    const ctx = this.ctx;
    if (!ctx || this.held) {
      this.watched = null;
      return;
    }
    const w = (this.watched ??= { t: ctx.currentTime, at: nowMs, since: nowMs });
    if (ctx.state === 'running') {
      w.since = nowMs;
      if (ctx.currentTime !== w.t) {
        w.t = ctx.currentTime;
        w.at = nowMs;
        this.broken = false;
      } else if (nowMs - w.at > 1000) {
        this.broken = true; // "running", but its clock stands still
      }
    } else {
      w.at = nowMs;
      if (nowMs - w.since > 1500) this.broken = true; // asked to run, and it does not
    }
  }

  /**
   * A new context in place of one that does not work any more. Must be
   * called synchronously inside a user gesture (iOS). The voices go; the
   * loops start again with the next analysis.
   */
  revive() {
    const old = this.ctx;
    for (const v of [...this.voices.values()]) this._remove(v);
    this.events = [];
    this.ctx = null;
    this.master = null;
    try {
      const p = old && old.close();
      if (p && p.catch) p.catch(() => {});
    } catch {
      /* already closed */
    }
    this.broken = false;
    this.watched = null;
    this.held = false;
    this.muted = false;
    this.unlock();
    if (this.timer) this.t0 = this.ctx.currentTime + 0.1;
  }
}
