#!/usr/bin/env python3
"""Procedural score for the "Én Nam" 30 s TVC: a calm, melodic piece that
evokes mountain forests — warm pad, breathy bamboo-flute-like lead in a
pentatonic mode, kalimba/harp plucks, a low string swell for the product
reveal — plus forest ambience (stream, birds, wind gust, the slow-motion
drop "plip"). Everything is synthesized here, so the track is free of
third-party rights.

usage: python3 tvc_music.py out.wav [--impact 15.6] [--dur 30.5]
"""
import argparse
import numpy as np

SR = 44100
ap = argparse.ArgumentParser()
ap.add_argument('out')
ap.add_argument('--dur', type=float, default=30.6)
ap.add_argument('--impact', type=float, default=15.6)    # drop hits the water (video time)
ap.add_argument('--gust', type=float, default=6.3)       # wind gust in the stream shot
ap.add_argument('--reveal', type=float, default=18.5)    # product shot starts
ap.add_argument('--seed', type=int, default=7)
a = ap.parse_args()
rng = np.random.default_rng(a.seed)
N = int(a.dur * SR)
t = np.arange(N) / SR
L = np.zeros(N); R = np.zeros(N)

def midi(n): return 440.0 * 2 ** ((n - 69) / 12)

def env_adsr(n, a_, d_, s_, r_, dur):
    """ADSR envelope of `dur` seconds (+release) sampled at SR."""
    tot = int((dur + r_) * SR)
    e = np.zeros(tot)
    ia, idd = int(a_ * SR), int(d_ * SR)
    sus_end = int(dur * SR)
    e[:ia] = np.linspace(0, 1, ia, endpoint=False) if ia else 0
    e[ia:ia + idd] = np.linspace(1, s_, idd, endpoint=False)
    e[ia + idd:sus_end] = s_
    rel = tot - sus_end
    e[sus_end:] = s_ * np.exp(-np.linspace(0, 6, rel))
    if len(e) < n: e = np.concatenate([e, np.zeros(n - len(e))])
    return e[:n]

def add(sig, start, gl=1.0, gr=1.0):
    i = int(start * SR)
    if i >= N: return
    n = min(len(sig), N - i)
    L[i:i + n] += sig[:n] * gl
    R[i:i + n] += sig[:n] * gr

def onepole(x, fc):
    a_ = np.exp(-2 * np.pi * fc / SR)
    y = np.zeros_like(x)
    acc = 0.0
    for i in range(len(x)):  # fast enough for our sizes after chunking below
        acc = (1 - a_) * x[i] + a_ * acc
        y[i] = acc
    return y

def lowpass(x, fc):
    # FFT brick-ish lowpass with soft knee (vectorised; avoids slow loops)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / np.sqrt(1 + (f / fc) ** 4)
    return np.fft.irfft(X, len(x))

def bandpass(x, lo, hi):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= (1 / np.sqrt(1 + (lo / np.maximum(f, 1)) ** 4)) * (1 / np.sqrt(1 + (f / hi) ** 4))
    return np.fft.irfft(X, len(x))

BPM = 66
beat = 60 / BPM
bar = 4 * beat
# D major pentatonic world; progression (root midi, chord tones)
prog = [
    (50, [62, 66, 69, 76]),   # D add9
    (47, [59, 62, 66, 69]),   # Bm7
    (43, [59, 62, 67, 71]),   # G maj7
    (45, [57, 62, 64, 69]),   # A sus4/sus2
]
nbars = int(np.ceil(a.dur / bar)) + 1

# ---------------- pad (detuned saws, slow filter) ----------------
for b in range(nbars):
    root, tones = prog[b % 4]
    if b == nbars - 2: root, tones = prog[0]
    st = b * bar
    dur = bar
    n = int((dur + 1.6) * SR)
    tt = np.arange(n) / SR
    sig = np.zeros(n)
    for k, m in enumerate(tones):
        for det in (-0.07, 0.0, 0.08):
            f0 = midi(m + det)
            ph = rng.uniform(0, 1)
            saw = 2 * ((f0 * tt + ph) % 1) - 1
            sig += saw * (0.5 if det else 0.7)
    sig = lowpass(sig, 900 + 500 * np.sin(b * 0.7) ** 2)
    e = env_adsr(n, 1.2, 0.5, 0.85, 1.6, dur)[:n]
    sig *= e * 0.012
    add(sig, st, 0.9, 1.0)
    # sub root
    f0 = midi(root)
    sub = np.sin(2 * np.pi * f0 * tt) * env_adsr(n, 0.8, 0.4, 0.8, 1.6, dur)[:n] * 0.05
    add(sub, st)

