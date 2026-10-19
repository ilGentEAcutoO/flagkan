"""Generate EN + TH voiceover chunks with edge-tts, trim silence, and compute shared slot timing.

Each chunk i of a scene starts at the same scene-local time in both languages
(slot = max of the two languages' cumulative timings), so motion keyed to
slots is identical across the EN and TH cuts.

Usage: python tts.py [--only scene_id,...]
Writes: tools/vo/<lang>/<scene>-<i>.wav, tools/timing.json,
        <project>/assets/voice/<scene>.wav for both projects.
"""
import asyncio, json, subprocess, sys, os, pathlib

import edge_tts

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent  # videos/
PROJ = {"en": ROOT / "flagkan-demo", "th": ROOT / "flagkan-demo-th"}
S = json.loads((HERE / "script.json").read_text(encoding="utf-8"))
LIVE = json.loads((HERE / "live.json").read_text(encoding="utf-8")) if (HERE / "live.json").exists() else {}
TOK = LIVE.get("tokens", {"BASE": "98", "LIFT": "1.7", "LIFT_TH": "หนึ่งจุดเจ็ด"})


def fill(s):
    for k, v in sorted(TOK.items(), key=lambda kv: -len(kv[0])):
        s = s.replace("{" + k + "}", str(v))
    return s
SR = 48000


def run(*a):
    return subprocess.run(a, check=True, capture_output=True, text=True).stdout


def dur(p):
    return float(run("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)))


async def say(text, voice, rate, out_mp3):
    await edge_tts.Communicate(text, voice, rate=rate).save(str(out_mp3))


def trim(mp3, wav):
    # trim leading/trailing silence, normalise format
    af = ("silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,"
          "areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06,areverse")
    run("ffmpeg", "-y", "-v", "error", "-i", str(mp3), "-af", af, "-ar", str(SR), "-ac", "1", str(wav))


async def main():
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    timing_path = HERE / "timing.json"
    timing = json.loads(timing_path.read_text(encoding="utf-8")) if timing_path.exists() else {}
    for sc in S["scenes"]:
        sid = sc["id"]
        if only and sid not in only and sid in timing:
            continue
        lens = {}
        for lang in ("en", "th"):
            d = HERE / "vo" / lang
            d.mkdir(parents=True, exist_ok=True)
            lens[lang] = []
            for i, ch in enumerate(sc["chunks"]):
                text = fill(ch.get(lang + "Say") or ch[lang])
                mp3 = d / f"{sid}-{i}.mp3"
                wav = d / f"{sid}-{i}.wav"
                for attempt in range(4):
                    try:
                        await say(text, S["voices"][lang], S["rates"][lang], mp3)
                        break
                    except Exception as e:  # transient network errors
                        print("retry", sid, i, lang, e)
                        await asyncio.sleep(2)
                trim(mp3, wav)
                lens[lang].append(dur(wav))
        # shared slots
        t = sc.get("lead", 0.3)
        slots = []
        for i in range(len(sc["chunks"])):
            slots.append(round(t, 3))
            t += max(lens["en"][i], lens["th"][i]) + S["gap"] + sc["chunks"][i].get("pause", 0)
        total = round(t - S["gap"] + sc.get("tail", 0.5), 3)
        timing[sid] = {"slots": slots, "dur": total, "len": lens}
        # assemble scene VO per language
        for lang in ("en", "th"):
            out = PROJ[lang] / "assets" / "voice"
            out.mkdir(parents=True, exist_ok=True)
            inputs, filt = [], []
            for i, s in enumerate(slots):
                inputs += ["-i", str(HERE / "vo" / lang / f"{sid}-{i}.wav")]
                filt.append(f"[{i}]adelay={int(s * 1000)}:all=1[a{i}]")
            mix = "".join(f"[a{i}]" for i in range(len(slots)))
            fc = ";".join(filt) + f";{mix}amix=inputs={len(slots)}:normalize=0,apad=whole_dur={total}[o]"
            run("ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", fc, "-map", "[o]",
                "-ar", str(SR), "-ac", "1", "-t", str(total), str(out / f"{sid}.wav"))
        print(sid, "dur", total, "en", [round(x, 2) for x in lens["en"]], "th", [round(x, 2) for x in lens["th"]])
    timing_path.write_text(json.dumps(timing, indent=1), encoding="utf-8")
    print("TOTAL", round(sum(v["dur"] for v in timing.values()), 2))


asyncio.run(main())
