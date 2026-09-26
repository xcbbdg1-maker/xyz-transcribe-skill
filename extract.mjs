#!/usr/bin/env node
/**
 * 小宇宙播客音频转写提取器
 *
 * 用法：
 *   node extract.mjs <小宇宙单集URL> [输出md路径] [--model medium] [--prompt "领域术语"]
 *
 * 流程（全程不把转写文本拉入上下文，只输出进度到 stderr）：
 *   1. fetch 单集页面 HTML → 提取 __NEXT_DATA__ 拿标题 + 音频地址
 *   2. 下载音频到临时文件
 *   3. 调用 video-transcribe-skill 的 transcribe.py 转写
 *   4. 拼接元信息头（标题/来源/嘉宾/时长/转写方式/免责声明）
 *   5. 输出最终 md 到指定路径
 *
 * 依赖：Node >= 21、Python + faster-whisper（见 video-transcribe-skill）
 *       需设置 TRANSCRIBE_SCRIPT 环境变量指向 transcribe.py，或放同目录。
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- 参数 ----------
const url = process.argv[2];
const outPath = process.argv[3] || 'transcript.md';
const modelArg = process.argv.find(a => a.startsWith('--model='))?.split('=')[1] || 'medium';
const promptArg = process.argv.find(a => a.startsWith('--prompt='))?.split('=')[1] || '';

if (!url || !url.includes('xiaoyuzhoufm.com/episode/')) {
  console.error('用法: node extract.mjs <小宇宙单集URL> [输出md路径] [--model medium] [--prompt "领域术语"]');
  console.error('例: node extract.mjs https://www.xiaoyuzhoufm.com/episode/xxxx output.md --model medium --prompt "税务,CPA"');
  process.exit(1);
}

// ---------- 1. 抓页面元信息 ----------
process.stderr.write('正在获取页面信息…\n');
// 用 curl 存本地，避免大 HTML 进上下文
const htmlTmp = join(tmpdir(), `xyz_page_${Date.now()}.html`);
try {
  execFileSync('curl', ['-s', '--max-time', '15', '-o', htmlTmp, url], { stdio: 'pipe' });
} catch (e) {
  console.error('下载页面失败:', e.message);
  process.exit(1);
}

// 从 HTML 提取 __NEXT_DATA__（只读需要的片段）
const html = readFileSync(htmlTmp, 'utf8');
rmSync(htmlTmp, { force: true });

const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
if (!ndMatch) {
  console.error('未找到 __NEXT_DATA__，页面结构可能已变化。');
  process.exit(1);
}
const data = JSON.parse(ndMatch[1]);
const ep = data?.props?.pageProps?.episode;
if (!ep) {
  console.error('未找到 episode 数据。');
  process.exit(1);
}

const title = ep.title || '未知标题';
const podcastTitle = ep.podcast?.title || '';
const durationSec = ep.duration || 0;
const audioUrl = ep.enclosure?.url || ep.media?.source?.url || '';
const eid = ep.eid || '';

if (!audioUrl) {
  console.error('未找到音频地址。');
  process.exit(1);
}

process.stderr.write(`标题: ${title}\n`);
process.stderr.write(`播客: ${podcastTitle}\n`);
process.stderr.write(`时长: ${Math.floor(durationSec/60)}分钟\n`);
process.stderr.write(`音频: ${audioUrl.slice(0,60)}…\n`);

// ---------- 2. 下载音频 ----------
const audioTmp = join(tmpdir(), `xyz_audio_${eid}.m4a`);
if (!existsSync(audioTmp)) {
  process.stderr.write('正在下载音频…\n');
  try {
    execFileSync('curl', ['-s', '--max-time', '300', '-o', audioTmp, audioUrl], { stdio: 'pipe' });
  } catch (e) {
    console.error('下载音频失败:', e.message);
    process.exit(1);
  }
  const size = execFileSync('curl', ['-sI', audioUrl], { encoding: 'utf8' }).match(/content-length:\s*(\d+)/i);
  process.stderr.write(`音频大小: ${(require('node:fs').statSync(audioTmp).size / 1024 / 1024).toFixed(1)}MB\n`);
} else {
  process.stderr.write('音频已存在，跳过下载\n');
}

// ---------- 3. 转写 ----------
// 找 transcribe.py：环境变量 > 同目录 > 上级 video-transcribe-skill
let scriptPath = process.env.TRANSCRIBE_SCRIPT || '';
if (!scriptPath || !existsSync(scriptPath)) {
  const candidates = [
    join(__dirname, 'transcribe.py'),
    join(__dirname, '..', 'video-transcribe-skill', 'scripts', 'transcribe.py'),
    join(require('node:os').homedir(), 'video-transcribe-skill', 'scripts', 'transcribe.py'),
  ];
  scriptPath = candidates.find(existsSync) || '';
}
if (!scriptPath) {
  console.error('未找到 transcribe.py。请设置 TRANSCRIBE_SCRIPT 环境变量，或将 video-transcribe-skill 放在同级目录。');
  process.exit(1);
}
process.stderr.write(`转写脚本: ${scriptPath}\n`);
process.stderr.write(`模型: ${modelArg}\n`);
process.stderr.write('开始转写（这可能需要几分钟）…\n');

const transcribeOut = join(tmpdir(), `xyz_transcript_${eid}`);
mkdirSync(transcribeOut, { recursive: true });

try {
  execFileSync('python', [
    scriptPath, audioTmp,
    '--model', modelArg,
    '--out', transcribeOut,
    '--lang', 'zh',
    ...(promptArg ? ['--prompt', promptArg] : []),
  ], { stdio: 'pipe', timeout: 600000 });
} catch (e) {
  console.error('转写失败:', e.message);
  process.exit(1);
}

// 找生成的 md 文件
const audioBase = basename(audioTmp, '.m4a');
const transcriptFile = join(transcribeOut, audioBase + '.md');
if (!existsSync(transcriptFile)) {
  console.error(`转写输出未找到: ${transcriptFile}`);
  process.exit(1);
}

// ---------- 4. 拼接元信息头 ----------
// 读取转写结果，去掉原始头部，加新头部
const rawTranscript = readFileSync(transcriptFile, 'utf8');
// 去掉原始头部（# 标题行 + ⚠️ 提示行），保留正文 + DONE 标记
const bodyStart = rawTranscript.indexOf('[00:');
const body = bodyStart >= 0 ? rawTranscript.slice(bodyStart) : rawTranscript;

const durationStr = `${Math.floor(durationSec/3600)}小时${Math.floor((durationSec%3600)/60)}分钟${durationSec%60}秒`;

const md = `# ${title}

- 来源：${url}
- 播客：${podcastTitle}
- 时长：${durationStr}
- 转写方式：faster-whisper ${modelArg} 模型本地转写（CPU int8）
- 说明：以下内容为 AI 语音转写，保留时间戳，未对识别错误进行人工改写，含同音错字，引用前须人工校对。

---

${body}`;

// ---------- 5. 输出 ----------
mkdirSync(dirname(outPath) || '.', { recursive: true });
writeFileSync(outPath, md, 'utf8');

// 清理临时文件
rmSync(transcriptFile, { force: true });
try { rmSync(join(transcribeOut), { force: true, recursive: true }); } catch {}
// 音频临时文件保留，下次同 URL 可复用

// 验证（只数行数，不读全文）
const back = readFileSync(outPath, 'utf8');
const stampLines = (back.match(/^\[\d{2}:\d{2}\]/gm) || []).length;
const lastLine = back.trim().split('\n').pop().slice(0, 50);

process.stderr.write(`\n========== 转写完成 ==========\n`);
process.stderr.write(`文件: ${outPath}\n`);
process.stderr.write(`时间戳段数: ${stampLines}\n`);
process.stderr.write(`末行: ${lastLine}\n`);
process.stderr.write(`自动转写内容未经人工校正\n`);