# ---------------- flute lead (breathy, vibrato) ----------------
def flute(m, dur, vel=1.0):
    f0 = midi(m)
    n = int((dur + 0.5) * SR)
    tt = np.arange(n) / SR
    vib = 1 + 0.006 * np.sin(2 * np.pi * 5.2 * tt) * np.clip((tt - 0.25) / 0.4, 0, 1)
    ph = 2 * np.pi * np.cumsum(f0 * vib) / SR
    tone = np.sin(ph) + 0.28 * np.sin(2 * ph) + 0.08 * np.sin(3 * ph)
    breath = bandpass(rng.standard_normal(n), f0 * 0.8, f0 * 3.5) * 0.35
    e = env_adsr(n, 0.12, 0.2, 0.8, 0.45, dur)[:n]
    chiff = np.exp(-tt * 30) * bandpass(rng.standard_normal(n), 2000, 6000) * 0.4
    return (tone + breath + chiff) * e * 0.07 * vel

# melody: (bar, beat offset, midi, beats)
mel = [
    (1, 0, 74, 1.5), (1, 1.5, 76, 0.5), (1, 2, 78, 2),
    (2, 0, 81, 2), (2, 2, 78, 1), (2, 3, 76, 1),
    (3, 0, 74, 3), (3, 3, 71, 1),
    (4, 0, 69, 2), (4, 2, 71, 1), (4, 3, 74, 1),
    (5, 0, 76, 3.5),
    (6, 0, 78, 1), (6, 1, 81, 1), (6, 2, 83, 2),
    (7, 0, 81, 1.5), (7, 1.5, 78, 0.5), (7, 2, 76, 2),
    (8, 0, 74, 4),
]
for (b, o, m, d) in mel:
    st = b * bar + o * beat
    if st > a.dur - 1: continue
    sig = flute(m, d * beat * 0.95)
    add(sig, st, 0.8, 1.0)

# ---------------- kalimba / harp plucks (Karplus–Strong) ----------------
def pluck(m, dur=2.2, bright=0.5):
    f0 = midi(m)
    n = int(dur * SR)
    p = int(SR / f0)
    buf = rng.uniform(-1, 1, p)
    out = np.zeros(n)
    for i in range(n):
        out[i] = buf[i % p]
        nxt = buf[(i + 1) % p]
        buf[i % p] = (0.996 - 0.004 * (1 - bright)) * 0.5 * (buf[i % p] + nxt)
    out += 0.3 * np.sin(2 * np.pi * f0 * 2 * np.arange(n) / SR) * np.exp(-np.arange(n) / SR * 6)
    return out * 0.05

arp_start = 2  # bars
for b in range(arp_start, nbars - 1):
    root, tones = prog[b % 4]
    pattern = [tones[0] + 12, tones[2] + 12, tones[1] + 12, tones[3] + 12, tones[2] + 12, tones[1] + 12]
    for k, m in enumerate(pattern):
        st = b * bar + k * (bar / 6)
        if st > a.dur - 1.5: break
        pan = 0.5 + 0.4 * np.sin(k * 1.3 + b)
        add(pluck(m, 2.0, 0.4) * (0.8 if k else 1.0), st, 1 - pan * 0.6, 0.4 + pan * 0.6)

# ---------------- low string swell for the product reveal ----------------
n = int((a.dur - a.reveal + 1) * SR)
if n > 0:
    tt = np.arange(n) / SR
    sw = np.zeros(n)
    for m in (38, 45, 50, 57):
        f0 = midi(m)
        for det in (-0.05, 0.05):
            sw += 2 * ((midi(m + det) * tt) % 1) - 1
    sw = lowpass(sw, 700)
    e = np.clip(tt / 2.5, 0, 1) * np.clip((a.dur - a.reveal - tt) / 2.0, 0, 1)
    add(sw * e * 0.008, a.reveal)

