import { useCallback, useEffect, useState } from 'react';
import {
  AGENT_ID,
  APP_VERSION,
  BACKEND_MODELS,
  PRESETS,
  decodeHeader,
  downloadBase64,
  downloadBlob,
  extractOutputText,
  findArtifactPaths,
  storageGet,
  storageRemove,
  storageSet
} from './lib';

import ArtifactsView from './components/ArtifactsView';
import ChatSidebar from './components/ChatSidebar';
import GatewayPanel from './components/GatewayPanel';
import LogDashboard from './components/LogDashboard';
import TraceView from './components/TraceView';

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
  const [customModel, setCustomModel] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [tools, setTools] = useState({ code: true, search: true, url: true });
  const [mcp, setMcp] = useState({ name: '', url: '' });
  const [useProxy, setUseProxy] = useState(() => storageGet('antigravity_use_proxy', 'false') === 'true');
  const [proxyUrl, setProxyUrl] = useState(() => storageGet('antigravity_proxy_url', 'http://127.0.0.1:10808'));

  // Default to gateway tab (Module 2 requirement)
  const [tab, setTab] = useState('gateway');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('IDLE');
  const [tokens, setTokens] = useState('0');
  const [output, setOutput] = useState('');
  const [steps, setSteps] = useState([]);
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
  const [gatewayError, setGatewayError] = useState('');

  const selectedBackend = customModel.trim()
    ? customModel.trim()
    : (BACKEND_MODELS.some((m) => m.id === backendModel) ? backendModel : 'gemini-3.7-flash');

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
      }
    }).catch(() => {});
  }, []);

  function saveKey() {
    const value = keyDraft.trim();
    setApiKey(value);
    storageSet('antigravity_gemini_api_key', value);
    setKeyModal(false);
  }

  function attachImage(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      setImage({ mime: file.type, data: dataUrl.split(',')[1], preview: dataUrl, name: file.name });
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
    setTab('trace');
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
    } catch (err) {
      setSessions(previous);
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
      await refreshSessions().catch(() => {});
    } catch (err) {
      setStatus('ERROR');
      setOutput(err.message);
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
    void loadGateway();
  }, [loadGateway]);

  const activeKeysCount = upstreamKeys.filter((k) => k.enabled).length;

  return (
    <div className="app">
      {/* Header with Global Status Bar */}
      <header className="header">
        <div className="brand">
          <div className="logo">A</div>
          <div>
            <h1>
              Antigravity Studio <span className="tag">{AGENT_ID}</span>
              <span className="version-badge">v{APP_VERSION}</span>
            </h1>
            <p>Managed Agent · Remote Sandbox · Protocol Gateway</p>
          </div>
        </div>

        <div className="header-status-bar">
          <div className="status-pill">
            <span className={`dot ${gatewayStatus?.enabled ? 'ok' : 'warn'}`} />
            <span>网关{gatewayStatus?.enabled ? '运行中' : '已关闭'}</span>
          </div>

          <div className="status-pill">
            <span>🔑 {activeKeysCount}/{upstreamKeys.length} 个 Key</span>
          </div>

          <div className="status-pill">
            <span className={`dot ${apiKey ? 'ok' : 'warn'}`} />
            <span>{apiKey ? '沙盒 Key 已就绪' : '未配沙盒 Key'}</span>
          </div>

          <button className="btn btn-sm" onClick={() => { setKeyDraft(apiKey); setKeyModal(true); }}>
            沙盒 Key
          </button>
        </div>
      </header>

      <div className="layout">
        {/* Left: Chat & Gateway Sidebar */}
        <ChatSidebar
          prompt={prompt}
          setPrompt={setPrompt}
          running={running}
          runTask={runTask}
          image={image}
          attachImage={attachImage}
          setImage={setImage}
          envMode={envMode}
          setEnvMode={setEnvMode}
          envId={envId}
          setEnvId={setEnvId}
          freshSession={freshSession}
          setFreshSession={setFreshSession}
          sources={sources}
          setSources={setSources}
          selectedBackend={selectedBackend}
          setBackendModel={setBackendModel}
          customModel={customModel}
          setCustomModel={setCustomModel}
          maxTokens={maxTokens}
          setMaxTokens={setMaxTokens}
          tools={tools}
          setTools={setTools}
          mcp={mcp}
          setMcp={setMcp}
          useProxy={useProxy}
          setUseProxy={setUseProxy}
          proxyUrl={proxyUrl}
          setProxyUrl={setProxyUrl}
          sessions={sessions}
          activeSessionId={activeSessionId}
          setActiveSessionId={setActiveSessionId}
          showTurn={showTurn}
          expanded={expanded}
          setExpanded={setExpanded}
          deleteSession={deleteSession}
          setLastInteractionId={setLastInteractionId}
          setOutput={setOutput}
          setSteps={setSteps}
          adminToken={adminToken}
          setAdminToken={setAdminToken}
          upstreamKeysCount={activeKeysCount}
          loadGateway={loadGateway}
          apiKey={apiKey}
          setKeyModal={setKeyModal}
          setKeyDraft={setKeyDraft}
        />

        {/* Right Workspace Area */}
        <main className="workspace">
          {/* Reordered Tabs: Gateway -> Logs -> Trace -> Artifacts -> Docs */}
          <div className="tabs">
            {[
              ['gateway', '🌐 协议中转'],
              ['logs', '📊 日志控制台'],
              ['trace', '⚡ 沙盒调试'],
              ['artifacts', '📁 文件提取'],
              ['docs', '📖 说明']
            ].map(([id, label]) => (
              <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
            <div className="stats">
              <span>状态 <b className={`badge ${status === 'ERROR' ? 'err' : status === 'RUNNING' ? 'run' : 'ok'}`}>{status}</b></span>
              <span>Tokens {tokens}</span>
              <span className="mono">{envId || 'no env'}</span>
            </div>
          </div>

          <div className="workspace-body">
            {tab === 'gateway' && (
              <GatewayPanel
                adminToken={adminToken}
                setAdminToken={setAdminToken}
                gatewayStatus={gatewayStatus}
                gatewayError={gatewayError}
                setGatewayError={setGatewayError}
                upstreamKeys={upstreamKeys}
                clientTokens={clientTokens}
                usageLogs={usageLogs}
                loadGateway={loadGateway}
                gatewayFetch={gatewayFetch}
                selectedBackend={selectedBackend}
              />
            )}

            {tab === 'logs' && (
              <LogDashboard
                adminToken={adminToken}
                clientTokens={clientTokens}
              />
            )}

            {tab === 'trace' && (
              <TraceView
                output={output}
                steps={steps}
                running={running}
                json={json}
              />
            )}

            {tab === 'artifacts' && (
              <ArtifactsView
                provider={provider}
                setProvider={setProvider}
                forceRefresh={forceRefresh}
                setForceRefresh={setForceRefresh}
                zipWorkspace={zipWorkspace}
                filePath={filePath}
                setFilePath={setFilePath}
                fetchFile={fetchFile}
                fileStatus={fileStatus}
                artifacts={artifacts}
                setTab={setTab}
              />
            )}

            {tab === 'docs' && (
              <section className="box markdown">
                <h3>Antigravity Studio v1.7.0</h3>
                <p>本系统以 <b>协议中转站 (Protocol Gateway)</b> 与 <b>独立日志控制台 (Log Dashboard)</b> 为核心，同时集成 Google Interactions 远程沙盒调试能力。</p>
                <h4>对外模型规范</h4>
                <p>下游客户端 (Cursor / Cline / QQ 机器人 / OpenAI SDK / LangChain 等) 请求时：</p>
                <ul>
                  <li><code>{AGENT_ID}</code> — 默认推理引擎 (gemini-3.7-flash)</li>
                  {BACKEND_MODELS.map((model) => <li key={model.id}><code>{AGENT_ID}/{model.id}</code></li>)}
                  <li><code>自定义模型名称</code> — 支持在客户端直接指定任意 Gemini 模型 (如 gemini-3.1-pro-preview)，网关自动 pass-through</li>
                </ul>
                <h4>高可用与 TPM 避让</h4>
                <p>网关实时维护 60 秒滑动窗口 TPM 用量，当 Key 接近 100k TPM 时自动避让到空闲 Key；遭遇 429 时自动触发上下文平滑迁移，重现对话记忆并无缝切换至新 Key 与沙盒。</p>
              </section>
            )}
          </div>
        </main>
      </div>

      {/* Browser API Key Modal */}
      {keyModal && (
        <div className="modal-backdrop" onClick={() => setKeyModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>沙盒调试 API Key</h3>
            <p className="hint">只用于本 WebUI 面板直接调用沙盒任务，保存在浏览器 localStorage。下游中转站的 Key 请在「协议中转」面板配置到服务端。</p>
            <input className="input mono" type="password" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} placeholder="Gemini API Key" />
            <div className="modal-actions">
              <button className="btn" onClick={() => setKeyModal(false)}>取消</button>
              <button className="btn btn-primary" style={{ width: 'auto' }} onClick={saveKey}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* Error Details Modal */}
      {errorOpen && error && (
        <div className="modal-backdrop" onClick={() => setErrorOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>错误详情</h3>
            <p>{error.err.message}</p>
            <pre className="example">{json(error.err)}</pre>
            <pre className="example">{json(error.request || lastRequest)}</pre>
            <div className="modal-actions">
              <button className="btn" onClick={() => { setErrorOpen(false); setTab('logs'); }}>去日志控制台</button>
              <button className="btn" onClick={() => setErrorOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

