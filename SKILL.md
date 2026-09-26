# 小宇宙播客音频转写提取

## 用途

从小宇宙（xiaoyuzhoufm.com）单集链接提取音频，用 faster-whisper 本地转写为带时间戳的 Markdown 文字稿。

适用于：小宇宙网页端不暴露文字稿功能、且不方便抓手机 App 凭证的场景。直接下载公开音频本地 Whisper 转写，无需任何登录或凭证。

## 技术原理

1. `curl` 下载单集页面 HTML 到临时文件（不进上下文）
2. 从 `__NEXT_DATA__` JSON 提取标题、播客名、时长、音频 URL
3. 下载音频（.m4a）到临时目录，同 URL 复用缓存
4. 调用 `video-transcribe-skill` 的 `transcribe.py`（faster-whisper CPU int8）转写
5. 拼接元信息头（标题/来源/播客/时长/转写方式/免责声明）输出 md
6. 全程只输出进度到 stderr，转写文本直接落盘不进 LLM 上下文

## 前置条件

- Node.js ≥ 21
- Python 3 + faster-whisper + av（`pip install faster-whisper av`）
- `video-transcribe-skill` 的 `transcribe.py`（通过 `TRANSCRIBE_SCRIPT` 环境变量指定，或放同级目录，或放 `~/video-transcribe-skill/`）
- 首次运行会下载 whisper 模型（设 `HF_ENDPOINT=https://hf-mirror.com` 用国内镜像）

## 操作步骤

### 1. 运行提取

```bat
set HF_ENDPOINT=https://hf-mirror.com
node extract.mjs "<小宇宙单集URL>" "<输出md路径>" --model medium --prompt "领域术语,逗号分隔"
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

### 3. 输出格式

```markdown
# 播客标题

- 来源：https://www.xiaoyuzhoufm.com/episode/xxxx
- 播客：播客名
- 时长：X小时Y分钟Z秒
- 转写方式：faster-whisper medium 模型本地转写（CPU int8）
- 说明：以下内容为 AI 语音转写，保留时间戳，未对识别错误进行人工改写，含同音错字，引用前须人工校对。

---

[00:00] 第一段文字

[00:04] 第二段文字
```

### 4. 完整性校验

- stderr 输出时间戳段数
- stderr 输出末行内容（确认转写到结尾）
- `<!--DONE-->` 标记确认转写完成

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

## 权限边界

- 只下载公开音频（`media.xyzcdn.net`，页面 `__NEXT_DATA__` 直接暴露）
- 不调用小宇宙内部 API，不需要任何登录凭证
- 纯本地转写，不向第三方上传音频或文本
- 转写结果含同音错字，引用前须人工校对
