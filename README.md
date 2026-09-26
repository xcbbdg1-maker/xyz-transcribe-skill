# xyz-transcribe-skill

从小宇宙（xiaoyuzhoufm.com）单集链接提取音频，用 faster-whisper 本地转写为带时间戳的 Markdown 文字稿。

## 解决什么问题

小宇宙播客的逐字稿是 APP 专属功能，网页端不暴露，调用内部 API 需要手机抓包凭证。本工具绕过这些限制：直接下载公开音频，本地 Whisper 转写，零凭证、零云端调用。

## 工作流程

```
小宇宙单集 URL
  → curl 下载页面 HTML（落盘，不进上下文）
  → 提取 __NEXT_DATA__ 拿标题 + 音频地址
  → 下载音频 .m4a（缓存复用）
  → faster-whisper 本地转写（CPU int8）
  → 拼接元信息头 + 时间戳正文 → Markdown
```

## 前置条件

- Node.js ≥ 21
- Python 3 + faster-whisper + av（`pip install faster-whisper av`）
- [video-transcribe-skill](https://github.com/xcbbdg1-maker/video-transcribe-skill) 的 `transcribe.py`（同级目录 / `~/video-transcribe-skill/` / `TRANSCRIBE_SCRIPT` 环境变量）

## 用法

```bat
:: 1.（可选）设国内模型镜像
set HF_ENDPOINT=https://hf-mirror.com

:: 2. 一条命令搞定
node extract.mjs "https://www.xiaoyuzhoufm.com/episode/xxxx" "output.md" --model medium --prompt "税务,CPA,四大"
```

参数：
- 第1参数：小宇宙单集 URL（必填）
- 第2参数：输出 md 路径（默认 transcript.md）
- `--model=`：whisper 模型（base/small/medium/large-v3，默认 medium）
- `--prompt=`：领域术语提示，减少同音错字

## 输出格式

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

## token 节约设计

本 skill 的核心设计原则：**LLM 是调度者，不是数据搬运工**。

- 页面 HTML、音频、转写结果全部写临时文件，不进 LLM 上下文
- 从 HTML 只读 `__NEXT_DATA__` 片段
- 转写完成后只报段数和末行，不读 md 全文
- 进度信息走 stderr，可被重定向到日志

## 文件说明

| 文件 | 说明 |
|---|---|
| `extract.mjs` | 端到端提取脚本，Node ESM 零外部依赖 |
| `SKILL.md` | ThinCoder skill 指令文件 |

## 依赖关系

转写核心依赖 [video-transcribe-skill](https://github.com/xcbbdg1-maker/video-transcribe-skill) 的 `transcribe.py`（faster-whisper 封装）。三个查找路径，按优先级：
1. `TRANSCRIBE_SCRIPT` 环境变量
2. 同级目录 `transcribe.py`
3. `~/video-transcribe-skill/scripts/transcribe.py`

## 权限边界

- 只下载公开音频（页面 `__NEXT_DATA__` 直接暴露的 CDN 地址）
- 不调用小宇宙内部 API，不需要任何登录凭证
- 纯本地转写，不向第三方上传
- 转写结果含同音错字，引用前须人工校对

## License

MIT
