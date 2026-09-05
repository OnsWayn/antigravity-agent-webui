import { useState } from 'react';
import { BACKEND_MODELS, PRESETS, formatBytes, storageSet } from '../lib';

export default function SandboxComposer({
  prompt, setPrompt, running, runTask,
  image, attachImage, setImage,
  files, attachFiles, setFiles,
  envMode, setEnvMode, envId, setEnvId, freshSession, setFreshSession,
  sources, setSources,
  selectedBackend, setBackendModel, customModel, setCustomModel,
  maxTokens, setMaxTokens, tools, setTools, mcp, setMcp,
  sessions, activeSessionId, showTurn, expanded, setExpanded, deleteSession,
  lastInteractionId, setLastInteractionId, setOutput, setSteps,
  setActiveSessionId,
  sandboxKeyId, setSandboxKeyId, upstreamKeys = []
}) {
  const [showCustomModelInput, setShowCustomModelInput] = useState(Boolean(customModel));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const enabledKeys = upstreamKeys.filter((key) => key.enabled);
  const selectedKey = enabledKeys.find((key) => key.id === sandboxKeyId) || null;

  function onPickFiles(list) {
    const incoming = [...(list || [])];
    if (!incoming.length) return;
    void attachFiles(incoming);
  }

  return (
    <div className="sandbox-composer">
      <section className="card primary">
        <div className="card-head">
          <h2 style={{ margin: 0 }}>提交沙盒任务</h2>
          <span className="badge ok">{files.length} 个文件</span>
        </div>
        <p className="hint">
          网页提交会<strong>直接</strong>使用下方选中的上游 Key 调用 Gemini Interactions，
          不走协议网关的 clone / fork / 100k TPM 限额。复用会话时请继续用创建该沙盒的同一把 Key。
        </p>

        <label className="label">本次使用的上游 Key</label>
        <select
          className="select"
          value={sandboxKeyId || ''}
          onChange={(e) => {
            setSandboxKeyId(e.target.value);
            storageSet('antigravity_sandbox_key_id', e.target.value);
          }}
        >
          <option value="">{enabledKeys.length ? '请选择 Key' : '请先在「上游 Key」页添加'}</option>
          {enabledKeys.map((key) => (
            <option key={key.id} value={key.id}>
              {key.name} …{key.suffix || '****'}
              {key.rpdExhausted ? '（今日额度已用尽，仍可强制直连）' : ''}
            </option>
          ))}
        </select>
        {selectedKey && (
          <p className="hint">
            {selectedKey.proxyUrl ? `该 Key 代理: ${selectedKey.proxyUrl} · ` : ''}
            今日 {selectedKey.rpdUsed ?? 0}/{selectedKey.rpdLimit ?? 100}
          </p>
        )}

        <div className="pills" style={{ marginTop: 10 }}>
          <button className="pill" onClick={() => setPrompt(PRESETS.news)}>新闻 PDF</button>
          <button className="pill" onClick={() => setPrompt(PRESETS.data)}>CSV 图表</button>
          <button className="pill" onClick={() => setPrompt(PRESETS.code)}>Node/Python</button>
        </div>
        <textarea
          className="textarea"
          value={prompt}
          placeholder="描述要在远程沙盒中执行的任务。可拖入文件塞进 /workspace，Ctrl+V 也可贴截图。"
          onChange={(e) => setPrompt(e.target.value)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const dropped = [...(e.dataTransfer.files || [])];
            if (!dropped.length) return;
            const images = dropped.filter((file) => file.type.startsWith('image/'));
            const rest = dropped.filter((file) => !file.type.startsWith('image/'));
            if (images[0]) attachImage(images[0]);
            if (rest.length) onPickFiles(rest);
            if (!rest.length && images.length > 1) onPickFiles(images.slice(1));
          }}
          onPaste={(e) => {
            const items = [...(e.clipboardData?.items || [])];
            const imageItem = items.find((entry) => entry.type.startsWith('image/'));
            if (imageItem) {
              e.preventDefault();
              attachImage(imageItem.getAsFile());
            }
          }}
        />

        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <label className="btn btn-sm">
            塞入沙盒文件
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                onPickFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          <label className="btn btn-sm">
            添加图片（视觉输入）
            <input type="file" accept="image/*" hidden onChange={(e) => attachImage(e.target.files?.[0])} />
          </label>
          {image && <button className="btn btn-sm btn-danger" onClick={() => setImage(null)}>移除图片</button>}
          {files.length > 0 && (
            <button className="btn btn-sm btn-danger" onClick={() => setFiles([])}>清空文件</button>
          )}
        </div>
        {image && <div className="preview"><img src={image.preview} alt="" /></div>}
        {files.length > 0 && (
          <div className="file-chip-list">
            {files.map((file, index) => (
              <div className="file-chip" key={`${file.target}-${index}`}>
                <div>
                  <div className="file-chip-name">{file.name || file.target}</div>
                  <div className="hint mono">{file.target} · {formatBytes(file.size)} · {file.encoding === 'base64' ? '二进制' : '文本'}</div>
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => setFiles((list) => list.filter((_, i) => i !== index))}>移除</button>
              </div>
            ))}
          </div>
        )}
        <p className="hint">
          新建沙盒时，文件会作为 environment.sources 写入 <code>/workspace</code>。
          复用已有沙盒时，会先让 Agent 把文件写进当前环境。
        </p>

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
            <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setSources((list) => [...list, { target: '', content: '', encoding: 'utf8' }])}>+ 手动文本文件</button>
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

        <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? '收起高级选项' : '高级选项（max tokens / MCP）'}
        </button>
        {showAdvanced && (
          <div style={{ marginTop: 8 }}>
            <label className="label">maxTotalTokens</label>
            <input className="input" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="可选" />
            <label className="label" style={{ marginTop: 8 }}>远程 MCP</label>
            <div className="row">
              <input className="input grow" value={mcp.name} onChange={(e) => setMcp((m) => ({ ...m, name: e.target.value }))} placeholder="name" />
              <input className="input grow" value={mcp.url} onChange={(e) => setMcp((m) => ({ ...m, url: e.target.value }))} placeholder="https://..." />
            </div>
          </div>
        )}

        <button className="btn btn-primary" style={{ marginTop: 14 }} disabled={running} onClick={runTask}>
          {running ? '执行中…' : '提交沙盒任务'}
        </button>
      </section>

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
                    <div className="session-env mono">{session.envId}{session.upstreamKeyId ? ` · key ${session.upstreamKeyId.slice(0, 8)}` : ''}</div>
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
    </div>
  );
}
