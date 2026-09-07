"""Reads every scene aloud with a neural voice and keeps the word timings for the captions.

Run: npm run voice
Needs: pip install edge-tts ; ffprobe on PATH (ships with ffmpeg).
"""
import asyncio, json, os, subprocess
import edge_tts

VOICE = "en-US-AndrewMultilingualNeural"
HERE = os.path.dirname(os.path.abspath(__file__))
scenes = json.load(open(os.path.join(HERE, "scenes.json"), encoding="utf8"))
os.makedirs(os.path.join(HERE, "public", "audio"), exist_ok=True)
os.makedirs(os.path.join(HERE, "src", "gen"), exist_ok=True)

async def read(scene):
    out = os.path.join(HERE, "public", "audio", f"{scene['id']}.mp3")
    words = []
    with open(out, "wb") as f:
        async for chunk in edge_tts.Communicate(scene["say"], VOICE, rate="+2%", boundary="WordBoundary").stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append({"t": chunk["offset"] / 1e7, "d": chunk["duration"] / 1e7, "w": chunk["text"]})
    # The boundaries come back stripped of punctuation; when they line up one-to-one
    # with the narration's tokens, print the token so the caption keeps its commas.
    tokens = scene["say"].split()
    if len(tokens) == len(words):
        for w, t in zip(words, tokens):
            w["w"] = t
    dur = float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).decode().strip())
    return {"seconds": dur, "words": words}

async def main():
    voice = {}
    for s in scenes:
        voice[s["id"]] = await read(s)
        print(f"{s['id']:<10} {voice[s['id']]['seconds']:5.2f}s  {len(voice[s['id']]['words'])} words")
    json.dump(voice, open(os.path.join(HERE, "src", "gen", "voice.json"), "w", encoding="utf8"), indent=1)

asyncio.run(main())
