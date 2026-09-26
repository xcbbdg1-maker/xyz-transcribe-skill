# 小宇宙播客音频转写提取

## 用途

从小宇宙（xiaoyuzhoufm.com）单集链接提取音频，用 faster-whisper 本地转写为带时间戳的 Markdown 文字稿。

适用于：小宇宙网页端不暴露文字稿功能、且不方便抓手机 App 凭证的场景。直接下载公开音频本地 Whisper 转写，无需任何登录或凭证。

## 技术原理

1. `curl` 下载单集页面 HTML 到临时文件（不进上下文）
2. 从 `__NEXT_DATA__` JSON 提取标题、播客名、时长、音频 URL
3. 下载音频（.m4a）到临时目录，同 URL 复用缓存
4. 调用 `video-transcribe-skill` 的 `transcribe.py`（faster-whisper CPU int8）转写
5. （可选）调用 `diarize.py` 做说话人分离
6. 拼接元信息头（标题/来源/播客/时长/转写方式/免责声明）输出 md，每段之间空行
7. 全程只输出进度到 stderr，转写文本直接落盘不进 LLM 上下文

### 说话人分离原理（重要）

不要用 pyannote 全量分割（`OfflineSpeakerDiarization.process()`）——17 分钟音频在 CPU 上超过 10 分钟都跑不完。

正确做法是**嵌入聚类**：
1. 复用 whisper 已有的分段（每段几秒）
2. 对每段取 3 秒音频（段起点前 1 秒 → 后 3 秒）
3. 用 `SpeakerEmbeddingExtractor`（3DSpeaker ERES2Net 模型）提取说话人嵌入
4. 用 `SpeakerEmbeddingManager` 在线聚类：`search(emb, threshold)` 返回匹配的说话人名（str，无匹配返回空串），未匹配则 `add(name, emb)` 新建
5. 全程约 2 分钟（vs pyannote 超 10 分钟未完成）

**关键 API**（sherpa-onnx）：
- `SpeakerEmbeddingExtractor(model=..., num_threads=2)` + `.create_stream()` + `.accept_waveform(SR, list)` + `.input_finished()` + `.compute(stream)` → 嵌入向量
- `SpeakerEmbeddingManager(dim)` + `.search(emb, threshold)` → **str**（说话人名或空串）+ `.add(name_str, emb)` → bool
- ⚠️ `OfflineSpeakerDiarization.process()` 接受 `Sequence[float]`，传 numpy array 可以但极慢，别用

**threshold 调参经验**（3 人对话）：
- 0.50 → 21 个说话人（太散）
- 0.35 → 6 个
- 0.25 → 4 个（推荐起点；多出的少数段噪音说话人，把它的段合并到相邻说话人）
- 0.15 → 可能过度合并

## 前置条件

- Node.js ≥ 21
- Python 3 + faster-whisper + av（`pip install faster-whisper av`）
- `video-transcribe-skill` 的 `transcribe.py`（通过 `TRANSCRIBE_SCRIPT` 环境变量指定，或放同级目录，或放 `~/video-transcribe-skill/`）
- 首次运行会下载 whisper 模型（设 `HF_ENDPOINT=https://hf-mirror.com` 用国内镜像）

仅说话人分离（`--diarize`）额外需要：
- `pip install sherpa-onnx`（纯 ONNX，无需 pytorch）+ numpy
- 说话人嵌入模型 `~/speaker_embed.onnx`（约 40MB）：
  ```
  curl -L -o ~/speaker_embed.onnx "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
  ```

## 操作步骤

### 1. 运行提取

```bat
set HF_ENDPOINT=https://hf-mirror.com
node extract.mjs "<小宇宙单集URL>" "<输出md路径>" --model medium --prompt "领域术语,逗号分隔"
```

带说话人分离：
```bat
node extract.mjs "<小宇宙单集URL>" "<输出md路径>" --diarize --threshold=0.25
```

示例：
```bat
node extract.mjs "https://www.xiaoyuzhoufm.com/episode/6aafe4ceac389df82734d5d7" "output.md" --model medium --prompt "税务,CPA,四大,转移定价,原生家庭"
```

