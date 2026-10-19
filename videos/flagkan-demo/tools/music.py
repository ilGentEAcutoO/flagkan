"""Procedural, royalty-free music bed for the FlagKan demo (zero cost, deterministic).

Warm electronic bed, 100 BPM, vi-IV-I-V in C with a lift section. Layers: detuned pad,
plucked arpeggio, sub bass, soft kick / hat / clap with kick-ducking on the pad.
Usage: python music.py <seconds> <out.wav> [--sections a,b,c...]  (section = start times
for the full groove, the breakdown and the final hit, in seconds)
"""
import sys, wave
import numpy as np

SR = 48000
BPM = 100.0
BEAT = 60.0 / BPM
rng = np.random.default_rng(7)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def onepole_lp(x, fc):
    a = np.exp(-2 * np.pi * fc / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):  # fine for our lengths in chunks
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y


def lp(x, fc):
    # fast vectorised 1-pole via scipy-free IIR using cumulative trick (approx by FFT filter)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    H = 1 / np.sqrt(1 + (f / fc) ** 4)  # 2nd-order-ish rolloff
    return np.fft.irfft(X * H, n=len(x))


def saw(freq, t):
    ph = (freq * t) % 1.0
    return 2 * ph - 1


def env_adsr(n, a, d, s, r, sustain_len):
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    s_n = max(0, int(sustain_len * SR) - a_n - d_n)
    e = np.concatenate([np.linspace(0, 1, max(a_n, 1)), np.linspace(1, s, max(d_n, 1)), np.full(s_n, s), np.linspace(s, 0, max(r_n, 1))])
    if len(e) < n:
        e = np.pad(e, (0, n - len(e)))
    return e[:n]


def main():
    total = float(sys.argv[1]); out = sys.argv[2]
    secs = [12.0, 88.0, 128.0]
    if '--sections' in sys.argv:
        secs = [float(v) for v in sys.argv[sys.argv.index('--sections') + 1].split(',')]
    groove_at, break_at, final_at = secs
    N = int(total * SR) + SR
    t_all = np.arange(N) / SR
    mix_pad = np.zeros(N); mix_arp = np.zeros(N); mix_bass = np.zeros(N); mix_drm = np.zeros(N)
    duck = np.ones(N)

    # chords (MIDI): Am, F, C, G  -> voicings around middle C
    prog = [[57, 60, 64, 69], [53, 57, 60, 65], [55, 60, 64, 67], [55, 59, 62, 67]]
    roots = [45, 41, 48, 43]
    bar = 4 * BEAT
    nbars = int(total / bar) + 2
    for b in range(nbars):
        t0 = b * bar
        ci = b % 4
        # lift: in the second half of every 8 bars use a brighter voicing
        ch = prog[ci]
        i0 = int(t0 * SR); n = int((bar + 1.2) * SR)
        if i0 >= N:
            break
        n = min(n, N - i0)
        tt = np.arange(n) / SR
        pad = np.zeros(n)
        for note in ch:
            f = midi(note)
            for det in (-0.08, 0.0, 0.09):
                pad += saw(f * 2 ** (det / 12), tt + rng.random())
        pad *= env_adsr(n, 0.6, 0.8, 0.8, 1.2, bar) / (len(ch) * 3)
        mix_pad[i0:i0 + n] += pad
        # arp: 8ths over chord tones + octave
        tones = ch + [ch[1] + 12, ch[2] + 12]
        pattern = [0, 2, 1, 3, 4, 2, 5, 3]
        for k in range(8):
            ts = t0 + k * BEAT / 2
            if ts < 2.0:
                continue
            j0 = int(ts * SR); m = int(0.9 * SR)
            if j0 + m > N:
                continue
            tk = np.arange(m) / SR
            f = midi(tones[pattern[k]] + 12)
            sig = (np.sin(2 * np.pi * f * tk) + 0.35 * np.sin(2 * np.pi * 2 * f * tk) + 0.12 * np.sin(2 * np.pi * 3 * f * tk))
            sig *= np.exp(-tk * 7.5) * (1 - np.exp(-tk * 400))
            vel = 0.55 + 0.25 * (k % 2 == 0)
            mix_arp[j0:j0 + m] += sig * vel
        # bass + drums only in groove sections
        in_groove = groove_at <= t0 < break_at or t0 >= break_at + 8 * BEAT * 2 and t0 < final_at
        if in_groove:
            for k in range(8):
                ts = t0 + k * BEAT / 2
                j0 = int(ts * SR); m = int(BEAT / 2 * SR * 0.95)
                if j0 + m > N:
                    continue
                tk = np.arange(m) / SR
                f = midi(roots[ci] - 12 + (12 if k in (3, 7) else 0))
                sig = 0.8 * np.sin(2 * np.pi * f * tk) + 0.25 * saw(f, tk)
                sig *= np.minimum(1, tk * 200) * np.exp(-tk * 3)
                mix_bass[j0:j0 + m] += sig
            for k in range(4):
                ts = t0 + k * BEAT
                j0 = int(ts * SR)
                if k in (0, 2):  # kick
                    m = int(0.35 * SR)
                    if j0 + m <= N:
                        tk = np.arange(m) / SR
                        fk = 48 + 90 * np.exp(-tk * 30)
                        mix_drm[j0:j0 + m] += np.sin(2 * np.pi * np.cumsum(fk) / SR) * np.exp(-tk * 9) * 0.9
                        dl = int(0.3 * SR)
                        duck[j0:j0 + dl] = np.minimum(duck[j0:j0 + dl], 1 - 0.45 * np.exp(-np.arange(dl) / SR * 10))
                if k in (1, 3):  # soft clap
                    m = int(0.18 * SR)
                    if j0 + m <= N:
                        tk = np.arange(m) / SR
                        nz = rng.standard_normal(m)
                        mix_drm[j0:j0 + m] += nz * np.exp(-tk * 22) * 0.07
                # hats on offbeats
                th = ts + BEAT / 2
                h0 = int(th * SR); m = int(0.06 * SR)
                if h0 + m <= N:
                    tk = np.arange(m) / SR
                    nz = rng.standard_normal(m)
                    nz = nz - np.concatenate([[0], nz[:-1]])  # crude highpass
                    mix_drm[h0:h0 + m] += nz * np.exp(-tk * 60) * 0.035

    pad = lp(mix_pad, 1400) * duck
    arp = lp(mix_arp, 5200)
    bass = lp(mix_bass, 420)
    drm = lp(mix_drm, 9000)
    # simple stereo: arp ping-pong-ish delay
    dly = int(BEAT * 0.75 * SR)
    arpL = arp.copy(); arpR = np.concatenate([np.zeros(dly), arp[:-dly]]) * 0.6 + arp * 0.5
    arpL[dly:] += arp[:-dly] * 0.25
    L = pad * 0.55 + arpL * 0.22 + bass * 0.35 + drm * 0.5
    R = pad * 0.55 + arpR * 0.22 + bass * 0.35 + drm * 0.5
    st = np.stack([L, R], 1)
    # global fades: intro swell, final ring-out
    n = int(total * SR)
    st = st[:n]
    g = np.ones(n)
    fi = int(1.5 * SR); g[:fi] = np.linspace(0, 1, fi)
    fo = int(3.0 * SR); g[-fo:] = np.linspace(1, 0, fo) ** 1.5
    st *= g[:, None]
    st /= np.max(np.abs(st)) + 1e-9
    st *= 0.8
    with wave.open(out, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((st * 32767).astype('<i2').tobytes())


main()
