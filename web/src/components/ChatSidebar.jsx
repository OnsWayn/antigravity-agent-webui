import { useState } from 'react';
import { AGENT_ID, BACKEND_MODELS, PRESETS, storageSet } from '../lib';

export default function ChatSidebar({
  prompt, setPrompt, running, runTask, image, attachImage, setImage,
  envMode, setEnvMode, envId, setEnvId, freshSession, setFreshSession,
  sources, setSources, selectedBackend, setBackendModel, customModel, setCustomModel,
  maxTokens, setMaxTokens, tools, setTools, mcp, setMcp,
  useProxy, setUseProxy, proxyUrl, setProxyUrl,
  sessions, activeSessionId, setActiveSessionId, showTurn, expanded, setExpanded, deleteSession,
  setLastInteractionId, setOutput, setSteps,
  adminToken, setAdminToken, upstreamKeysCount, loadGateway,
  apiKey, setKeyModal, setKeyDraft
}) {
  const [showCustomModelInput, setShowCustomModelInput] = useState(false);

  return (
    <aside className="sidebar">
      {/* Group 1: API 网关与连接配置 */}
      <section className="card">
        <div className="card-head">
          <h2 style={{ margin: 0 }}>📡 网关与服务状态</h2>
          <span className="badge ok">{upstreamKeysCount || 0} 个 Key 就绪</span>
        </div>
        <div style={{ marginTop: 8 }}>
          <label className="label">管理 Token (GATEWAY_ADMIN_TOKEN)</label>
          <div className="row">
            <input
              className="input mono grow"
              type="password"
              value={adminToken}
              onChange={(e) => { setAdminToken(e.target.value); storageSet('antigravity_gateway_admin_token', e.target.value); }}
              placeholder="管理 Token"
            />
            <button className="btn btn-sm" onClick={loadGateway}>保存/刷新</button>
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={useProxy}
              onChange={(e) => { setUseProxy(e.target.checked); storageSet('antigravity_use_proxy', e.target.checked); }}
            />
            <span>启用 HTTP/HTTPS 代理</span>
          </label>
          {useProxy && (
            <input
              className="input mono"
              style={{ marginTop: 4 }}
              value={proxyUrl}
              onChange={(e) => { setProxyUrl(e.target.value); storageSet('antigravity_proxy_url', e.target.value); }}
              placeholder="http://127.0.0.1:7890"
            />
          )}
        </div>
      </section>

      {/* Group 2: 沙盒调试 (Agent 交互) */}
      <section className="card primary">
        <h2>🧪 沙盒 Agent 调试</h2>
        <div className="pills">
          <button className="pill" onClick={() => setPrompt(PRESETS.news)}>新闻 PDF</button>
          <button className="pill" onClick={() => setPrompt(PRESETS.data)}>CSV 图表</button>
          <button className="pill" onClick={() => setPrompt(PRESETS.code)}>Node/Python</button>
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
          <span className="label">沙盒运行环境</span>
          <label className="radio"><input type="radio" checked={envMode === 'new'} onChange={() => setEnvMode('new')} /> 新建沙盒</label>
          <label className="radio"><input type="radio" checked={envMode === 'reuse'} onChange={() => setEnvMode('reuse')} /> 复用 Environment ID</label>
          {envMode === 'reuse' && (
            <>
              <div className="row" style={{ marginTop: 4 }}>
                <input className="input mono grow" value={envId} onChange={(e) => setEnvId(e.target.value)} placeholder="environment id" />
                <button className="btn btn-sm" onClick={() => envId && navigator.clipboard.writeText(envId)}>复制</button>
              </div>
              <label className="check" style={{ marginTop: 4 }}>
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

        <div style={{ marginTop: 12 }}>
          <span className="label">沙盒内部推理模型</span>
          <select
            className="select"
            value={showCustomModelInput ? 'custom' : selectedBackend}
            onChange={(e) => {
              if (e.target.value === 'custom') {
                setShowCustomModelInput(true);
              } else {
                setShowCustomModelInput(false);
                setBackendModel(e.target.value);
                storageSet('antigravity_selected_model', e.target.value);
              }
            }}
          >
            {BACKEND_MODELS.map((model) => (
              <option key={model.id} value={model.id}>{model.label} — {model.hint}</option>
            ))}
            <option value="custom">✏️ 自定义模型名称 (Pass-through)...</option>
          </select>
          {showCustomModelInput && (
            <input
              className="input mono"
              style={{ marginTop: 6 }}
              value={customModel || ''}
              onChange={(e) => {
                setCustomModel(e.target.value);
                setBackendModel(e.target.value);
              }}
              placeholder="输入自定义模型如 gemini-3.1-pro-preview"
            />
          )}
        </div>

        <div style={{ marginTop: 10 }}>
          <span className="label">沙盒工具开关</span>
          <label className="check"><input type="checkbox" checked={tools.code} onChange={(e) => setTools((t) => ({ ...t, code: e.target.checked }))} /><span>Code Execution<small>远程沙盒里跑命令</small></span></label>
          <label className="check"><input type="checkbox" checked={tools.search} onChange={(e) => setTools((t) => ({ ...t, search: e.target.checked }))} /><span>Google Search<small>检索公开网页</small></span></label>
          <label className="check"><input type="checkbox" checked={tools.url} onChange={(e) => setTools((t) => ({ ...t, url: e.target.checked }))} /><span>URL Context<small>抓取指定 URL</small></span></label>
        </div>

        <button className="btn btn-primary" style={{ marginTop: 14 }} disabled={running} onClick={runTask}>
          {running ? '执行中…' : '🚀 提交沙盒任务'}
        </button>
      </section>

      {/* Group 3: 会话历史 */}
      <section className="card">
        <div className="card-head">
          <h2 style={{ margin: 0 }}>沙盒历史会话</h2>
          <span>
            <button className="btn btn-sm btn-ghost" disabled={!envId} onClick={() => { setActiveSessionId(null); setLastInteractionId(''); setFreshSession(true); setEnvMode('reuse'); setOutput(''); setSteps([]); }}>当前沙盒新会话</button>
            <button className="btn btn-sm btn-ghost" onClick={() => { setActiveSessionId(null); setEnvMode('new'); setEnvId(''); setLastInteractionId(''); setOutput(''); setSteps([]); setFreshSession(false); }}>新沙盒</button>
          </span>
        </div>
        <div className="sessions">
          {sessions.length === 0 && <div className="hint">暂无调试会话。</div>}
          {sessions.map((session) => {
            const turns = session.turns?.length ? session.turns : [{ interactionId: session.lastInteractionId, prompt: session.lastPrompt, outputText: session.lastOutput, steps: session.steps }];
            const open = expanded.has(session.id);
            return (
              <div key={session.id} className={'session ' + (activeSessionId === session.id ? 'active' : '')}>
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
                      <div key={turn.interactionId || index} className={'turn ' + (lastInteractionId === turn.interactionId ? 'active' : '')} onClick={() => showTurn(session, turn)}>
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
    </aside>
  );
}
