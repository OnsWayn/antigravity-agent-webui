import { useEffect, useMemo, useState } from 'react';
import { AGENT_ID, copyText, formatDate, formatTokens, storageSet } from '../lib';

export default function GatewayPanel({
  adminToken,
  setAdminToken,
  gatewayStatus,
  gatewayError,
  setGatewayError,
  upstreamKeys = [],
  clientTokens = [],
  loadGateway,
  gatewayFetch,
  selectedBackend,
  gatewaySettings,
  section = 'all',
  useProxy,
  setUseProxy,
  proxyUrl,
  setProxyUrl
}) {
  const show = (id) => section === 'all' || section === id;
  const [keyName, setKeyName] = useState('');
  const [keyValue, setKeyValue] = useState('');
  const [keyProxy, setKeyProxy] = useState('');
  const [keyRpdLimit, setKeyRpdLimit] = useState('100');

  // Token creation form
  const [tokenName, setTokenName] = useState('Cursor Client');
  const [quota, setQuota] = useState('-1');
  const [rpm, setRpm] = useState('60');
  const [defaultModel, setDefaultModel] = useState('');
  const [toolCode, setToolCode] = useState(true);
  const [catalogInput, setCatalogInput] = useState('');
  const [catalogModels, setCatalogModels] = useState([]);
  const [copiedId, setCopiedId] = useState('');
  const [toolSearch, setToolSearch] = useState(true);
  const [toolUrl, setToolUrl] = useState(true);
  const [createdSecret, setCreatedSecret] = useState('');

  // Edit token modal
  const [editingToken, setEditingToken] = useState(null);
  const [tpmStrategy, setTpmStrategy] = useState(gatewaySettings?.tpmStrategy === 'pace' ? 'pace' : 'clone');
  const [tpmLimit, setTpmLimit] = useState(String(gatewaySettings?.tpmLimit ?? 100000));
  const [tpmRatio, setTpmRatio] = useState(String(gatewaySettings?.tpmThresholdRatio ?? 0.8));
  const [tpmWindowMs, setTpmWindowMs] = useState(String(gatewaySettings?.tpmWindowMs ?? 60000));
  const [tpmPaceLimit, setTpmPaceLimit] = useState(String(gatewaySettings?.tpmPaceLimit ?? 100000));
  const [tpmPaceMaxWaitMs, setTpmPaceMaxWaitMs] = useState(String(gatewaySettings?.tpmPaceMaxWaitMs ?? 20000));
  const [tpmPaceDelayMs, setTpmPaceDelayMs] = useState(String(gatewaySettings?.tpmPaceDelayMs ?? 5000));
  const [tpmReserveTtlMs, setTpmReserveTtlMs] = useState(String(gatewaySettings?.tpmReserveTtlMs ?? gatewaySettings?.tpmWindowMs ?? 60000));
  const [migrationMaxInputTokens, setMigrationMaxInputTokens] = useState(String(gatewaySettings?.migrationMaxInputTokens ?? 24000));
  const [hashIgnorePrefixes, setHashIgnorePrefixes] = useState(
    Array.isArray(gatewaySettings?.hashIgnorePrefixes)
      ? gatewaySettings.hashIgnorePrefixes.join('\n')
      : '<RAG-Faiss-Memory>'
  );
  const [internalErrorRetryLimit, setInternalErrorRetryLimit] = useState(String(gatewaySettings?.internalErrorRetryLimit ?? 2));

  useEffect(() => {
    if (!gatewaySettings) return;
    setTpmStrategy(gatewaySettings.tpmStrategy === 'pace' ? 'pace' : 'clone');
    setTpmLimit(String(gatewaySettings.tpmLimit ?? 100000));
    setTpmRatio(String(gatewaySettings.tpmThresholdRatio ?? 0.8));
    setTpmWindowMs(String(gatewaySettings.tpmWindowMs ?? 60000));
    setTpmPaceLimit(String(gatewaySettings.tpmPaceLimit ?? 100000));
    setTpmPaceMaxWaitMs(String(gatewaySettings.tpmPaceMaxWaitMs ?? 20000));
    setTpmPaceDelayMs(String(gatewaySettings.tpmPaceDelayMs ?? 5000));
    setTpmReserveTtlMs(String(gatewaySettings.tpmReserveTtlMs ?? gatewaySettings.tpmWindowMs ?? 60000));
    setMigrationMaxInputTokens(String(gatewaySettings.migrationMaxInputTokens ?? 24000));
    setHashIgnorePrefixes(Array.isArray(gatewaySettings.hashIgnorePrefixes)
      ? gatewaySettings.hashIgnorePrefixes.join('\n')
      : '');
    setInternalErrorRetryLimit(String(gatewaySettings.internalErrorRetryLimit ?? 2));
    if (Array.isArray(gatewaySettings.gatewayModels)) {
      setCatalogModels(gatewaySettings.gatewayModels);
    }
  }, [gatewaySettings]);

  const example = useMemo(() => {
    const origin = window.location.origin;
    const model = (catalogModels[0] || selectedBackend || 'gemini-3.7-flash').replace(`${AGENT_ID}/`, '');
    return `# /v1/models 列出的就是下方「对外模型目录」里添加的名字（无 antigravity 前缀）
# 下游填的 model 会原样写入上游 agent_config.model

curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ag-你的下游Token" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"ping"}]}'

curl ${origin}/v1/responses \\
  -H "Authorization: Bearer ag-你的下游Token" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","input":"ping"}'

curl ${origin}/v1beta/models/${encodeURIComponent(model)}:generateContent \\
  -H "Authorization: Bearer ag-你的下游Token" \\
  -H "Content-Type: application/json" \\
  -d '{"contents":[{"role":"user","parts":[{"text":"ping"}]}]}'`;
  }, [catalogModels, selectedBackend]);

  function normalizeModelName(raw) {
    let value = String(raw || '').trim();
    if (value.startsWith(`${AGENT_ID}/`)) value = value.slice(AGENT_ID.length + 1);
    if (value === AGENT_ID) return '';
    return value;
  }

  async function copyValue(value, id) {
    if (!value) return;
    await copyText(value);
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? '' : cur)), 1500);
  }

  async function saveCatalog(next) {
    try {
      await gatewayFetch('/api/gateway/settings', {
        method: 'PATCH',
        body: JSON.stringify({ gatewayModels: next })
      });
      setCatalogModels(next);
      loadGateway();
    } catch (err) {
      setGatewayError(err.message);
    }
  }

  async function handleAddKey() {
    if (!keyValue.trim()) return;
    try {
      await gatewayFetch('/api/gateway/keys', {
        method: 'POST',
        body: JSON.stringify({
          name: keyName || 'Gemini Key',
          apiKey: keyValue.trim(),
          proxyUrl: keyProxy.trim() || undefined,
          rpdLimit: Number(keyRpdLimit) > 0 ? Number(keyRpdLimit) : 100
        })
      });
      setKeyName('');
      setKeyValue('');
      setKeyProxy('');
      setKeyRpdLimit('100');
      loadGateway();
    } catch (err) {
      setGatewayError(err.message);
    }
  }

  async function handleCreateToken() {
    try {
      const result = await gatewayFetch('/api/gateway/tokens', {
        method: 'POST',
        body: JSON.stringify({
          name: tokenName,
          quotaTokens: Number(quota),
          rpm: rpm ? Number(rpm) : undefined,
          defaultModel: defaultModel.trim() || undefined,
          toolCodeExecution: toolCode,
          toolGoogleSearch: toolSearch,
          toolUrlContext: toolUrl
        })
      });
      setCreatedSecret(result.secret);
      loadGateway();
    } catch (err) {
      setGatewayError(err.message);
    }
  }

  async function handleSaveEditToken() {
    if (!editingToken) return;
    try {
      await gatewayFetch('/api/gateway/tokens/' + editingToken.id, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editingToken.name,
          quotaTokens: Number(editingToken.quotaTokens),
          rpm: editingToken.rpm ? Number(editingToken.rpm) : undefined,
          defaultModel: editingToken.defaultModel || undefined,
          toolCodeExecution: editingToken.toolCodeExecution,
          toolGoogleSearch: editingToken.toolGoogleSearch,
          toolUrlContext: editingToken.toolUrlContext
        })
      });
      setEditingToken(null);
      loadGateway();
    } catch (err) {
      setGatewayError(err.message);
    }
  }

  return (
    <div className="gateway-panel">
      {show('overview') && (
      <section className="box">
        <div className="box-head">🌐 协议中转站概览</div>
        <p className="hint">支持 OpenAI <code>/v1/chat/completions</code>、<code>/v1/responses</code> 及 Google <code>:generateContent</code> 协议代理，统一接入 Antigravity 沙盒 Agent。</p>
        {gatewayStatus && (
          <p className={gatewayStatus.configured ? 'status-ok' : 'status-bad'}>
            网关{gatewayStatus.enabled ? '已启用' : '已关闭'} · MASTER_KEY {gatewayStatus.configured ? '已配置' : '未配置'} · 管理 Token {gatewayStatus.adminConfigured ? '已配置' : '未配置'}
          </p>
        )}
        <label className="label">GATEWAY_ADMIN_TOKEN (用于下方管理配置)</label>
        <div className="row">
          <input
            className="input mono grow"
            type="password"
            value={adminToken}
            onChange={(e) => { setAdminToken(e.target.value); storageSet('antigravity_gateway_admin_token', e.target.value); }}
            placeholder="管理 Token"
          />
          <button className="btn" onClick={loadGateway}>刷新配置</button>
        </div>
        {gatewayError && <p className="status-bad" style={{ marginTop: 8 }}>{gatewayError}</p>}
      </section>
      )}

      {show('keys') && (
      <section className="box">
        <div className="box-head">🔑 上游 Gemini API Key 池</div>
        <p className="hint">配置的 Key 以 AES-256-GCM 加密保存在服务端，界面只显示后缀、不可复制。支持负载均衡、TPM 感知避让、日请求上限与 429 故障自动平滑迁移沙盒。</p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input className="input grow" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="Key 名称 (如 主Key-1)" style={{ minWidth: 120 }} />
          <input className="input mono grow" value={keyValue} onChange={(e) => setKeyValue(e.target.value)} placeholder="真实 Gemini Key (AIzaSy...)" style={{ minWidth: 200 }} />
          <input className="input mono grow" value={keyProxy} onChange={(e) => setKeyProxy(e.target.value)} placeholder="可选独立代理 (如 http://127.0.0.1:7890)" style={{ minWidth: 160 }} />
          <input className="input" type="number" min="1" value={keyRpdLimit} onChange={(e) => setKeyRpdLimit(e.target.value)} placeholder="日请求上限" title="日请求上限，默认 100" style={{ width: 110 }} />
          <button className="btn btn-primary" onClick={handleAddKey}>+ 添加 Key</button>
        </div>

        <div className="gateway-list" style={{ marginTop: 12 }}>
          {upstreamKeys.length === 0 && <p className="hint">暂无配置的上游 Key，请在上方添加。</p>}
          {upstreamKeys.map((item) => (
            <div className="gateway-row" key={item.id}>
              <div>
                <b style={{ fontSize: 14 }}>{item.name}</b>
                <div className="key-copy-row">
                  <code className="key-masked">…{item.suffix || '****'}</code>
                </div>
                <div className="hint">
                  {item.proxyUrl ? ('代理: ' + item.proxyUrl + ' · ') : ''}
                  {item.rpdExhausted ? '🔴 今日额度已用尽' : (item.enabled ? '🟢 已启用' : '⚪ 已停用')}
                </div>
                <div className="hint" title="与 Google AI Studio RPD 日切一致，不用北京 0 点。对齐 AI Studio 日切，不是谷歌项目总额。">
                  今日 {item.rpdUsed ?? 0} / {item.rpdLimit ?? 100}
                  {item.rpdExhausted
                    ? ' · 停用至下次刷新 ' + (item.rpdResetAt ? formatDate(item.rpdResetAt).slice(0, 16) : '-') + '（太平洋时间午夜）'
                    : ' · 下次刷新 ' + (item.rpdResetAt ? formatDate(item.rpdResetAt).slice(0, 16) : '-') + '（太平洋时间午夜，随冬夏令时）'}
                </div>
                <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center' }}>
                  <label className="hint" style={{ margin: 0 }}>日上限</label>
                  <input
                    className="input"
                    type="number"
                    min="1"
                    style={{ width: 88 }}
                    defaultValue={item.rpdLimit ?? 100}
                    key={'rpd-' + item.id + '-' + (item.rpdLimit ?? 100)}
                    onBlur={async (e) => {
                      const n = Number(e.target.value);
                      if (!Number.isFinite(n) || n < 1 || n === item.rpdLimit) return;
                      try {
                        await gatewayFetch('/api/gateway/keys/' + item.id, {
                          method: 'PATCH',
                          body: JSON.stringify({ rpdLimit: n })
                        });
                        loadGateway();
                      } catch (err) {
                        setGatewayError(err.message);
                      }
                    }}
                  />
                </div>
              </div>
              <span>
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    await gatewayFetch('/api/gateway/keys/' + item.id, { method: 'PATCH', body: JSON.stringify({ enabled: !item.enabled }) });
                    loadGateway();
                  }}
                >
                  {item.enabled ? '停用' : '启用'}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  style={{ marginLeft: 6 }}
                  onClick={async () => {
                    if (window.confirm('确定要删除 Key ' + item.name + ' 吗？')) {
                      await gatewayFetch('/api/gateway/keys/' + item.id, { method: 'DELETE' });
                      loadGateway();
                    }
                  }}
                >
                  删除
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>
      )}

      {show('settings') && (
      <>
      <section className="box">
        <div className="box-head">管理 Token 与网页代理</div>
        <p className="hint">管理 Token 用于读取 Key 池、发行下游 Token，以及网页沙盒按 Key 直连。代理仅作用于网页沙盒直连；协议网关仍使用各 Key 自己的代理。</p>
        <label className="label">GATEWAY_ADMIN_TOKEN</label>
        <div className="row">
          <input
            className="input mono grow"
            type="password"
            value={adminToken}
            onChange={(e) => { setAdminToken(e.target.value); storageSet('antigravity_gateway_admin_token', e.target.value); }}
            placeholder="管理 Token"
          />
          <button className="btn" onClick={loadGateway}>保存/刷新</button>
        </div>
        <label className="check" style={{ marginTop: 10 }}>
          <input
            type="checkbox"
            checked={Boolean(useProxy)}
            onChange={(e) => { setUseProxy?.(e.target.checked); storageSet('antigravity_use_proxy', e.target.checked); }}
          />
          <span>网页沙盒启用 HTTP/HTTPS 代理（覆盖所选 Key 的独立代理）</span>
        </label>
        {useProxy && (
          <input
            className="input mono"
            style={{ marginTop: 6 }}
            value={proxyUrl}
            onChange={(e) => { setProxyUrl?.(e.target.value); storageSet('antigravity_proxy_url', e.target.value); }}
            placeholder="http://127.0.0.1:7890"
          />
        )}
      </section>
      <section className="box">
        <div className="box-head">📦 对外模型目录</div>
        <p className="hint">
          这里添加的名字会原样出现在 <code>/v1/models</code>，并写入上游 <code>agent_config.model</code>。
          Google 更新型号时只需在此添加，不必改项目。没有 antigravity 前缀。
        </p>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input mono grow"
            value={catalogInput}
            onChange={(e) => setCatalogInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const name = normalizeModelName(catalogInput);
              if (!name || catalogModels.includes(name)) return;
              void saveCatalog([...catalogModels, name]);
              setCatalogInput('');
            }}
            placeholder="添加模型名，如 gemini-3.8-flash"
          />
          <button
            className="btn btn-primary"
            onClick={() => {
              const name = normalizeModelName(catalogInput);
              if (!name || catalogModels.includes(name)) return;
              void saveCatalog([...catalogModels, name]);
              setCatalogInput('');
            }}
          >
            + 添加
          </button>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: 'wrap' }}>
          {catalogModels.length === 0 && <p className="hint">目录为空时，下游仍可直接填写任意模型名，网关会原样转给上游。</p>}
          {catalogModels.map((name) => (
            <span key={name} className="tag">
              {name}{' '}
              <button
                className="btn-ghost"
                onClick={() => saveCatalog(catalogModels.filter((item) => item !== name))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </section>

      <section className="box">
        <div className="box-head">📈 TPM 策略</div>
        <p className="hint">
          两种策略二选一，保存后立即生效。默认「立即克隆到新 Key」。旧设置里的 frok 会当成 clone。
        </p>
        <div className="row" style={{ gap: 16, marginBottom: 10 }}>
          <label className="check">
            <input type="radio" name="tpm-strategy" checked={tpmStrategy === 'clone'} onChange={() => setTpmStrategy('clone')} />
            <span>立即克隆到新 Key</span>
          </label>
          <label className="check">
            <input type="radio" name="tpm-strategy" checked={tpmStrategy === 'pace'} onChange={() => setTpmStrategy('pace')} />
            <span>排队等待（同一把 Key）</span>
          </label>
        </div>
        {tpmStrategy === 'clone' ? (
          <p className="hint">
            滑动窗口内用量达到「TPM 上限 × 触发比例」时，粘性会话会主动迁移到空闲 Key。
            迁移时重建上下文不得超过 input token 预算。
          </p>
        ) : (
          <p className="hint">
            窗口内已用量+本轮预估必须小于 TPM 窗口才立刻上传（贴着 100k 不算能发）。否则等待腾出额度。预计等待超过「最长等待」则换 Key 重建。50k 会话要保上下文，最长等待需覆盖上一笔出窗剩余时间（常见 40s+）。窗口已能塞下后再额外延迟再上传。预约超时自动释放，防止异常占额度。
          </p>
        )}
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {tpmStrategy === 'clone' ? (
            <>
              <label className="label" style={{ minWidth: 140 }}>
                TPM 上限
                <input className="input" value={tpmLimit} onChange={(e) => setTpmLimit(e.target.value)} placeholder="100000" />
              </label>
              <label className="label" style={{ minWidth: 140 }}>
                触发比例
                <input className="input" value={tpmRatio} onChange={(e) => setTpmRatio(e.target.value)} placeholder="0.8" />
              </label>
            </>
          ) : (
            <>
              <label className="label" style={{ minWidth: 140 }}>
                TPM 窗口
                <input className="input" value={tpmPaceLimit} onChange={(e) => setTpmPaceLimit(e.target.value)} placeholder="100000" />
              </label>
              <label className="label" style={{ minWidth: 140 }}>
                最长等待 (毫秒)
                <input className="input" value={tpmPaceMaxWaitMs} onChange={(e) => setTpmPaceMaxWaitMs(e.target.value)} placeholder="20000" />
              </label>
              <label className="label" style={{ minWidth: 140 }}>
                额外延迟 (毫秒)
                <input className="input" value={tpmPaceDelayMs} onChange={(e) => setTpmPaceDelayMs(e.target.value)} placeholder="5000" />
              </label>
              <label className="label" style={{ minWidth: 160 }}>
                预约 TTL (毫秒)
                <input className="input" value={tpmReserveTtlMs} onChange={(e) => setTpmReserveTtlMs(e.target.value)} placeholder="60000" />
              </label>
            </>
          )}
          <label className="label" style={{ minWidth: 140 }}>
            窗口 (毫秒)
            <input className="input" value={tpmWindowMs} onChange={(e) => setTpmWindowMs(e.target.value)} placeholder="60000" />
          </label>
          <label className="label" style={{ minWidth: 180 }}>
            迁移 input token 预算
            <input className="input" value={migrationMaxInputTokens} onChange={(e) => setMigrationMaxInputTokens(e.target.value)} placeholder="24000" />
          </label>
          <button
            className="btn btn-primary"
            onClick={async () => {
              try {
                await gatewayFetch('/api/gateway/settings', {
                  method: 'PATCH',
                  body: JSON.stringify({
                    tpmStrategy,
                    tpmLimit: Number(tpmLimit),
                    tpmThresholdRatio: Number(tpmRatio),
                    tpmWindowMs: Number(tpmWindowMs),
                    tpmPaceLimit: Number(tpmPaceLimit),
                    tpmPaceMaxWaitMs: Number(tpmPaceMaxWaitMs),
                    tpmPaceDelayMs: Number(tpmPaceDelayMs),
                    tpmReserveTtlMs: Number(tpmReserveTtlMs),
                    migrationMaxInputTokens: Number(migrationMaxInputTokens)
                  })
                });
                loadGateway();
              } catch (err) {
                setGatewayError(err.message);
              }
            }}
          >
            保存策略
          </button>
        </div>
      </section>

      <section className="box">
        <div className="box-head">🧾 会话哈希</div>
        <p className="hint">
          计算 prefix_hash 时忽略这些字面量前缀之后的易变注入（例如插件记忆）。只影响会话判定，发给模型的正文不删。每行一个标记，保存立即生效。
        </p>
        <label className="label">忽略前缀（每行一个）</label>
        <textarea
          className="input mono"
          rows={4}
          value={hashIgnorePrefixes}
          onChange={(e) => setHashIgnorePrefixes(e.target.value)}
          placeholder={'<RAG-Faiss-Memory>\n<system_reminder>'}
          style={{ width: '100%', minHeight: 88 }}
        />
        <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
          <label className="label" style={{ minWidth: 220 }}>
            Internal error 熔断次数
            <input
              className="input"
              value={internalErrorRetryLimit}
              onChange={(e) => setInternalErrorRetryLimit(e.target.value)}
              placeholder="2"
            />
          </label>
          <button
            className="btn btn-primary"
            onClick={async () => {
              try {
                await gatewayFetch('/api/gateway/settings', {
                  method: 'PATCH',
                  body: JSON.stringify({
                    hashIgnorePrefixes,
                    internalErrorRetryLimit: Number(internalErrorRetryLimit)
                  })
                });
                loadGateway();
              } catch (err) {
                setGatewayError(err.message);
              }
            }}
          >
            保存会话设置
          </button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          同一会话连续命中 Internal error 达到该次数后，后续请求不再打上游，直接 HTTP 400。成功或 fork 新链后清零。
        </p>
      </section>
      </>
      )}

      {show('tokens') && (
      <section className="box">
        <div className="box-head">🎫 下游 Client Token 发行与精细控制</div>
        <p className="hint">为 Cursor、Cline、QQ 机器人等不同客户端分发专属 Token。密钥会一直显示，可随时复制。</p>

        <div className="token-form-card">
          <div className="row" style={{ gap: 8 }}>
            <input className="input grow" value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="Token 名称 (如 Cursor 专属)" />
            <input className="input" style={{ width: 120 }} value={quota} onChange={(e) => setQuota(e.target.value)} placeholder="额度 (-1 无限)" />
            <input className="input" style={{ width: 100 }} value={rpm} onChange={(e) => setRpm(e.target.value)} placeholder="RPM 限制" />
          </div>

          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label className="label">默认回退模型（请求未带 model 时使用）</label>
              <input
                className="input mono"
                list="gateway-catalog-models"
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                placeholder="留空则用 gemini-3.7-flash"
              />
              <datalist id="gateway-catalog-models">
                {catalogModels.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="row" style={{ marginTop: 10, gap: 16 }}>
            <label className="label" style={{ margin: 0 }}>允许工具:</label>
            <label className="check"><input type="checkbox" checked={toolCode} onChange={(e) => setToolCode(e.target.checked)} /><span>⚡ 代码执行 (Code Execution)</span></label>
            <label className="check"><input type="checkbox" checked={toolSearch} onChange={(e) => setToolSearch(e.target.checked)} /><span>🔍 谷歌搜索 (Google Search)</span></label>
            <label className="check"><input type="checkbox" checked={toolUrl} onChange={(e) => setToolUrl(e.target.checked)} /><span>🌐 网页抓取 (URL Context)</span></label>
          </div>

          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={handleCreateToken}>
            ✨ 发行新 Token
          </button>
        </div>

        {createdSecret && (
          <div className="created-secret-box">
            <b>🔑 新 Token 已发行（列表里也会一直显示，可随时复制）：</b>
            <div className="row" style={{ marginTop: 6 }}>
              <input className="input mono grow bold" readOnly value={createdSecret} />
              <button className="btn btn-primary" onClick={() => copyValue(createdSecret, 'created-secret')}>
                {copiedId === 'created-secret' ? '已复制' : '复制密钥'}
              </button>
            </div>
          </div>
        )}

        <div className="gateway-list" style={{ marginTop: 16 }}>
          {clientTokens.map((item) => (
            <div className="gateway-row" key={item.id}>
              <div>
                <b style={{ fontSize: 14 }}>{item.name}</b>
                <div className="key-copy-row">
                  <code className="key-plain">{item.secret || (item.tokenPrefix + '…')}</code>
                  {item.secret && (
                    <button className="btn btn-sm" onClick={() => copyValue(item.secret, 'token-' + item.id)}>
                      {copiedId === 'token-' + item.id ? '已复制' : '复制'}
                    </button>
                  )}
                </div>
                <div className="hint">
                  用量: {formatTokens(item.usedTokens)}/{item.quotaTokens < 0 ? '∞' : formatTokens(item.quotaTokens)} · RPM: {item.rpm || '不限'}
                  {!item.secret ? ' · 旧 Token 未保存明文，请重新发行' : ''}
                </div>
                <div className="token-meta-tags" style={{ marginTop: 4 }}>
                  {item.defaultModel && <span className="tag">默认: {item.defaultModel}</span>}
                  <span className="tag">
                    {item.toolCodeExecution ? '⚡' : '<s>⚡</s>'}{' '}
                    {item.toolGoogleSearch ? '🔍' : '<s>🔍</s>'}{' '}
                    {item.toolUrlContext ? '🌐' : '<s>🌐</s>'}
                  </span>
                  <span className={'badge ' + (item.enabled ? 'ok' : 'err')}>
                    {item.enabled ? '启用' : '禁用'}
                  </span>
                </div>
              </div>
              <span>
                <button
                  className="btn btn-sm"
                  onClick={() => setEditingToken({ ...item })}
                >
                  ✏️ 编辑
                </button>
                <button
                  className="btn btn-sm"
                  style={{ marginLeft: 6 }}
                  onClick={async () => {
                    await gatewayFetch('/api/gateway/tokens/' + item.id, { method: 'PATCH', body: JSON.stringify({ enabled: !item.enabled }) });
                    loadGateway();
                  }}
                >
                  {item.enabled ? '停用' : '启用'}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  style={{ marginLeft: 6 }}
                  onClick={async () => {
                    if (window.confirm('确定要撤销 Token ' + item.name + ' 吗？')) {
                      await gatewayFetch('/api/gateway/tokens/' + item.id, { method: 'DELETE' });
                      loadGateway();
                    }
                  }}
                >
                  撤销
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>
      )}

      {show('tokens') && editingToken && (
        <div className="modal-backdrop" onClick={() => setEditingToken(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>编辑 Token：{editingToken.name}</h3>
            <label className="label">Token 名称</label>
            <input className="input" value={editingToken.name} onChange={(e) => setEditingToken({ ...editingToken, name: e.target.value })} />
            
            <div className="row" style={{ marginTop: 8, gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label className="label">额度 (-1 为无限)</label>
                <input className="input" value={editingToken.quotaTokens} onChange={(e) => setEditingToken({ ...editingToken, quotaTokens: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="label">RPM 限制</label>
                <input className="input" value={editingToken.rpm || ''} onChange={(e) => setEditingToken({ ...editingToken, rpm: e.target.value })} />
              </div>
            </div>

            <label className="label" style={{ marginTop: 8 }}>默认回退模型</label>
            <input
              className="input mono"
              list="gateway-catalog-models"
              value={editingToken.defaultModel || ''}
              onChange={(e) => setEditingToken({ ...editingToken, defaultModel: e.target.value })}
              placeholder="留空跟随全局默认"
            />

            <div className="row" style={{ marginTop: 10, gap: 12 }}>
              <label className="check"><input type="checkbox" checked={editingToken.toolCodeExecution} onChange={(e) => setEditingToken({ ...editingToken, toolCodeExecution: e.target.checked })} /><span>⚡ 代码执行</span></label>
              <label className="check"><input type="checkbox" checked={editingToken.toolGoogleSearch} onChange={(e) => setEditingToken({ ...editingToken, toolGoogleSearch: e.target.checked })} /><span>🔍 谷歌搜索</span></label>
              <label className="check"><input type="checkbox" checked={editingToken.toolUrlContext} onChange={(e) => setEditingToken({ ...editingToken, toolUrlContext: e.target.checked })} /><span>🌐 网页抓取</span></label>
            </div>

            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="btn" onClick={() => setEditingToken(null)}>取消</button>
              <button className="btn btn-primary" onClick={handleSaveEditToken}>保存修改</button>
            </div>
          </div>
        </div>
      )}

      {show('overview') && (
      <section className="box">
        <div className="box-head">💻 客户端调用示例 (OpenAI / Responses / Gemini)</div>
        <pre className="example">{example}</pre>
      </section>
      )}
    </div>
  );
}
