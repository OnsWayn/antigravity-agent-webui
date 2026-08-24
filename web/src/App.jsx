import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AGENT_ID,
  BACKEND_MODELS,
  PRESETS,
  decodeHeader,
  downloadBase64,
  downloadBlob,
  extractOutputText,
  findArtifactPaths,
  renderMarkdown,
  storageGet,
  storageRemove,
  storageSet
} from './lib';

function json(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export default function App() {
  const [apiKey, setApiKey] = useState(() => storageGet('antigravity_gemini_api_key'));
  const [keyModal, setKeyModal] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [prompt, setPrompt] = useState('');
  const [image, setImage] = useState(null);
  const [envMode, setEnvMode] = useState('new');
  const [envId, setEnvId] = useState('');
  const [freshSession, setFreshSession] = useState(false);
  const [sources, setSources] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [lastInteractionId, setLastInteractionId] = useState('');
  const [backendModel, setBackendModel] = useState(() => storageGet('antigravity_selected_model', 'gemini-3.7-flash'));
  const [maxTokens, setMaxTokens] = useState('');
  const [tools, setTools] = useState({ code: true, search: true, url: true });
  const [mcp, setMcp] = useState({ name: '', url: '' });
  const [useProxy, setUseProxy] = useState(() => storageGet('antigravity_use_proxy', 'false') === 'true');
  const [proxyUrl, setProxyUrl] = useState(() => storageGet('antigravity_proxy_url', 'http://127.0.0.1:10808'));
  const [tab, setTab] = useState('trace');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('IDLE');
  const [tokens, setTokens] = useState('0');
  const [output, setOutput] = useState('');
  const [steps, setSteps] = useState([]);
  const [logs, setLogs] = useState([{ level: 'info', message: `已就绪。Agent：${AGENT_ID}` }]);
  const [artifacts, setArtifacts] = useState([]);
  const [filePath, setFilePath] = useState('/workspace/report.pdf');
  const [provider, setProvider] = useState('snapshot');
  const [forceRefresh, setForceRefresh] = useState(false);
  const [fileStatus, setFileStatus] = useState(null);
  const [error, setError] = useState(null);
  const [errorOpen, setErrorOpen] = useState(false);
  const [lastRequest, setLastRequest] = useState(null);

  const [adminToken, setAdminToken] = useState(() => storageGet('antigravity_gateway_admin_token'));
  const [gatewayStatus, setGatewayStatus] = useState(null);
  const [upstreamKeys, setUpstreamKeys] = useState([]);
  const [clientTokens, setClientTokens] = useState([]);
  const [usageLogs, setUsageLogs] = useState([]);
  const [keyName, setKeyName] = useState('默认 Key');
  const [keyValue, setKeyValue] = useState('');
  const [tokenName, setTokenName] = useState('下游客户端');
  const [quota, setQuota] = useState('-1');
  const [rpm, setRpm] = useState('');
  const [createdSecret, setCreatedSecret] = useState('');
  const [gatewayError, setGatewayError] = useState('');

  const activeEnv = envId || '';
  const selectedBackend = BACKEND_MODELS.some((m) => m.id === backendModel) ? backendModel : 'gemini-3.7-flash';

  const log = useCallback((level, message, details) => {
    setLogs((prev) => [...prev.slice(-400), { level, message, details, at: new Date().toLocaleTimeString() }]);
  }, []);

  const proxySettings = () => ({ useProxy, proxyUrl: proxyUrl.trim() });

  async function refreshSessions(imported = []) {
    if (imported.length) {
      const response = await fetch('/api/sessions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessions: imported })
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || '旧会话迁移失败');
    }
    const response = await fetch('/api/sessions', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error?.message || '读取会话失败');
    setSessions(result.sessions || []);
  }

  useEffect(() => {
    let legacy = [];
    try {
      const raw = storageGet('antigravity_sessions', '');
      legacy = raw ? JSON.parse(raw) : [];
    } catch { legacy = []; }
    refreshSessions(legacy).then(() => {
      if (legacy.length) {
        storageRemove('antigravity_sessions');
        log('success', `已将 ${legacy.length} 个浏览器历史会话迁移至 SQLite`);
      }
    }).catch((err) => log('warn', `数据库暂时不可用: ${err.message}`));
  }, [log]);

  function saveKey() {
    const value = keyDraft.trim();
    setApiKey(value);
    storageSet('antigravity_gemini_api_key', value);
    setKeyModal(false);
    log('info', 'API Key 已保存到浏览器 localStorage');
  }

  function attachImage(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      setImage({ mime: file.type, data: dataUrl.split(',')[1], preview: dataUrl, name: file.name });
      log('info', `已加载图片 ${file.name || 'clipboard'} (${(file.size / 1024).toFixed(1)} KB)`);
    };
    reader.readAsDataURL(file);
  }

  function showTurn(session, turn) {
    setActiveSessionId(session.id);
    setEnvMode('reuse');
    setEnvId(session.envId);
    setFreshSession(false);
    setLastInteractionId(turn?.interactionId || session.lastInteractionId || '');
    const text = turn?.outputText || session.lastOutput || '';
    setOutput(text);
    setSteps(turn?.steps || session.steps || []);
    setArtifacts(findArtifactPaths(text));
    setStatus((turn?.status || 'VIEW').toUpperCase());
  }

  async function deleteSession(sessionId) {
    const previous = sessions;
    setSessions((list) => list.filter((item) => item.id !== sessionId));
    if (activeSessionId === sessionId) {
      setActiveSessionId(null);
      setEnvMode('new');
      setEnvId('');
      setLastInteractionId('');
      setOutput('');
      setSteps([]);
    }
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || '删除失败');
      log('info', `已删除会话 ${sessionId}`);
    } catch (err) {
      setSessions(previous);
      log('error', err.message);
    }
  }

  function builtTools() {
    const list = [];
    if (tools.code) list.push({ type: 'code_execution' });
    if (tools.search) list.push({ type: 'google_search' });
    if (tools.url) list.push({ type: 'url_context' });
    if (mcp.name.trim() && mcp.url.trim()) {
      list.push({ type: 'mcp_server', name: mcp.name.trim().toLowerCase(), url: mcp.url.trim() });
    }
    return list;
  }

  async function runTask() {
    if (!apiKey) {
      setKeyDraft(apiKey);
      setKeyModal(true);
      return;
    }
    if (!prompt.trim()) return;
    const input = image
      ? [{ type: 'text', text: prompt.trim() }, { type: 'image', mime_type: image.mime, data: image.data }]
      : prompt.trim();

    let environment = 'remote';
    let previousInteractionId;
    let localSessionId;
    let startNewSession = envMode === 'new';
    if (envMode === 'reuse') {
      const target = envId.trim();
      if (target) {
        environment = target;
        startNewSession = freshSession;
        if (!startNewSession) {
          const active = sessions.find((item) => item.id === activeSessionId && item.envId === target);
          const fallback = active || sessions.find((item) => item.envId === target);
          localSessionId = fallback?.id || activeSessionId || undefined;
          previousInteractionId = fallback?.lastInteractionId || lastInteractionId || undefined;
        }
      }
    } else {
      const filled = sources.filter((item) => item.target.trim() && item.content);
      if (filled.length) {
        environment = { type: 'remote', sources: filled.map((item) => ({ type: 'inline', target: item.target, content: item.content })) };
      }
    }

    const requestBody = {
      agent: AGENT_ID,
      input,
      environment,
      model: selectedBackend,
      maxTotalTokens: maxTokens ? Number(maxTokens) : undefined,
      tools: builtTools().length ? builtTools() : undefined,
      previousInteractionId,
      localSessionId,
      startNewSession,
      ...proxySettings()
    };
    setLastRequest(requestBody);
    setRunning(true);
    setStatus('RUNNING');
    setTab('trace');
    log('info', 'POST /api/interactions/create', requestBody);
    try {
      const response = await fetch('/api/interactions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(requestBody)
      });
      const resJson = await response.json();
      if (!response.ok || !resJson.success) {
        const errObj = resJson.error || { message: `HTTP ${response.status}` };
        setError({ err: errObj, request: requestBody });
        setErrorOpen(true);
        throw new Error(errObj.message || '任务失败');
      }
      const data = resJson.data;
      const text = extractOutputText(data);
      setPrompt('');
      setLastInteractionId(data.id || '');
      const nextEnv = data.environment_id || envId;
      setEnvId(nextEnv);
      setEnvMode('reuse');
      setFreshSession(false);
      setActiveSessionId(resJson.sessionId || data.local_session_id || activeSessionId);
      setOutput(text);
      setSteps(data.steps || []);
      setArtifacts(findArtifactPaths(text));
      setStatus((data.status || 'completed').toUpperCase());
      if (data.usage) setTokens(`${data.usage.total_tokens || 0}`);
      log('success', '任务完成', { id: data.id, environment_id: data.environment_id, usage: data.usage });
      await refreshSessions().catch((err) => log('warn', err.message));
    } catch (err) {
      setStatus('ERROR');
      setOutput(err.message);
      log('error', err.message);
    } finally {
      setRunning(false);
    }
  }

  async function fetchFile(path = filePath) {
    if (!path.trim() || !envId) {
      setFileStatus({ error: '需要文件路径和 Environment ID' });
      return;
    }
    setFileStatus({ pending: `正在通过 ${provider} 提取 ${path}` });
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
    if (provider === 'snapshot') headers.Accept = 'application/octet-stream';
    try {
      const res = await fetch('/api/interactions/fetch-file', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          apiKey,
          environmentId: envId,
          previousInteractionId: lastInteractionId || undefined,
          filePath: path,
          provider,
          forceRefresh: provider === 'snapshot' && forceRefresh,
          ...proxySettings()
        })
      });
      if (provider === 'snapshot' && res.ok && res.headers.get('content-type')?.includes('application/octet-stream')) {
        const blob = await res.blob();
        const filename = decodeHeader(res.headers.get('x-file-name')) || path.split('/').pop();
        const archivePath = decodeHeader(res.headers.get('x-archive-path'));
        setFileStatus({
          ok: true,
          filename,
          archivePath,
          cache: res.headers.get('x-snapshot-cache') || 'MISS',
          onDownload: () => downloadBlob(blob, filename)
        });
        setForceRefresh(false);
        return;
      }
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.success) {
        throw new Error(result.error?.message || '提取失败');
      }
      if (result.downloadUrl) {
        setFileStatus({ ok: true, filename: result.filename, url: result.downloadUrl });
      } else if (result.base64Data) {
        setFileStatus({
          ok: true,
          filename: result.filename,
          onDownload: () => downloadBase64(result.base64Data, result.filename)
        });
      }
    } catch (err) {
      setFileStatus({ error: err.message });
    }
  }

  async function zipWorkspace() {
    if (!envId || !apiKey) return;
    setFilePath('/tmp/workspace_project.zip');
    setFileStatus({ pending: '正在打包 /workspace ...' });
    try {
      const response = await fetch('/api/interactions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          agent: AGENT_ID,
          input: 'You must use the code_execution tool now. Execute exactly: cd /workspace && python3 -c "import shutil; shutil.make_archive(\'/tmp/workspace_project\', \'zip\', \'/workspace\')". Then execute: test -s /tmp/workspace_project.zip && ls -lh /tmp/workspace_project.zip.',
          environment: envId,
          model: selectedBackend,
          tools: [{ type: 'code_execution' }],
          previousInteractionId: lastInteractionId || undefined,
          localSessionId: activeSessionId || undefined,
          startNewSession: false,
          ...proxySettings()
        })
      });
      const resData = await response.json();
      if (!response.ok || !resData.success) throw new Error(resData.error?.message || '打包失败');
      if (resData.data?.id) setLastInteractionId(resData.data.id);
      await fetchFile('/tmp/workspace_project.zip');
    } catch (err) {
      setFileStatus({ error: err.message });
    }
  }

  async function gatewayFetch(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error?.message || `HTTP ${response.status}`);
    }
    return data;
  }

  const loadGateway = useCallback(async () => {
    setGatewayError('');
    try {
      const statusRes = await fetch('/api/gateway/status').then((res) => res.json());
      setGatewayStatus(statusRes);
    } catch (err) {
      setGatewayError(err.message);
      return;
    }
    try {
      const [keys, tokensRes, usage] = await Promise.all([
        gatewayFetch('/api/gateway/keys'),
        gatewayFetch('/api/gateway/tokens'),
        gatewayFetch('/api/gateway/usage?limit=20')
      ]);
      setUpstreamKeys(keys.keys || []);
      setClientTokens(tokensRes.tokens || []);
      setUsageLogs(usage.logs || []);
    } catch (err) {
      setGatewayError(err.message);
    }
  }, [adminToken]);

  useEffect(() => {
    if (tab === 'gateway') void loadGateway();
  }, [tab, loadGateway]);

  const example = useMemo(() => {
    const origin = window.location.origin;
    const model = `${AGENT_ID}/${selectedBackend}`;
    return `# 对外模型 ID 是 Antigravity Agent，不是 API Key 目录里的普通 Gemini
# ${AGENT_ID}
# ${model}

curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ag-你的下游Token" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"ping"}]}'

curl ${origin}/v1/responses \\
  -H "Authorization: Bearer ag-你的下游Token" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${AGENT_ID}","input":"ping"}'

curl ${origin}/v1beta/models/${encodeURIComponent(model)}:generateContent \\
  -H "Authorization: Bearer ag-你的下游Token" \\
  -H "Content-Type: application/json" \\
  -d '{"contents":[{"role":"user","parts":[{"text":"ping"}]}]}'`;
  }, [selectedBackend]);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="logo">A</div>
          <div>
            <h1>Antigravity Studio <span className="tag">{AGENT_ID}</span></h1>
            <p>Managed Agent · Remote Sandbox · Protocol Gateway</p>
          </div>
        </div>
        <div className="header-actions">
          <span className="key-status">
            <span className={`dot ${apiKey ? 'ok' : 'warn'}`} />
            {apiKey ? 'Key 已就绪' : '未配置 Key'}
          </span>
          <button className="btn btn-sm" onClick={() => { setKeyDraft(apiKey); setKeyModal(true); }}>配置 API Key</button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <section className="card primary">
            <h2>代理任务</h2>
            <div className="pills">
              <button className="pill" onClick={() => setPrompt(PRESETS.news)}>新闻 PDF</button>
              <button className="pill" onClick={() => setPrompt(PRESETS.data)}>CSV 图表</button>
              <button className="pill" onClick={() => setPrompt(PRESETS.code)}>Python/Node 服务</button>
            </div>
            <textarea
              className="textarea"
              value={prompt}
              placeholder="描述要在远程沙盒中执行的任务，可 Ctrl+V 粘贴截图"
              onChange={(e) => setPrompt(e.target.value)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) attachImage(file);
              }}
              onPaste={(e) => {
                const item = [...(e.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
                if (item) {
                  e.preventDefault();
                  attachImage(item.getAsFile());
                }
              }}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <label className="btn btn-sm">
                添加图片
                <input type="file" accept="image/*" hidden onChange={(e) => attachImage(e.target.files?.[0])} />
              </label>
              {image && <button className="btn btn-sm btn-danger" onClick={() => setImage(null)}>移除图片</button>}
            </div>
            {image && <div className="preview"><img src={image.preview} alt="" /></div>}

            <div style={{ marginTop: 12 }}>
              <span className="label">环境</span>
              <label className="radio"><input type="radio" checked={envMode === 'new'} onChange={() => setEnvMode('new')} /> 新建沙盒</label>
              <label className="radio"><input type="radio" checked={envMode === 'reuse'} onChange={() => setEnvMode('reuse')} /> 复用 Environment ID</label>
              {envMode === 'reuse' && (
                <>
                  <div className="row">
                    <input className="input mono grow" value={envId} onChange={(e) => setEnvId(e.target.value)} placeholder="environment id" />
                    <button className="btn btn-sm" onClick={() => envId && navigator.clipboard.writeText(envId)}>复制</button>
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={freshSession} onChange={(e) => setFreshSession(e.target.checked)} />
                    <span>共享沙盒文件，但不继承对话上下文</span>
                  </label>
                </>
              )}
              {envMode === 'new' && (
                <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setSources((list) => [...list, { target: '', content: '' }])}>+ 注入预置文件</button>
              )}
              {sources.map((source, index) => (
                <div key={index} className="box" style={{ marginTop: 8 }}>
                  <input className="input mono" placeholder="/workspace/data.txt" value={source.target} onChange={(e) => setSources((list) => list.map((item, i) => i === index ? { ...item, target: e.target.value } : item))} />
                  <textarea className="textarea" style={{ minHeight: 56, marginTop: 6 }} value={source.content} onChange={(e) => setSources((list) => list.map((item, i) => i === index ? { ...item, content: e.target.value } : item))} />
                  <button className="btn btn-sm btn-danger" onClick={() => setSources((list) => list.filter((_, i) => i !== index))}>移除</button>
                </div>
              ))}
            </div>
            <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={running} onClick={runTask}>
              {running ? '执行中…' : '提交代理任务'}
            </button>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 style={{ margin: 0 }}>会话</h2>
              <span>
                <button className="btn btn-sm btn-ghost" disabled={!envId} onClick={() => { setActiveSessionId(null); setLastInteractionId(''); setFreshSession(true); setEnvMode('reuse'); setOutput(''); setSteps([]); }}>当前沙盒新会话</button>
                <button className="btn btn-sm btn-ghost" onClick={() => { setActiveSessionId(null); setEnvMode('new'); setEnvId(''); setLastInteractionId(''); setOutput(''); setSteps([]); setFreshSession(false); }}>新沙盒</button>
              </span>
            </div>
            <div className="sessions">
              {sessions.length === 0 && <div className="hint">还没有会话。提交任务后会出现在这里。</div>}
              {sessions.map((session) => {
                const turns = session.turns?.length ? session.turns : [{ interactionId: session.lastInteractionId, prompt: session.lastPrompt, outputText: session.lastOutput, steps: session.steps }];
                const open = expanded.has(session.id);
                return (
                  <div key={session.id} className={`session ${activeSessionId === session.id ? 'active' : ''}`}>
                    <div className="session-top" onClick={() => showTurn(session, turns[turns.length - 1])}>
                      <div>
                        <button className="btn-ghost" onClick={(e) => { e.stopPropagation(); setExpanded((set) => { const next = new Set(set); next.has(session.id) ? next.delete(session.id) : next.add(session.id); return next; }); }}>{open ? '▾' : '▸'}</button>
                        <div className="session-title">{session.name || session.envId}</div>
                        <div className="session-env mono">{session.envId}</div>
                      </div>
                      <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }}>删除</button>
                    </div>
                    {open && (
                      <div className="turns">
                        {turns.map((turn, index) => (
                          <div key={turn.interactionId || index} className={`turn ${lastInteractionId === turn.interactionId ? 'active' : ''}`} onClick={() => showTurn(session, turn)}>
                            #{index + 1} {(turn.prompt || '').slice(0, 48)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card">
            <h2>Antigravity 内部模型</h2>
            <p className="hint">这里选的是 `{AGENT_ID}` 的 `agent_config.model`，不是 API Key 名下的普通 Gemini 对话模型。</p>
            <select className="select" value={selectedBackend} onChange={(e) => { setBackendModel(e.target.value); storageSet('antigravity_selected_model', e.target.value); }}>
              {BACKEND_MODELS.map((model) => (
                <option key={model.id} value={model.id}>{model.label} — {model.hint}</option>
              ))}
            </select>
            <div className="hint mono" style={{ marginTop: 8 }}>网关对外 ID：{AGENT_ID}/{selectedBackend}</div>
            <label className="label" style={{ marginTop: 10 }}>max_total_tokens</label>
            <input className="input" type="number" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="留空不限制" />
          </section>

          <section className="card">
            <h2>工具</h2>
            <label className="check"><input type="checkbox" checked={tools.code} onChange={(e) => setTools((t) => ({ ...t, code: e.target.checked }))} /><span>Code Execution<small>远程沙盒里跑命令</small></span></label>
            <label className="check"><input type="checkbox" checked={tools.search} onChange={(e) => setTools((t) => ({ ...t, search: e.target.checked }))} /><span>Google Search<small>检索公开网页</small></span></label>
            <label className="check"><input type="checkbox" checked={tools.url} onChange={(e) => setTools((t) => ({ ...t, url: e.target.checked }))} /><span>URL Context<small>抓取指定 URL</small></span></label>
            <label className="label" style={{ marginTop: 8 }}>远程 MCP（Streamable HTTP）</label>
            <input className="input mono" placeholder="name" value={mcp.name} onChange={(e) => setMcp((m) => ({ ...m, name: e.target.value }))} />
            <input className="input mono" style={{ marginTop: 6 }} placeholder="https://example.com/mcp" value={mcp.url} onChange={(e) => setMcp((m) => ({ ...m, url: e.target.value }))} />
          </section>

          <section className="card">
            <h2>网络代理</h2>
            <label className="check">
              <input type="checkbox" checked={useProxy} onChange={(e) => { setUseProxy(e.target.checked); storageSet('antigravity_use_proxy', e.target.checked); }} />
              <span>启用 HTTP/HTTPS 代理</span>
            </label>
            {useProxy && (
              <input className="input mono" value={proxyUrl} onChange={(e) => { setProxyUrl(e.target.value); storageSet('antigravity_proxy_url', e.target.value); }} />
            )}
          </section>
        </aside>

        <main className="workspace">
          <div className="tabs">
            {[
              ['trace', '执行轨迹'],
              ['artifacts', '沙盒文件'],
              ['logs', '调试日志'],
              ['gateway', '协议中转站'],
              ['docs', '说明']
            ].map(([id, label]) => (
              <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
            ))}
            <div className="stats">
              <span>状态 <b className={`badge ${status === 'ERROR' ? 'err' : status === 'RUNNING' ? 'run' : 'ok'}`}>{status}</b></span>
              <span>Tokens {tokens}</span>
              <span className="mono">{envId || 'no env'}</span>
            </div>
          </div>

          <div className="workspace-body">
            {tab === 'trace' && (
              !output && !running ? (
                <div className="empty">
                  <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.3 }}>🚀</div>
                  <h3>等待任务</h3>
                  <p>在左侧输入任务描述并提交，Agent 将在 Google 远程 Linux 沙盒中执行。执行轨迹和最终输出会显示在这里。</p>
                </div>
              ) : (
                <>
                  <section className="output">
                    <div className="output-head">
                      <span>📄 最终输出</span>
                      <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(output || '')}>复制</button>
                    </div>
                    {running && !output && <p className="hint" style={{ textAlign: 'center', padding: 20 }}>⏳ Agent 正在远程沙盒中执行…</p>}
                    <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(output) }} />
                  </section>
                  <section className="box">
                    <div className="box-head">⚡ 执行步骤</div>
                    {(steps || []).map((step, index) => (
                      <div className="step" key={step.id || index}>
                        <div className="step-h">#{index + 1} {step.type || 'step'}</div>
                        <pre className="step-body">{json(step)}</pre>
                      </div>
                    ))}
                  </section>
                </>
              )
            )}

            {tab === 'artifacts' && (
              <>
                <section className="box">
                  <div className="box-head">📦 打包整个 /workspace</div>
                  <select className="select" value={provider} onChange={(e) => setProvider(e.target.value)}>
                    <option value="snapshot">官方环境快照</option>
                    <option value="chunked">Base64 分块</option>
                    <option value="fileio">file.io</option>
                    <option value="catbox">catbox</option>
                  </select>
                  <label className="check"><input type="checkbox" checked={forceRefresh} onChange={(e) => setForceRefresh(e.target.checked)} /><span>强制刷新快照</span></label>
                  <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={zipWorkspace}>打包并下载</button>
                </section>
                <section className="box">
                  <div className="box-head">📁 按路径提取</div>
                  <div className="row">
                    <input className="input mono grow" value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="/workspace/file.svg" />
                    <button className="btn" onClick={() => fetchFile()}>提取</button>
                  </div>
                  {fileStatus?.pending && <p className="hint">{fileStatus.pending}</p>}
                  {fileStatus?.error && <p className="status-bad">{fileStatus.error}</p>}
                  {fileStatus?.ok && (
                    <div style={{ marginTop: 8 }}>
                      <p className="status-ok">已提取 {fileStatus.filename} {fileStatus.cache ? `(缓存 ${fileStatus.cache})` : ''}</p>
                      {fileStatus.archivePath && <p className="hint mono">{fileStatus.archivePath}</p>}
                      {fileStatus.url && <a className="btn btn-sm" href={fileStatus.url} target="_blank" rel="noreferrer">打开直链</a>}
                      {fileStatus.onDownload && <button className="btn btn-sm" onClick={fileStatus.onDownload}>保存本地</button>}
                    </div>
                  )}
                </section>
                <section className="box">
                  <div className="box-head">🔍 输出中检测到的路径</div>
                  {artifacts.length === 0 && <p className="hint">还没有检测到 /workspace 文件。</p>}
                  {artifacts.map((path) => (
                    <div className="gateway-row" key={path}>
                      <span className="mono">{path}</span>
                      <button className="btn btn-sm" onClick={() => { setFilePath(path); setTab('artifacts'); fetchFile(path); }}>提取</button>
                    </div>
                  ))}
                </section>
              </>
            )}

            {tab === 'logs' && (
              <section className="box">
                <div className="box-head">
                  <span>🔧 调试日志</span>
                  <span>
                    <button className="btn btn-sm" onClick={() => setLogs([])}>清空</button>
                    <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(logs.map((item) => `[${item.at}] ${item.message}`).join('\n'))}>复制</button>
                  </span>
                </div>
                <div className="logs">
                  {logs.map((item, index) => (
                    <div className={`log ${item.level}`} key={index}>
                      [{item.at || ''}] [{item.level}] {item.message}
                      {item.details && <pre>{json(item.details)}</pre>}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {tab === 'gateway' && (
              <>
                <section className="box">
                  <div className="box-head">🌐 中转站</div>
                  <p className="hint">下游客户端应请求 <b>{AGENT_ID}</b> 或其内部模型 <b>{AGENT_ID}/gemini-…</b>。不要把它当成 Key 目录里的普通 Gemini。</p>
                  {gatewayStatus && (
                    <p className={gatewayStatus.configured ? 'status-ok' : 'status-bad'}>
                      网关{gatewayStatus.enabled ? '已启用' : '已关闭'} · MASTER_KEY {gatewayStatus.configured ? '已配置' : '未配置'} · 管理 Token {gatewayStatus.adminConfigured ? '已配置' : '未配置'}
                    </p>
                  )}
                  <label className="label">GATEWAY_ADMIN_TOKEN</label>
                  <div className="row">
                    <input className="input mono grow" type="password" value={adminToken} onChange={(e) => { setAdminToken(e.target.value); storageSet('antigravity_gateway_admin_token', e.target.value); }} />
                    <button className="btn" onClick={loadGateway}>刷新</button>
                  </div>
                  {gatewayError && <p className="status-bad">{gatewayError}</p>}
                </section>
                <section className="box">
                  <div className="box-head">🔑 上游 Gemini Key</div>
                  <div className="row">
                    <input className="input grow" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="名称" />
                    <input className="input mono grow" type="password" value={keyValue} onChange={(e) => setKeyValue(e.target.value)} placeholder="真实 Gemini Key" />
                    <button className="btn" onClick={async () => {
                      try {
                        await gatewayFetch('/api/gateway/keys', { method: 'POST', body: JSON.stringify({ name: keyName, apiKey: keyValue }) });
                        setKeyValue('');
                        loadGateway();
                      } catch (err) { setGatewayError(err.message); }
                    }}>保存</button>
                  </div>
                  {upstreamKeys.map((item) => (
                    <div className="gateway-row" key={item.id}>
                      <div><b>{item.name}</b><div className="hint mono">…{item.suffix} {item.enabled ? '启用' : '停用'}</div></div>
                      <span>
                        <button className="btn btn-sm" onClick={async () => { await gatewayFetch(`/api/gateway/keys/${item.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !item.enabled }) }); loadGateway(); }}>{item.enabled ? '停用' : '启用'}</button>
                        <button className="btn btn-sm btn-danger" onClick={async () => { await gatewayFetch(`/api/gateway/keys/${item.id}`, { method: 'DELETE' }); loadGateway(); }}>删除</button>
                      </span>
                    </div>
                  ))}
                </section>
                <section className="box">
                  <div className="box-head">🎫 下游 Token</div>
                  <div className="row">
                    <input className="input grow" value={tokenName} onChange={(e) => setTokenName(e.target.value)} />
                    <input className="input" style={{ width: 120 }} value={quota} onChange={(e) => setQuota(e.target.value)} placeholder="额度" />
                    <input className="input" style={{ width: 90 }} value={rpm} onChange={(e) => setRpm(e.target.value)} placeholder="RPM" />
                    <button className="btn" onClick={async () => {
                      try {
                        const result = await gatewayFetch('/api/gateway/tokens', { method: 'POST', body: JSON.stringify({ name: tokenName, quotaTokens: Number(quota), rpm: rpm ? Number(rpm) : undefined }) });
                        setCreatedSecret(result.secret);
                        loadGateway();
                      } catch (err) { setGatewayError(err.message); }
                    }}>创建</button>
                  </div>
                  {createdSecret && <p className="status-ok mono">只显示一次：{createdSecret}</p>}
                  {clientTokens.map((item) => (
                    <div className="gateway-row" key={item.id}>
                      <div><b>{item.name}</b><div className="hint mono">{item.tokenPrefix}… {item.usedTokens}/{item.quotaTokens < 0 ? '∞' : item.quotaTokens}</div></div>
                      <span>
                        <button className="btn btn-sm" onClick={async () => { await gatewayFetch(`/api/gateway/tokens/${item.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !item.enabled }) }); loadGateway(); }}>{item.enabled ? '停用' : '启用'}</button>
                        <button className="btn btn-sm btn-danger" onClick={async () => { await gatewayFetch(`/api/gateway/tokens/${item.id}`, { method: 'DELETE' }); loadGateway(); }}>撤销</button>
                      </span>
                    </div>
                  ))}
                </section>
                <section className="box">
                  <div className="box-head">💻 调用示例</div>
                  <pre className="example">{example}</pre>
                </section>
                <section className="box">
                  <div className="box-head">📊 用量</div>
                  {usageLogs.map((item) => (
                    <div className="gateway-row" key={item.id}>
                      <span className="mono">{item.endpoint} {item.model} tokens={item.total_tokens ?? 0}</span>
                      <span className="hint">{item.created_at ? new Date(item.created_at).toLocaleString() : ''}</span>
                    </div>
                  ))}
                </section>
              </>
            )}

            {tab === 'docs' && (
              <section className="box markdown">
                <h3>模型身份</h3>
                <p>本控制台和中转站都只跑 <code>{AGENT_ID}</code>。下拉里的 Gemini 名称是 Agent 的 <code>agent_config.model</code>，用来选沙盒里的推理引擎，不是把请求打到该 Key 的普通 <code>generateContent</code> Gemini 模型目录。</p>
                <p>中转站对外模型 ID：</p>
                <ul>
                  <li><code>{AGENT_ID}</code> — 默认内部模型 gemini-3.7-flash</li>
                  {BACKEND_MODELS.map((model) => <li key={model.id}><code>{AGENT_ID}/{model.id}</code></li>)}
                </ul>
                <h3>沙盒</h3>
                <p>文件和命令都在 Google 托管的远程 Linux 中。Cursor 等客户端连网关后，改的是 <code>/workspace</code>，不是你的本机仓库。</p>
              </section>
            )}
          </div>
        </main>
      </div>

      {keyModal && (
        <div className="modal-backdrop" onClick={() => setKeyModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>浏览器 API Key</h3>
            <p className="hint">只用于本 WebUI 直接调 `/api/interactions/create`，存在 localStorage。中转站请把 Key 配到服务端上游。</p>
            <input className="input mono" type="password" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} placeholder="Gemini API Key" />
            <div className="modal-actions">
              <button className="btn" onClick={() => setKeyModal(false)}>取消</button>
              <button className="btn btn-primary" style={{ width: 'auto' }} onClick={saveKey}>保存</button>
            </div>
          </div>
        </div>
      )}

      {errorOpen && error && (
        <div className="modal-backdrop" onClick={() => setErrorOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>错误详情</h3>
            <p>{error.err.message}</p>
            <pre className="example">{json(error.err)}</pre>
            <pre className="example">{json(error.request || lastRequest)}</pre>
            <div className="modal-actions">
              <button className="btn" onClick={() => { setErrorOpen(false); setTab('logs'); }}>去看日志</button>
              <button className="btn" onClick={() => setErrorOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
