"""Pre-duck the music bed under each language's VO (sidechain) -> <project>/assets/music/bed.wav.
Run after build.mjs (needs layout.json). Usage: python mix.py"""
import json, subprocess, pathlib
HERE = pathlib.Path(__file__).resolve().parent
LAY = json.loads((HERE / 'layout.json').read_text())
PROJ = {'en': HERE.parent, 'th': HERE.parent.parent / 'flagkan-demo-th'}
total = LAY['total']
raw = HERE / 'bed-raw.wav'
SHARED = HERE.parent.parent.parent / 'videos' / '_assets' / 'music' / 'flagkan-bed-170s.wav'
if SHARED.exists():  # video-present's shared bed: same music family for both videos
    fo = 3.0
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', str(SHARED), '-t', str(total), '-af',
                    f'afade=t=out:st={total - fo}:d={fo},loudnorm=I=-16.5:TP=-2:LRA=11', '-ar', '48000', '-ac', '2', str(raw)], check=True)
    print('using shared bed', SHARED.name)
else:
  subprocess.run(['python', str(HERE / 'music.py'), str(total + 0.5), str(raw), '--sections',
                f"{LAY['start']['board']:.2f},{LAY['start']['proof']:.2f},{LAY['start']['outro']:.2f}"], check=True)
for lang, P in PROJ.items():
    ins, fl = [], []
    for i, (sid, st) in enumerate(LAY['start'].items()):
        ins += ['-i', str(P / 'assets' / 'voice' / f'{sid}.wav')]
        fl.append(f'[{i + 1}]adelay={int(st * 1000)}:all=1[v{i}]')
    n = len(LAY['start'])
    fc = ';'.join(fl) + ';' + ''.join(f'[v{i}]' for i in range(n)) + f'amix=inputs={n}:normalize=0,aformat=channel_layouts=stereo[vo];'
    # bed sits at about -27 LUFS under speech and rises between lines
    fc += '[0]volume=0.42[bed];[bed][vo]sidechaincompress=threshold=0.02:ratio=6:attack=40:release=450:makeup=1[d]'
    out = P / 'assets' / 'music'; out.mkdir(parents=True, exist_ok=True)
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', str(raw), *ins, '-filter_complex', fc, '-map', '[d]',
                    '-t', str(total), '-ar', '48000', str(out / 'bed.wav')], check=True)
    print(lang, 'bed ok')
