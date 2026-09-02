import { useCallback, useEffect, useState } from 'react';
import { copyText, formatDate, formatDuration, formatTokens, safeJson } from '../lib';

function displayCloneAlias(value) {
  if (value == null) return value;
  const text = String(value);
  if (text === 'frok') return 'clone';
  return text.replace(/frok/g, 'clone');
}

function diagnosticsOf(log) {
  const raw = log?.diagnostics_json;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export default function LogDashboard({ adminToken, clientTokens = [] }) {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(20);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [tokenFilter, setTokenFilter] = useState('');
  const [convFilter, setConvFilter] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedCards, setExpandedCards] = useState(() => new Set());
  const [copiedId, setCopiedId] = useState(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError('');
    const offset = (page - 1) * limit;
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    if (statusFilter) params.set('status', statusFilter);
    if (tokenFilter) params.set('tokenId', tokenFilter);
    if (convFilter) params.set('conversationKey', convFilter);
    if (search.trim()) params.set('search', search.trim());

    try {
      const res = await fetch('/api/gateway/logs?' + params.toString(), {
        headers: {
          'Content-Type': 'application/json',
          ...(adminToken ? { Authorization: 'Bearer ' + adminToken } : {})
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        throw new Error(data.error?.message || ('HTTP ' + res.status));
      }
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [adminToken, page, limit, statusFilter, tokenFilter, convFilter, search]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  async function handleClearLogs() {
    if (!window.confirm('确定要清空所有请求日志吗？此操作不可撤销。')) return;
    try {
      const res = await fetch('/api/gateway/logs', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(adminToken ? { Authorization: 'Bearer ' + adminToken } : {})
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        throw new Error(data.error?.message || ('HTTP ' + res.status));
      }
      setPage(1);
      fetchLogs();
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleCard(requestId) {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });
  }

  function handleCopy(text, id) {
    copyText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="log-dashboard">
      <div className="log-dashboard-head">
        <div className="title-area">
          <h2>📊 独立日志控制台</h2>
          <span className="hint">完整记录下游请求、网关调度、上游 Google Interactions Payload/响应以及 Key 轮换过程</span>
        </div>
        <div className="head-actions">
          <button className="btn btn-sm" onClick={() => fetchLogs()} disabled={loading}>
            {loading ? '加载中…' : '🔄 刷新'}
          </button>
          <button className="btn btn-sm btn-danger" onClick={handleClearLogs} disabled={loading || total === 0}>
            🗑️ 清空日志
          </button>
        </div>
      </div>

      <div className="log-filter-bar">
        <div className="filter-item">
          <label>状态</label>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
            <option value="">全部状态</option>
            <option value="success">✅ 成功 (success)</option>
            <option value="error">❌ 错误 (error)</option>
            <option value="rate_limited">⚠️ 限流 (rate_limited)</option>
            <option value="pending">⏳ 请求中 (pending)</option>
          </select>
        </div>

        <div className="filter-item">
          <label>下游 Token</label>
          <select value={tokenFilter} onChange={(e) => { setTokenFilter(e.target.value); setPage(1); }}>
            <option value="">全部 Token</option>
            {clientTokens.map((tk) => (
              <option key={tk.id} value={tk.id}>{tk.name} ({tk.tokenPrefix}…)</option>
            ))}
          </select>
        </div>

        <div className="filter-item">
          <label>会话标识</label>
          <input
            className="input"
            value={convFilter}
            onChange={(e) => { setConvFilter(e.target.value); setPage(1); }}
            placeholder="hdr:xxx / fp:xxx"
          />
        </div>

        <div className="filter-item grow">
          <label>搜索关键词</label>
          <input
            className="input"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="搜索 Request ID、Key 名称、错误信息…"
          />
        </div>
      </div>

      {error && <div className="status-bad" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="log-stats-bar">
        <span>共 <b>{total}</b> 条记录 · 第 <b>{page}</b> / <b>{totalPages}</b> 页</span>
        <div className="page-size-selector">
          <span>每页</span>
          <select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}>
            <option value={20}>20 条</option>
            <option value={50}>50 条</option>
            <option value={100}>100 条</option>
          </select>
        </div>
      </div>

      <div className="log-list">
        {logs.length === 0 && !loading && (
          <div className="empty" style={{ padding: 40 }}>
            <div style={{ fontSize: 32, opacity: 0.3, marginBottom: 8 }}>📝</div>
            <h3>暂无请求日志</h3>
            <p className="hint">当下游客户端或沙盒调用网关接口时，请求体与响应将实时记录于此。</p>
          </div>
        )}

        {logs.map((log) => {
          const isExpanded = expandedCards.has(log.request_id);
          const isSuccess = log.status === 'success';
          const isRateLimited = log.status === 'rate_limited';
          const isError = log.status === 'error';
          const diag = diagnosticsOf(log);

          let statusBadge = <span className="badge ok">✅ 成功</span>;
          if (isRateLimited) statusBadge = <span className="badge warn">⚠️ 429 限流</span>;
          else if (isError) statusBadge = <span className="badge err">❌ 错误</span>;
          else if (log.status === 'pending') statusBadge = <span className="badge run">⏳ 请求中</span>;

          return (
            <div
              key={log.request_id}
              className={'log-card ' + (isError ? 'card-err ' : '') + (isRateLimited ? 'card-warn ' : '')}
            >
              <div className="log-card-header" onClick={() => toggleCard(log.request_id)}>
                <div className="header-left">
                  <button className="btn-ghost fold-btn">{isExpanded ? '▾' : '▸'}</button>
                  {statusBadge}
                  <span className="mono bold request-id">{log.request_id}</span>
                  <span className="tag">{log.endpoint || '-'}</span>
                  <span className="hint protocol">{log.protocol}</span>
                </div>
                <div className="header-right">
                  <span className="hint">⏱ {formatDate(log.created_at)}</span>
                  {log.duration_ms != null && (
                    <span className="tag">⏳ {formatDuration(log.duration_ms)}</span>
                  )}
                  {log.total_tokens != null && log.total_tokens > 0 && (
                    <span className="tag">📊 {formatTokens(log.total_tokens)} tokens</span>
                  )}
                </div>
              </div>

              <div className="log-card-meta">
                <div className="meta-item">
                  <span className="meta-label">🔑 Key:</span>
                  <span className="meta-val bold">{log.upstream_key_name || log.upstream_key_id || '未绑定'}</span>
                  {log.key_switch_count > 0 && (
                    <span className="badge warn" style={{ marginLeft: 6 }}>
                      🔄 切换 {log.key_switch_count} 次 (重试 {log.retry_count} 次)
                    </span>
                  )}
                </div>

                <div className="meta-item">
                  <span className="meta-label">📤 下游 Token:</span>
                  <span className="meta-val">{log.token_name || log.token_id || '未知'}</span>
                </div>

                <div className="meta-item">
                  <span className="meta-label">🔗 会话:</span>
                  <span className="meta-val mono">{log.conversation_key || '无'}</span>
                  <span className="tag" style={{ marginLeft: 4 }}>模式: {log.conversation_mode || 'stateless'}</span>
                  {log.upstream_transition && log.upstream_transition !== 'none' && (
                    <span className="tag" style={{ marginLeft: 4 }}>上游: {displayCloneAlias(log.upstream_transition)}</span>
                  )}
                  {log.context_rebuild_reason && (
                    <span className="tag" style={{ marginLeft: 4 }}>原因: {log.context_rebuild_reason}</span>
                  )}
                  {log.fork_reason && (
                    <span className="tag" style={{ marginLeft: 4 }}>fork: {log.fork_reason}</span>
                  )}
                  {Number(log.raw_call_marker_count) > 0 && (
                    <span className="badge warn" style={{ marginLeft: 4 }}>[Calls:] × {log.raw_call_marker_count}</span>
                  )}
                  {diag.tpmPacingDecision && (
                    <span className="tag" style={{ marginLeft: 4 }}>pace: {displayCloneAlias(diag.tpmPacingDecision)}</span>
                  )}
                  {diag.internalErrorCircuit && (
                    <span className="badge err" style={{ marginLeft: 4 }}>internal circuit</span>
                  )}
                  {diag.hashIgnoreApplied && Array.isArray(diag.hashIgnoreHits) && diag.hashIgnoreHits.length > 0 && (
                    <span className="tag" style={{ marginLeft: 4 }}>hash-ignore: {diag.hashIgnoreHits.length}</span>
                  )}
                  {diag.neededSource && (
                    <span className="tag" style={{ marginLeft: 4 }}>
                      needed: {formatTokens(diag.neededTokens)} ({diag.neededSource})
                    </span>
                  )}
                  {Number(diag.estimatedImageCount) > 0 && (
                    <span className="tag" style={{ marginLeft: 4 }}>images: {diag.estimatedImageCount}</span>
                  )}
                </div>

                {log.model && (
                  <div className="meta-item">
                    <span className="meta-label">🤖 模型:</span>
                    <span className="meta-val mono">{log.model}</span>
                  </div>
                )}
              </div>

              {(log.error_message || isError || isRateLimited) && (
                <div className="log-error-box">
                  <div className="error-title">
                    ⚠️ 错误码: <b>{log.error_code || (isRateLimited ? 'RESOURCE_EXHAUSTED' : 'UNKNOWN')}</b> (HTTP {log.upstream_response_status || 500})
                  </div>
                  <div className="error-msg">{log.error_message || '上游返回异常'}</div>
                </div>
              )}

              {isExpanded && (
                <div className="log-card-bodies">
                  <div className="payload-box">
                    <div className="payload-head">
                      <span>📤 下游请求体 (客户端 → 网关)</span>
                      <button
                        className="btn btn-sm"
                        onClick={(e) => { e.stopPropagation(); handleCopy(safeJson(log.downstream_request_json), 'down_' + log.request_id); }}
                      >
                        {copiedId === ('down_' + log.request_id) ? '✓ 已复制' : '复制'}
                      </button>
                    </div>
                    <pre className="payload-code">
                      {safeJson(log.downstream_request_json) || '(空)'}
                    </pre>
                  </div>

                  <div className="payload-box">
                    <div className="payload-head">
                      <span>📡 上游请求体 (网关 → Google Interactions)</span>
                      <button
                        className="btn btn-sm"
                        onClick={(e) => { e.stopPropagation(); handleCopy(safeJson(log.upstream_request_json), 'up_req_' + log.request_id); }}
                      >
                        {copiedId === ('up_req_' + log.request_id) ? '✓ 已复制' : '复制'}
                      </button>
                    </div>
                    <pre className="payload-code">
                      {safeJson(log.upstream_request_json) || '(未记录上游请求体)'}
                    </pre>
                  </div>

                  <div className="payload-box">
                    <div className="payload-head">
                      <span>📥 上游响应体 (Google Interactions → 网关)</span>
                      <button
                        className="btn btn-sm"
                        onClick={(e) => { e.stopPropagation(); handleCopy(safeJson(log.upstream_response_json), 'up_res_' + log.request_id); }}
                      >
                        {copiedId === ('up_res_' + log.request_id) ? '✓ 已复制' : '复制'}
                      </button>
                    </div>
                    <pre className="payload-code">
                      {safeJson(log.upstream_response_json) || (log.error_message ? ('(错误: ' + log.error_message + ')') : '(空响应)')}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {totalPages > 1 && (
        <div className="log-pagination">
          <button
            className="btn btn-sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ◀ 上一页
          </button>
          <span className="page-indicator">第 {page} / {totalPages} 页</span>
          <button
            className="btn btn-sm"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            下一页 ▶
          </button>
        </div>
      )}
    </div>
  );
}
