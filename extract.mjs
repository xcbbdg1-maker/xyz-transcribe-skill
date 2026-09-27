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
 *   4. 拼接元信息头 + 每段之间空行
 *   5. （可选 --diarize）调用 diarize.py 做说话人分离
 *   6. 输出最终 md 到指定路径
 *
 * 可选参数：
 *   --diarize          启用说话人分离（需 sherpa-onnx + 模型，见 diarize.py）
 *   --threshold=0.25   说话人聚类阈值（越小越宽容合并，默认 0.25）
 *
 * 依赖：Node >= 21、Python + faster-whisper（见 video-transcribe-skill）
 *       需设置 TRANSCRIBE_SCRIPT 环境变量指向 transcribe.py，或放同目录。
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- 参数 ----------
const url = process.argv[2];
const outPath = process.argv[3] || 'transcript.md';
const modelArg = process.argv.find(a => a.startsWith('--model='))?.split('=')[1] || 'medium';
const promptArg = process.argv.find(a => a.startsWith('--prompt='))?.split('=')[1] || '';
const doDiarize = process.argv.includes('--diarize');
const thresholdArg = process.argv.find(a => a.startsWith('--threshold='))?.split('=')[1] || '0.25';
const termsArg = process.argv.find(a => a.startsWith('--terms='))?.split('=')[1] || '';
const splitMaxLen = process.argv.find(a => a.startsWith('--max-len='))?.split('=')[1] || '60';

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
  process.stderr.write(`音频大小: ${(statSync(audioTmp).size / 1024 / 1024).toFixed(1)}MB\n`);
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
    join(homedir(), 'video-transcribe-skill', 'scripts', 'transcribe.py'),
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

// 超时按音频时长动态计算：medium 模型 CPU 约 0.6x 实时，给 1.5 倍冗余，下限 10 分钟
// （small 约 0.2x，large-v3 约 1.5x；统一用 1.5x 实时上限兜底）
const transcribeTimeoutMs = Math.max(10 * 60 * 1000, durationSec * 1000 * 1.5);
process.stderr.write(`转写超时上限: ${Math.round(transcribeTimeoutMs / 60000)} 分钟\n`);

