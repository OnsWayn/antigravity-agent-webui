import { marked } from 'marked';
import DOMPurify from 'dompurify';

export const AGENT_ID = 'antigravity-preview-05-2026';
export const APP_VERSION = '1.7.0';

export const BACKEND_MODELS = [
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', hint: '默认 · 推理 / 编码 / 工具' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', hint: '上一代 Flash' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', hint: '轻量工作流' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', hint: '低成本 / 低延迟' }
];

export const PRESETS = {
  news: '请在远程 Linux 沙盒中检索最新的 Hacker News 或 Google News AI 科技要闻，总结前 10 条热门资讯，并在 /workspace 目录中生成一份格式排版精美的 PDF 报告文件 (如 /workspace/ai_news_summary.pdf)。',
  data: '请在沙盒中编写 Python 脚本，创建一个包含 100 条模拟销售数据的 Pandas DataFrame，计算平均值与月度趋势，使用 Matplotlib / Seaborn 绘制柱状图保存至 /workspace/sales_chart.png，并将分析结论写入 /workspace/report.txt。',
  code: '请在沙盒中建立一个轻量级 Node.js Express 后端框架项目（位于 /workspace/my_server 目录），安装 express 依赖并编写 index.js 提供一个 GET /api/health 接口，最后运行 `node -v` 和 `npm -v` 验证沙盒环境。'
};

export function storageGet(key, fallback = '') {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMarkdown(text) {
  if (!text) return '';
  try {
    return DOMPurify.sanitize(marked.parse(text));
  } catch {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }
}

export function extractOutputText(data) {
  if (data?.output_text && String(data.output_text).trim()) return data.output_text;
  const textParts = [];
  for (const step of data?.steps || []) {
    if (step.type !== 'model_output' && step.type !== 'output') continue;
    if (Array.isArray(step.content)) {
      for (const item of step.content) {
        if (item?.type === 'text' && item.text) textParts.push(item.text);
        else if (typeof item === 'string') textParts.push(item);
      }
    } else if (typeof step.content === 'string') {
      textParts.push(step.content);
    } else if (step.text) {
      textParts.push(step.text);
    }
  }
  return textParts.join('\n\n') || '';
}

export function findArtifactPaths(text) {
  if (!text) return [];
  return Array.from(new Set(text.match(/\/workspace\/[A-Za-z0-9_\-./]+\.[A-Za-z0-9]+/g) || []));
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadBase64(base64Data, filename) {
  const link = document.createElement('a');
  link.href = `data:application/octet-stream;base64,${base64Data}`;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function decodeHeader(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function gatewayModelId(backend) {
  return `${AGENT_ID}/${backend}`;
}

export function copyText(text) {
  if (!text) return Promise.resolve();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } catch {}
  document.body.removeChild(textarea);
  return Promise.resolve();
}

export function formatDate(timestamp) {
  if (!timestamp) return '-';
  const d = new Date(Number(timestamp));
  if (Number.isNaN(d.getTime())) return String(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  const Y = d.getFullYear();
  const M = pad(d.getMonth() + 1);
  const D = pad(d.getDate());
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

export function formatTokens(num) {
  if (num == null || !Number.isFinite(Number(num))) return '-';
  return Number(num).toLocaleString();
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function safeJson(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