### 2. 参数说明

| 参数 | 说明 | 默认 |
|---|---|---|
| 第1参数 | 小宇宙单集 URL（必填） | - |
| 第2参数 | 输出 md 路径 | transcript.md |
| `--model=` | whisper 模型：base/small/medium/large-v3 | medium |
| `--prompt=` | 领域术语提示，减少同音错字 | 空 |
| `--diarize` | 启用说话人分离（需 sherpa-onnx + 模型） | 关 |
| `--threshold=` | 说话人聚类阈值（越小越宽容合并） | 0.25 |

### 3. 输出格式

```markdown
# 播客标题

- 来源：https://www.xiaoyuzhoufm.com/episode/xxxx
- 播客：播客名
- 时长：X小时Y分钟Z秒
- 转写方式：faster-whisper medium 模型本地转写（CPU int8）
- 说话人分离：sherpa-onnx 嵌入聚类（仅 --diarize 时）
- 说明：以下内容为 AI 语音转写，保留时间戳，未对识别错误进行人工改写，含同音错字，引用前须人工校对。

---

[00:00] 第一段文字

[00:04] 第二段文字
```

带说话人分离时（每段之间空行）：
```markdown
[00:00] 说话人C: 第一段文字

[00:04] 说话人B: 第二段文字
```

### 4. 完整性校验

- stderr 输出时间戳段数
- stderr 输出末行内容（确认转写到结尾）
- `<!--DONE-->` 标记确认转写完成

### 5. 说话人分离后处理：合并噪音说话人

分离结果常常多出一个只有几段的"噪音说话人"（如 4 段的 A）。真实人数已知时，把它的段合并到相邻说话人：

```javascript
// 把只有少数段的说话人合并到前一段的说话人
let prevSpeaker = 'C';
const out = lines.map(line => {
  const m = line.match(/^\[(\d{2}:\d{2})\] 说话人([A-D]): (.*)/);
  if (!m) return line;
  const [, ts, spk, text] = m;
  const realSpk = spk === 'A' ? prevSpeaker : spk;
  prevSpeaker = realSpk;
  return `[${ts}] 说话人${realSpk}: ${text}`;
});
```

## token 节约原则（本 skill 的设计核心）

- **大输出先落盘**：页面 HTML、音频文件、转写结果全部写临时文件，不进 LLM 上下文
- **只取片段**：从 HTML 只读 `__NEXT_DATA__` 那一段，不读全文
- **进度看 stderr 尾部**：转写完成后只报段数和末行，不读 md 全文
- 原则：LLM 是调度者，不是数据搬运工

## 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| 未找到 `__NEXT_DATA__` | 小宇宙页面结构改版 | 检查 HTML 里 JSON 数据位置 |
| 未找到音频地址 | episode 数据缺失 | 确认 URL 是单集（/episode/）而非播客（/podcast/） |
| 未找到 transcribe.py | 脚本路径未配置 | 设 `TRANSCRIBE_SCRIPT` 环境变量 |
| 转写超时 | CPU 上 medium 模型 + 长音频 | 换 `--model=small`，或增大超时 |
| 模型下载失败 | HuggingFace 被墙 | 设 `HF_ENDPOINT=https://hf-mirror.com` |
| 说话人分离超时 | 误用了 pyannote 全量分割 | 改用 `diarize.py` 的嵌入聚类方案 |
| 说话人数过多 | threshold 太高 | 降到 0.25 或 0.2 |
| 未找到 speaker_embed.onnx | 未下载嵌入模型 | 按上方前置条件下载 |
| `search()` 返回类型错误 | 当成 int 用了 | 它返回 **str**（说话人名），空串表示无匹配 |

## 权限边界

- 只下载公开音频（`media.xyzcdn.net`，页面 `__NEXT_DATA__` 直接暴露）
- 不调用小宇宙内部 API，不需要任何登录凭证
- 纯本地转写，不向第三方上传音频或文本
- 转写结果含同音错字，引用前须人工校对
