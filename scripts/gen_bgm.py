#!/usr/bin/env python3
"""
gen_bgm.py - Generator 4 musik latar (BGM) bawaan CLIPER JOB v1.6.0.
Musik disintesis murni dengan numpy (royalty-free, aman dipakai).
Output: assets/music/<nama>.mp3 (48-64 detik, seamless loop)
"""
import numpy as np
import os
import subprocess
import wave

SR = 44100

def env_ad(n, a, d):
    """attack-decay envelope"""
    e = np.zeros(n)
    an = int(a * SR); dn = int(d * SR)
    an = min(an, n); dn = min(dn, n - an)
    if an > 0: e[:an] = np.linspace(0, 1, an)
    if dn > 0: e[an:an+dn] = np.linspace(1, 0, dn)
    if an + dn < n: e[an+dn:] = 0
    return e

def note(freq, dur, kind='sine', vol=0.5, a=0.01, d=None):
    n = int(dur * SR)
    t = np.arange(n) / SR
    if kind == 'sine':
        w = np.sin(2 * np.pi * freq * t)
    elif kind == 'tri':
        w = 2 * np.abs(2 * ((freq * t) % 1) - 1) - 1
    elif kind == 'soft':
        w = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(4 * np.pi * freq * t) + 0.15 * np.sin(6 * np.pi * freq * t)
    elif kind == 'warm':
        w = np.sin(2 * np.pi * freq * t) + 0.5 * np.sin(2 * np.pi * freq * 0.998 * t) + 0.3 * np.sin(2 * np.pi * freq * 1.004 * t)
    else:
        w = np.sin(2 * np.pi * freq * t)
    if d is None: d = dur * 0.9
    return w * env_ad(n, a, d) * vol

def kick(dur=0.16, vol=0.8):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 95 * np.exp(-t * 18) + 42
    w = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 14) * vol
    return w

def hat(dur=0.05, vol=0.16):
    n = int(dur * SR)
    rng = np.random.default_rng(7)
    w = rng.standard_normal(n) * np.exp(-np.arange(n) / SR * 90) * vol
    return w

def place(buf, start, sig):
    i = int(start * SR)
    j = min(len(buf), i + len(sig))
    if j > i: buf[i:j] += sig[:j-i]

def normalize(x, peak=0.82):
    m = np.max(np.abs(x))
    return x * (peak / m) if m > 0 else x

