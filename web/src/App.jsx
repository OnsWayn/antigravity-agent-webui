import { useCallback, useEffect, useState } from 'react';
import {
  AGENT_ID,
  APP_VERSION,
  BACKEND_MODELS,
  decodeHeader,
  downloadBase64,
  downloadBlob,
  extractOutputText,
  findArtifactPaths,
  pageFromHash,
  pageHash,
  readFileAsSource,
  storageGet,
  storageRemove,
  storageSet
} from './lib';

import AppNav from './components/AppNav';
import ArtifactsView from './components/ArtifactsView';
import DashboardView from './components/DashboardView';
import GatewayPanel from './components/GatewayPanel';
import LogDashboard from './components/LogDashboard';
import SandboxComposer from './components/SandboxComposer';
import TraceView from './components/TraceView';

function json(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export default function App() {
  const [page, setPage] = useState(() => (typeof window === 'undefined' ? 'dashboard' : pageFromHash()));
  const [navOpen, setNavOpen] = useState(false);
  const [sandboxKeyId, setSandboxKeyId] = useState(() => storageGet('antigravity_sandbox_key_id'));
  const [prompt, setPrompt] = useState('');
  const [image, setImage] = useState(null);
  const [files, setFiles] = useState([]);
  const [envMode, setEnvMode] = useState('new');
  const [envId, setEnvId] = useState('');
  const [freshSession, setFreshSession] = useState(false);
  const [sources, setSources] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [lastInteractionId, setLastInteractionId] = useState('');
  const [backendModel, setBackendModel] = useState(() => storageGet('antigravity_selected_model', 'auto'));
  const [customModel, setCustomModel] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [tools, setTools] = useState({ code: true, search: true, url: true });
  const [mcp, setMcp] = useState({ name: '', url: '' });
  const [useProxy, setUseProxy] = useState(() => storageGet('antigravity_use_proxy', 'false') === 'true');
  const [proxyUrl, setProxyUrl] = useState(() => storageGet('antigravity_proxy_url', 'http://127.0.0.1:10808'));

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
  const [gatewayError, setGatewayError] = useState('');
  const [gatewaySettings, setGatewaySettings] = useState(null);

  const selectedBackend = customModel.trim()
    ? customModel.trim()
    : (BACKEND_MODELS.some((m) => m.id === backendModel) ? backendModel : 'auto');

  useEffect(() => {
    function onHash() {
      setPage(pageFromHash());
    }
    window.addEventListener('hashchange', onHash);
    if (!window.location.hash) window.location.hash = pageHash(pageFromHash());
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function go(id) {
    setPage(id);
    window.location.hash = pageHash(id);
    setNavOpen(false);
  }

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
      if (legacy.length) storageRemove('antigravity_sessions');
    }).catch(() => {});
  }, []);

  function attachImage(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      setImage({ mime: file.type, data: dataUrl.split(',')[1], preview: dataUrl, name: file.name });
    };
    reader.readAsDataURL(file);
  }

  async function attachFiles(fileList) {
    const incoming = [...(fileList || [])].filter(Boolean);
    if (!incoming.length) return;
    const next = [];
    for (const file of incoming) {
      next.push(await readFileAsSource(file));
    }
    setFiles((list) => [...list, ...next]);
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
    if (session.upstreamKeyId) {
      setSandboxKeyId(session.upstreamKeyId);
      storageSet('antigravity_sandbox_key_id', session.upstreamKeyId);
    }
    go('sandbox');
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

  function sandboxHeaders() {
    return {
      'Content-Type': 'application/json',
      ...(adminToken ? {
        Authorization: `Bearer ${adminToken}`,
        'x-gateway-admin-token': adminToken
      } : {}),
      ...(sandboxKeyId ? { 'x-upstream-key-id': sandboxKeyId } : {})
    };
  }

  function collectSources() {
    const uploaded = files.map((file) => ({
      target: file.target,
      content: file.content,
      encoding: file.encoding || 'utf8',
      name: file.name
    }));
    const typed = sources
      .filter((item) => item.target.trim() && item.content)
      .map((item) => ({
        target: item.target.trim(),
        content: item.content,
        encoding: item.encoding || 'utf8'
      }));
    return [...uploaded, ...typed];
  }

  async function runTask() {
    if (!adminToken) {
      go('settings');
      setGatewayError('网页提交沙盒任务需要管理 Token，以便从 Key 池解密所选 Key。');
      return;
    }
    if (!sandboxKeyId) {
      go('keys');
      setGatewayError('请先在「上游 Key」添加并选择一把 Key。网页提交不再使用单独的浏览器 Key。');
      return;
    }
    if (!prompt.trim() && files.length === 0) return;
    const input = image
      ? [{ type: 'text', text: prompt.trim() || '请查看附件并完成任务。' }, { type: 'image', mime_type: image.mime, data: image.data }]
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
    }

    const requestBody = {
      agent: AGENT_ID,
      input,
      environment,
      sources: collectSources(),
      model: selectedBackend,
      maxTotalTokens: maxTokens ? Number(maxTokens) : undefined,
      tools: builtTools().length ? builtTools() : undefined,
      previousInteractionId,
      localSessionId,
      startNewSession,
      upstreamKeyId: sandboxKeyId,
      useProxy,
      proxyUrl: proxyUrl.trim()
    };
    setLastRequest(requestBody);
    setRunning(true);
    setStatus('RUNNING');
    go('sandbox');
    try {
      const response = await fetch('/api/interactions/create', {
        method: 'POST',
        headers: sandboxHeaders(),
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
      setFiles([]);
      setSources([]);
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
    if (!sandboxKeyId) {
      setFileStatus({ error: '请先选择网页提交使用的上游 Key' });
      return;
    }
    setFileStatus({ pending: `正在通过 ${provider} 提取 ${path}` });
    try {
      const res = await fetch('/api/interactions/fetch-file', {
        method: 'POST',
        headers: {
          ...sandboxHeaders(),
          ...(provider === 'snapshot' ? { Accept: 'application/octet-stream' } : {})
        },
        body: JSON.stringify({
          environmentId: envId,
          previousInteractionId: lastInteractionId || undefined,
          filePath: path,
          provider,
          forceRefresh: provider === 'snapshot' && forceRefresh,
          upstreamKeyId: sandboxKeyId,
          useProxy,
          proxyUrl: proxyUrl.trim()
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
    if (!envId || !sandboxKeyId) return;
    setFilePath('/tmp/workspace_project.zip');
    setFileStatus({ pending: '正在打包 /workspace ...' });
    try {
      const response = await fetch('/api/interactions/create', {
        method: 'POST',
        headers: sandboxHeaders(),
        body: JSON.stringify({
          agent: AGENT_ID,
          input: 'You must use the code_execution tool now. Execute exactly: cd /workspace && python3 -c "import shutil; shutil.make_archive(\'/tmp/workspace_project\', \'zip\', \'/workspace\')". Then execute: test -s /tmp/workspace_project.zip && ls -lh /tmp/workspace_project.zip.',
          environment: envId,
          model: selectedBackend,
          tools: [{ type: 'code_execution' }],
          previousInteractionId: lastInteractionId || undefined,
          localSessionId: activeSessionId || undefined,
          startNewSession: false,
          upstreamKeyId: sandboxKeyId,
          useProxy,
          proxyUrl: proxyUrl.trim()
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
      if (statusRes?.settings) setGatewaySettings(statusRes.settings);
    } catch (err) {
      setGatewayError(err.message);
      return;
    }
    try {
      const [keys, tokensRes] = await Promise.all([
        gatewayFetch('/api/gateway/keys'),
        gatewayFetch('/api/gateway/tokens')
      ]);
      const list = keys.keys || [];
      setUpstreamKeys(list);
      setClientTokens(tokensRes.tokens || []);
      setSandboxKeyId((current) => {
        if (current && list.some((item) => item.id === current)) return current;
        const first = list.find((item) => item.enabled)?.id || list[0]?.id || '';
        if (first) storageSet('antigravity_sandbox_key_id', first);
        return first;
      });
    } catch (err) {
      setGatewayError(err.message);
    }
  }, [adminToken]);

  useEffect(() => {
    void loadGateway();
  }, [loadGateway]);

  const activeKeysCount = upstreamKeys.filter((k) => k.enabled).length;
  const selectedKey = upstreamKeys.find((key) => key.id === sandboxKeyId);

  const pageTitle = {
    dashboard: '仪表盘',
    sandbox: '沙盒任务',
    artifacts: '文件提取',
    gateway: '协议概览',
    keys: '上游 Key',
    tokens: '下游 Token',
    logs: '请求日志',
    settings: '运行设置',
    docs: '说明文档'
  }[page] || 'Antigravity';

  const gatewayPanelProps = {
    adminToken,
    setAdminToken,
    gatewayStatus,
    gatewayError,
    setGatewayError,
    upstreamKeys,
    clientTokens,
    loadGateway,
    gatewayFetch,
    selectedBackend,
    gatewaySettings,
    useProxy,
    setUseProxy,
    proxyUrl,
    setProxyUrl
  };

  return (
    <div className="app-shell">
      <header className="header">
        <div className="brand">
          <button className="nav-toggle" onClick={() => setNavOpen((open) => !open)} aria-label="打开导航">☰</button>
          <div className="logo">A</div>
          <div>
            <h1>
              Antigravity Studio <span className="tag">{AGENT_ID}</span>
              <span className="version-badge">v{APP_VERSION}</span>
            </h1>
            <p>{pageTitle} · 功能分页管理后台</p>
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
            <span className={`dot ${selectedKey ? 'ok' : 'warn'}`} />
            <span>{selectedKey ? `网页 Key ${selectedKey.name}` : '未选网页提交 Key'}</span>
          </div>
          <div className="stats">
            <span>状态 <b className={`badge ${status === 'ERROR' ? 'err' : status === 'RUNNING' ? 'run' : 'ok'}`}>{status}</b></span>
            <span>Tokens {tokens}</span>
            <span className="mono">{envId || 'no env'}</span>
          </div>
        </div>
      </header>

      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}

      <AppNav page={page} setPage={go} onNavigate={() => setNavOpen(false)} />

      <main className="app-main">
        {gatewayError && page !== 'settings' && page !== 'keys' && page !== 'gateway' && (
          <p className="status-bad" style={{ marginBottom: 12 }}>{gatewayError}</p>
        )}

        {page === 'dashboard' && (
          <DashboardView
            gatewayStatus={gatewayStatus}
            upstreamKeys={upstreamKeys}
            clientTokens={clientTokens}
            sessions={sessions}
            setPage={go}
            sandboxKeyId={sandboxKeyId}
          />
        )}

        {page === 'sandbox' && (
          <div className="sandbox-page">
            <SandboxComposer
              prompt={prompt}
              setPrompt={setPrompt}
              running={running}
              runTask={runTask}
              image={image}
              attachImage={attachImage}
              setImage={setImage}
              files={files}
              attachFiles={attachFiles}
              setFiles={setFiles}
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
              sessions={sessions}
              activeSessionId={activeSessionId}
              showTurn={showTurn}
              expanded={expanded}
              setExpanded={setExpanded}
              deleteSession={deleteSession}
              lastInteractionId={lastInteractionId}
              setLastInteractionId={setLastInteractionId}
              setOutput={setOutput}
              setSteps={setSteps}
              setActiveSessionId={setActiveSessionId}
              sandboxKeyId={sandboxKeyId}
              setSandboxKeyId={setSandboxKeyId}
              upstreamKeys={upstreamKeys}
            />
            <div className="sandbox-trace">
              <TraceView output={output} steps={steps} running={running} json={json} />
            </div>
          </div>
        )}

        {page === 'artifacts' && (
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
            setTab={() => go('sandbox')}
          />
        )}

        {page === 'gateway' && <GatewayPanel {...gatewayPanelProps} section="overview" />}
        {page === 'keys' && <GatewayPanel {...gatewayPanelProps} section="keys" />}
        {page === 'tokens' && <GatewayPanel {...gatewayPanelProps} section="tokens" />}
        {page === 'settings' && <GatewayPanel {...gatewayPanelProps} section="settings" />}

        {page === 'logs' && (
          <LogDashboard adminToken={adminToken} clientTokens={clientTokens} />
        )}

        {page === 'docs' && (
          <section className="box markdown">
            <h3>Antigravity Studio v{APP_VERSION}</h3>
            <p>本系统以 <b>协议中转站 (Protocol Gateway)</b> 与 <b>独立日志控制台 (Log Dashboard)</b> 为核心，同时集成 Google Interactions 远程沙盒调试能力。</p>
            <h4>界面结构</h4>
            <p>
              WebUI 采用 <b>App Shell + 侧边栏导航 + 功能分页</b>（和 grok2api 一类管理后台相同）：
              左侧按业务分组，右侧一页一个功能，设置不再和聊天挤在同一屏。
            </p>
            <h4>网页沙盒 vs 协议网关</h4>
            <ul>
              <li>网页「沙盒任务」从上游 Key 池里<strong>选择一把 Key</strong>，由服务端解密后直连 Gemini Interactions。</li>
              <li>这条路径<strong>不走</strong> <code>/v1/chat/completions</code> 的 clone / fork / 100k TPM 限额规则。</li>
              <li>Cursor / Cline / 机器人等下游客户端仍然走协议网关，继续受 TPM、粘性会话和日请求上限约束。</li>
              <li>浏览器不再保存单独的统一沙盒 Key。</li>
            </ul>
            <h4>塞文件</h4>
            <p>提交任务时可上传任意文件。新建沙盒时写入 <code>environment.sources</code>，落在 <code>/workspace</code>；复用沙盒时会先让 Agent 把文件写进当前环境。</p>
            <h4>对外模型规范</h4>
            <p>下游客户端请求时，<code>model</code> 填「运行设置 → 对外模型目录」里添加的名字，<code>/v1/models</code> 也按这个列表返回，没有 <code>{AGENT_ID}/</code> 前缀。</p>
            <ul>
              {(gatewaySettings?.gatewayModels || BACKEND_MODELS.map((model) => model.id)).map((id) => (
                <li key={id}><code>{id}</code></li>
              ))}
            </ul>
            <h4>高可用与 TPM 策略</h4>
            <p>默认策略是立即 clone（克隆到新 Key）：60 秒窗口、100k 上限、80% 触发比例，粘性会话到达阈值或遭遇 429 时，用不可执行的工具摘要重建上下文并切换到新 Key。也可改为排队等待。这些规则只作用于协议网关，不作用于网页沙盒直连。</p>
          </section>
        )}
      </main>

      {errorOpen && error && (
        <div className="modal-backdrop" onClick={() => setErrorOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>错误详情</h3>
            <p>{error.err.message}</p>
            <pre className="example">{json(error.err)}</pre>
            <pre className="example">{json(error.request || lastRequest)}</pre>
            <div className="modal-actions">
              <button className="btn" onClick={() => { setErrorOpen(false); go('logs'); }}>去日志控制台</button>
              <button className="btn" onClick={() => setErrorOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