# ---------------- reverb (exponential noise IR, FFT convolution) ----------------
def reverb(x, secs=2.6, mix=0.32, seed=1):
    r = np.random.default_rng(seed)
    n = int(secs * SR)
    ir = r.standard_normal(n) * np.exp(-np.arange(n) / SR * (6.9 / secs))
    ir = lowpass(ir, 6000)
    ir /= np.sqrt(np.sum(ir ** 2))
    m = len(x) + n
    y = np.fft.irfft(np.fft.rfft(x, m) * np.fft.rfft(ir, m), m)[:len(x)]
    return x * (1 - mix) + y * mix

L = reverb(L, seed=1); R = reverb(R, seed=2)

# ---------------- forest ambience ----------------
def noise(n, color='pink'):
    w = rng.standard_normal(n)
    X = np.fft.rfft(w)
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = 1
    X /= f ** (0.5 if color == 'pink' else 1.0)
    y = np.fft.irfft(X, n)
    return y / np.max(np.abs(y))

stream = bandpass(noise(N, 'pink'), 300, 3500)
gurgle = 1 + 0.35 * np.sin(2 * np.pi * 0.7 * t) * np.sin(2 * np.pi * 3.1 * t + 1)
stream *= gurgle * 0.05
# stream louder in the stream / product shots
loud = 0.6 + 0.6 * np.clip((t - 4.8) / 0.8, 0, 1) * np.clip((10.5 - t) / 0.8, 0, 1) + 0.4 * np.clip((t - a.reveal) / 1.0, 0, 1)
L += stream * loud * 0.9; R += np.roll(stream, 900) * loud

wind = lowpass(noise(N, 'brown'), 700)
we = 0.15 + 0.85 * np.exp(-((t - a.gust) / 1.0) ** 2)
L += wind * we * 0.06; R += np.roll(wind, 2000) * we * 0.06

def chirp(st, f1, f2, dur, amp, pan):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    f = np.linspace(f1, f2, n) * (1 + 0.04 * np.sin(2 * np.pi * 45 * tt))
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt / dur) ** 2
    add(s * amp, st, 1 - pan, pan)

bt = 0.7
while bt < a.dur - 1:
    if not (14.4 < bt < 18.2):        # quiet during the slow-motion moment
        k = rng.integers(2, 5)
        f = rng.uniform(2600, 4800)
        pan = rng.uniform(0.15, 0.85)
        for j in range(k):
            chirp(bt + j * rng.uniform(0.07, 0.12), f * rng.uniform(0.9, 1.15), f * rng.uniform(1.1, 1.5), rng.uniform(0.05, 0.09), 0.012, pan)
    bt += rng.uniform(1.2, 2.6)

# slow-motion drop: deep "bloop" + secondary drop
def plip(st, f0, amp, slow=1.0):
    n = int(0.6 * slow * SR)
    tt = np.arange(n) / SR
    f = f0 * (1 + 1.2 * (1 - np.exp(-tt * 18 / slow)))
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 9 / slow)
    add(s * amp, st)
plip(a.impact, 260, 0.22, slow=2.2)
plip(a.impact + 0.8, 420, 0.1, slow=1.6)

# soft whooshes on transitions
for st in (4.7, 9.7, 14.2, 18.2, 25.2):
    n = int(1.2 * SR)
    w = bandpass(rng.standard_normal(n), 400, 2600) * np.sin(np.pi * np.arange(n) / n) ** 3 * 0.025
    add(w, st)

# ---------------- master ----------------
mix = np.stack([L, R], 1)
fade_in = np.clip(t / 0.8, 0, 1); fade_out = np.clip((a.dur - t) / 1.6, 0, 1)
mix *= (fade_in * fade_out)[:, None]
mix /= max(1e-6, np.max(np.abs(mix))) / 0.85
import wave
with wave.open(a.out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(mix, -1, 1) * 32767).astype('<i2').tobytes())
print('wrote', a.out, a.dur, 's')