def save_mp3(name, left, right=None):
    os.makedirs('assets/music', exist_ok=True)
    if right is None: right = left
    L = np.clip(normalize(left), -1, 1)
    R = np.clip(normalize(right), -1, 1)
    data = np.empty(len(L) * 2)
    data[0::2] = L; data[1::2] = R
    pcm = (data * 32767).astype(np.int16)
    wav_tmp = f'/tmp/bgm_{name}.wav'
    with wave.open(wav_tmp, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    out = f'assets/music/{name}.mp3'
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', wav_tmp,
                    '-codec:a', 'libmp3lame', '-b:a', '128k', '-metadata', f'title={name}', out], check=True)
    print('OK', out, os.path.getsize(out) // 1024, 'KB')

# ============ 1. LO-FI CHILL (62 dtk) ============
def lofi_chill():
    bpm = 74; beat = 60 / bpm; bars = 16; N = int(bars * 4 * beat * SR)
    L = np.zeros(N); R = np.zeros(N)
    # progresi Am7 - Fmaj7 - Cmaj7 - G (2 beat per akor)
    chords = [
        [220.0, 261.63, 329.63, 392.0],
        [174.61, 220.0, 261.63, 329.63],
        [130.81, 164.81, 196.0, 246.94],
        [196.0, 246.94, 293.66, 392.0],
    ]
    for b in range(bars * 4):
        t0 = b * beat
        ch = chords[(b // 4) % 4]
        if b % 2 == 0:
            for k, f in enumerate(ch):
                sig = note(f, beat * 1.9, kind='warm', vol=0.11, a=0.05, d=beat * 1.7)
                place(L if k % 2 == 0 else R, t0, sig)
                place(R if k % 2 == 0 else L, t0, sig * 0.5)
        # bass lembut
        if b % 4 == 0:
            place(L, t0, note(ch[0] / 2, beat * 1.6, vol=0.20, a=0.01, d=beat * 1.4))
            place(R, t0, note(ch[0] / 2, beat * 1.6, vol=0.20, a=0.01, d=beat * 1.4))
        # kick tipis + hat
        if b % 4 == 0 or b % 4 == 2:
            place(L, t0, kick(vol=0.32)); place(R, t0, kick(vol=0.32))
        if b % 2 == 1:
            place(L, t0, hat(vol=0.10)); place(R, t0, hat(vol=0.10))
        # melodi pentalan acak (pentatonik A minor)
        if b % 2 == 1 and (b * 7) % 3 != 0:
            mel = [440, 523.25, 587.33, 659.25, 783.99][(b * 5) % 5]
            sig = note(mel, beat * 0.9, vol=0.13, a=0.005, d=beat * 0.8)
            place(L, t0 + beat * 0.5, sig); place(R, t0 + beat * 0.5, sig * 0.8)
    save_mp3('lofi_chill', L, R)

# ============ 2. UPBEAT POP (60 dtk) ============
def upbeat_pop():
    bpm = 108; beat = 60 / bpm; bars = 18; N = int(bars * 4 * beat * SR)
    L = np.zeros(N); R = np.zeros(N)
    chords = [
        [261.63, 329.63, 392.0],    # C
        [220.0, 261.63, 329.63],    # Am
        [174.61, 220.0, 261.63],    # F
        [196.0, 246.94, 293.66],    # G
    ]
    for b in range(bars * 4):
        t0 = b * beat
        ch = chords[(b // 8) % 4]
        # staccato chord pluck tiap beat
        for k, f in enumerate(ch):
            sig = note(f * 2, beat * 0.45, kind='soft', vol=0.10, a=0.004, d=beat * 0.4)
            pan = L if k == 0 else (R if k == 2 else L)
            place(pan, t0, sig); place(R if pan is L else L, t0, sig * 0.45)
        # four-on-the-floor
        place(L, t0, kick(vol=0.5)); place(R, t0, kick(vol=0.5))
        place(L, t0 + beat * 0.5, hat(vol=0.14)); place(R, t0 + beat * 0.5, hat(vol=0.14))
        # bass pluck
        if b % 2 == 0:
            bf = ch[0] / 2
            place(L, t0 + beat * 0.5, note(bf, beat * 0.4, vol=0.24, a=0.004, d=beat * 0.36))
            place(R, t0 + beat * 0.5, note(bf, beat * 0.4, vol=0.24, a=0.004, d=beat * 0.36))
        # hook arpeggio
        if (b // 4) % 2 == 1:
            arp = [ch[0]*2, ch[1]*2, ch[2]*2, ch[1]*2]
            sig = note(arp[b % 4], beat * 0.5, kind='soft', vol=0.12, a=0.003, d=beat * 0.44)
            place(L, t0, sig); place(R, t0, sig)
    save_mp3('upbeat_pop', L, R)

# ============ 3. CINEMATIC PAD (64 dtk) ============
def cinematic():
    dur = 64; N = int(dur * SR)
    t = np.arange(N) / SR
    base = 110.0  # A2
    prog = [(110.0, 164.81, 220.0, 261.63), (98.0, 146.83, 196.0, 246.94),
            (87.31, 130.81, 174.61, 220.0), (110.0, 164.81, 220.0, 293.66)]
    L = np.zeros(N); R = np.zeros(N)
    seg = dur / 4
    for si, ch in enumerate(prog):
        s0, s1 = si * seg, (si + 1) * seg
        i0, i1 = int(s0 * SR), int(s1 * SR)
        n = i1 - i0
        tt = np.arange(n) / SR
        swell = np.minimum(1, tt / (seg * 0.35)) * np.minimum(1, (seg - tt) / (seg * 0.3))
        swell = np.clip(swell, 0, 1)
        for k, f in enumerate(ch):
            w = (np.sin(2 * np.pi * f * tt) + 0.6 * np.sin(2 * np.pi * f * 1.003 * tt + 0.4) +
                 0.35 * np.sin(2 * np.pi * f * 0.5 * tt))
            vib = 1 + 0.004 * np.sin(2 * np.pi * 0.18 * tt + k)
            w = w * vib
            vol = 0.16 * swell
            L[i0:i1] += w * vol * (1 - 0.25 * (k % 2))
            R[i0:i1] += w * vol * (1 - 0.25 * ((k + 1) % 2))
        # bell tipis tiap segmen
        bell_t = s0 + seg * 0.55
        for k, f in enumerate(ch[1:3]):
            sig = note(f * 4, 1.4, vol=0.055, a=0.002, d=1.3)
            place(L, bell_t, sig * (1 if k == 0 else 0.5))
            place(R, bell_t, sig * (1 if k == 1 else 0.5))
    # sub swell awal
    L += 0.05 * np.sin(2 * np.pi * 55 * t) * np.minimum(1, t / 4)
    R += 0.05 * np.sin(2 * np.pi * 55 * t) * np.minimum(1, t / 4)
    save_mp3('cinematic', L, R)

# ============ 4. SOFT AMBIENT (58 dtk) ============
def soft_ambient():
    dur = 58; N = int(dur * SR)
    t = np.arange(N) / SR
    L = np.zeros(N); R = np.zeros(N)
    # pad lembut Cmaj9 bergerak pelan
    freqs = [130.81, 196.0, 246.94, 293.66, 369.99]
    for k, f in enumerate(freqs):
        lfo = 0.5 + 0.5 * np.sin(2 * np.pi * (0.05 + 0.017 * k) * t + k * 1.3)
        w = np.sin(2 * np.pi * f * t + 0.15 * np.sin(2 * np.pi * 0.09 * t + k))
        w += 0.4 * np.sin(2 * np.pi * f * 1.002 * t)
        vol = 0.075 * lfo
        if k % 2 == 0:
            L += w * vol; R += w * vol * 0.8
        else:
            R += w * vol; L += w * vol * 0.8
    # angin halus (noise lowpass via moving average)
    rng = np.random.default_rng(3)
    noise = rng.standard_normal(N)
    kernel = np.ones(220) / 220
    noise = np.convolve(noise, kernel, mode='same')
    L += noise * 0.02; R += noise * 0.02
    # bell jarang
    for i, bt in enumerate(np.arange(6, dur - 4, 7.5)):
        f = [523.25, 659.25, 783.99, 1046.5][i % 4]
        sig = note(f, 2.2, vol=0.05, a=0.003, d=2.0)
        place(L, bt, sig * (0.8 if i % 2 else 1.0))
        place(R, bt, sig * (1.0 if i % 2 else 0.8))
    save_mp3('soft_ambient', L, R)

if __name__ == '__main__':
    lofi_chill()
    upbeat_pop()
    cinematic()
    soft_ambient()
    print('SEMUA BGM SELESAI')