try {
  execFileSync('python', [
    scriptPath, audioTmp,
    '--model', modelArg,
    '--out', transcribeOut,
    '--lang', 'zh',
    ...(promptArg ? ['--prompt', promptArg] : []),
  ], { stdio: 'pipe', timeout: transcribeTimeoutMs });
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
let body = bodyStart >= 0 ? rawTranscript.slice(bodyStart) : rawTranscript;

const durationStr = `${Math.floor(durationSec/3600)}小时${Math.floor((durationSec%3600)/60)}分钟${durationSec%60}秒`;

// ---------- 4b. 可选：说话人分离 ----------
let diarizeNote = '';
if (doDiarize) {
  const diarizeScript = join(__dirname, 'diarize.py');
  if (!existsSync(diarizeScript)) {
    process.stderr.write('未找到 diarize.py，跳过说话人分离\n');
  } else {
    process.stderr.write('说话人分离中…\n');
    const diarOut = join(tmpdir(), `xyz_diarized_${Date.now()}.md`);
    try {
      execFileSync('python', [
        diarizeScript, audioTmp, transcriptFile, diarOut,
        thresholdArg,
      ], { stdio: 'pipe', timeout: Math.max(10 * 60 * 1000, durationSec * 1000 * 0.5) });
      // 用分离结果替换正文
      const diarMd = readFileSync(diarOut, 'utf8');
      const diarBodyStart = diarMd.indexOf('[00:');
      if (diarBodyStart >= 0) {
        body = diarMd.slice(diarBodyStart);
      }
      diarizeNote = '- 说话人分离：sherpa-onnx 嵌入聚类';
      process.stderr.write('说话人分离完成\n');
      rmSync(diarOut, { force: true });
    } catch (e) {
      process.stderr.write(`说话人分离失败: ${e.message}，使用无标注结果\n`);
    }
  }
}

// ---------- 4c. LLM 校对（默认开，--no-polish 跳过） ----------
// 把分离后的正文写回临时文件，跑 polish.py（校对员模式，行数守恒），再读回
const doPolish = !process.argv.includes('--no-polish');
if (doPolish) {
  const polishScript = join(homedir(), 'video-transcribe-skill', 'scripts', 'polish.py');
  if (!existsSync(polishScript)) {
    process.stderr.write('未找到 polish.py，跳过 LLM 校对\n');
  } else {
    process.stderr.write('LLM 校对中…\n');
    const polishIn = join(tmpdir(), `xyz_polish_in_${Date.now()}.md`);
    const polishOut = join(tmpdir(), `xyz_polish_out_${Date.now()}.md`);
    writeFileSync(polishIn, `---\n\n${body}`, 'utf8');
    try {
      execFileSync('python', [
        polishScript, polishIn, polishOut,
        ...(termsArg ? ['--terms', termsArg] : []),
      ], { stdio: 'pipe', timeout: Math.max(10 * 60 * 1000, durationSec * 1000 * 0.5) });
      const polished = readFileSync(polishOut, 'utf8');
      const pStart = polished.indexOf('[00:');
      if (pStart >= 0) {
        body = polished.slice(pStart);
        process.stderr.write('LLM 校对完成\n');
      }
    } catch (e) {
      process.stderr.write(`LLM 校对失败: ${e.message}，使用未校对结果\n`);
    } finally {
      rmSync(polishIn, { force: true });
      rmSync(polishOut, { force: true });
    }
  }
}

// ---------- 4d. 长段拆分（默认开，--no-split 跳过） ----------
const doSplit = !process.argv.includes('--no-split');
if (doSplit) {
  const splitScript = join(homedir(), 'video-transcribe-skill', 'scripts', 'split.py');
  if (!existsSync(splitScript)) {
    process.stderr.write('未找到 split.py，跳过拆分\n');
  } else {
    process.stderr.write('拆分长段中…\n');
    const splitIn = join(tmpdir(), `xyz_split_in_${Date.now()}.md`);
    const splitOut = join(tmpdir(), `xyz_split_out_${Date.now()}.md`);
    writeFileSync(splitIn, `---\n\n${body}`, 'utf8');
    try {
      execFileSync('python', [splitScript, splitIn, splitOut, '--max-len', splitMaxLen],
        { stdio: 'pipe', timeout: 60000 });
      const split = readFileSync(splitOut, 'utf8');
      const sStart = split.indexOf('[00:');
      if (sStart >= 0) {
        body = split.slice(sStart);
        process.stderr.write('拆分完成\n');
      }
    } catch (e) {
      process.stderr.write(`拆分失败: ${e.message}，使用未拆分结果\n`);
    } finally {
      rmSync(splitIn, { force: true });
      rmSync(splitOut, { force: true });
    }
  }
}

// ---------- 4e. 排版：说话人分块（同一说话人连续行紧凑，换人时空行） ----------
{
  const lines = body.split('\n');
  const out = [];
  let prevSpk = null;
  for (const line of lines) {
    const m = line.match(/^\[\d{2}:\d{2}\]\s*说话人([A-Z]):/);
    if (m) {
      const spk = m[1];
      if (prevSpk !== null && spk !== prevSpk) out.push('');
      prevSpk = spk;
      out.push(line);
    } else {
      out.push(line);
    }
  }
  body = out.join('\n');
}

const md = `# ${title}

- 来源：${url}
- 播客：${podcastTitle}
- 时长：${durationStr}
- 转写方式：faster-whisper ${modelArg} 模型本地转写（CPU int8）
${diarizeNote ? diarizeNote + '\n' : ''}- 说明：以下内容为 AI 语音转写，经 LLM 校对（同音错字修正，不增删内容），保留时间戳与发言人，仍可能含少量错误，引用前须人工校对。

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
