"""说话人分离 - 基于嵌入聚类的轻量方案

策略：用 whisper 已有的分段，对每段音频提取说话人嵌入，然后聚类。
不跑 pyannote 全量分割模型（太慢），只用嵌入提取器 + 快速聚类。

用法：
  python diarize.py <音频文件> <whisper转写md> <输出md> [threshold]

threshold：聚类阈值，越小越宽容合并（默认 0.25）
  - 0.50：可能分出 10+ 说话人（太严格）
  - 0.35：约 6 说话人
  - 0.25：约 3-4 说话人（推荐）
  - 0.15：可能合并到 2 说话人（太宽松）

依赖：sherpa-onnx + av + numpy
模型：~/speaker_embed.onnx（3DSpeaker ERES2Net，约 40MB）
  下载：https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx
"""
import sys, os, numpy as np, sherpa_onnx, av

audio_path = sys.argv[1]
whisper_md_path = sys.argv[2]
out_path = sys.argv[3]
threshold = float(sys.argv[4]) if len(sys.argv) > 4 else 0.25
EMBED_MODEL = os.path.expanduser("~/speaker_embed.onnx")
SR = 16000

# ---------- 1. 解码音频 ----------
print("解码音频...", flush=True)
container = av.open(audio_path)
resampler = av.AudioResampler(format='s16', layout='mono', rate=SR)
all_buf = bytearray()
for frame in container.decode(audio=0):
    for rf in resampler.resample(frame):
        all_buf.extend(rf.to_ndarray().tobytes())
container.close()
audio = np.frombuffer(bytes(all_buf), dtype=np.int16).astype(np.float32) / 32768.0
print(f"音频: {len(audio)} samples = {len(audio)/SR:.1f}s", flush=True)

# ---------- 2. 读取 whisper 分段 ----------
with open(whisper_md_path, "r", encoding="utf-8") as f:
    lines = f.readlines()
whisper_segs = []
for line in lines:
    line = line.strip()
    if line.startswith("[") and "]" in line:
        ts_end = line.index("]")
        ts = line[1:ts_end]
        parts = ts.split(":")
        if len(parts) == 2:
            sec = int(parts[0]) * 60 + int(parts[1])
        elif len(parts) == 3:
            sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        else:
            continue
        text = line[ts_end+1:].strip()
        whisper_segs.append({"start": sec, "text": text})
print(f"whisper 段数: {len(whisper_segs)}", flush=True)

# ---------- 3. 对每段提取说话人嵌入 ----------
print("提取说话人嵌入...", flush=True)
extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
    sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=EMBED_MODEL, num_threads=2))

embeddings = []
for i, ws in enumerate(whisper_segs):
    start_sample = int(ws["start"] * SR)
    seg_start = max(0, start_sample - SR)
    seg_end = min(len(audio), start_sample + int(3 * SR))
    seg_audio = audio[seg_start:seg_end]
    if len(seg_audio) < SR * 0.5:
        embeddings.append(None)
        continue
    stream = extractor.create_stream()
    stream.accept_waveform(SR, seg_audio.tolist())
    stream.input_finished()
    emb = extractor.compute(stream)
    embeddings.append(emb)
    if (i + 1) % 50 == 0:
        print(f"  {i+1}/{len(whisper_segs)}", flush=True)
print(f"嵌入提取完成: {sum(1 for e in embeddings if e is not None)}/{len(embeddings)}", flush=True)

# ---------- 4. 快速聚类 ----------
print(f"聚类 (threshold={threshold})...", flush=True)
manager = sherpa_onnx.SpeakerEmbeddingManager(extractor.dim)
valid_indices = [i for i, e in enumerate(embeddings) if e is not None]
speaker_map = {}
next_id = 0
for i in valid_indices:
    emb = embeddings[i]
    matched = manager.search(emb, threshold=threshold)
    if matched:
        speaker_map[i] = matched
    else:
        name = str(next_id)
        manager.add(name, emb)
        speaker_map[i] = name
        next_id += 1
num_speakers = next_id
print(f"说话人数: {num_speakers}", flush=True)

speaker_names = {str(i): chr(65 + i) for i in range(num_speakers)}
for i, ws in enumerate(whisper_segs):
    ws["speaker"] = speaker_map.get(i, "0")

# ---------- 5. 输出（每段之间空行） ----------
with open(out_path, "w", encoding="utf-8") as f:
    f.write(f"# 说话人分离转写稿\n\n")
    f.write(f"> 说话人数: {num_speakers} | whisper 段数: {len(whisper_segs)} | threshold: {threshold}\n")
    f.write(f"> 说话人标注由 sherpa-onnx 嵌入聚类生成，可能有不准确之处。\n\n---\n\n")
    for ws in whisper_segs:
        m, s = divmod(ws["start"], 60)
        name = speaker_names.get(ws["speaker"], "?")
        f.write(f"[{m:02d}:{s:02d}] 说话人{name}: {ws['text']}\n\n")
print(f"完成 → {out_path} | 说话人: {num_speakers}", flush=True)
