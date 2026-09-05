import { APP_VERSION, pageHash } from '../lib';

export default function DashboardView({
  gatewayStatus,
  upstreamKeys = [],
  clientTokens = [],
  sessions = [],
  setPage,
  sandboxKeyId
}) {
  const activeKeys = upstreamKeys.filter((key) => key.enabled);
  const selected = activeKeys.find((key) => key.id === sandboxKeyId);

  function go(id) {
    setPage(id);
    window.location.hash = pageHash(id);
  }

  return (
    <div className="dashboard-grid">
      <section className="box">
        <div className="box-head">Antigravity Studio v{APP_VERSION}</div>
        <p>管理后台采用<strong>侧边栏 App Shell + 功能分页</strong>：左侧固定导航，右侧一页一个能力。协议网关的 TPM / clone / fork 只作用于 <code>/v1</code> 下游流量；网页沙盒任务在本页选 Key 后直连 Interactions。</p>
      </section>

      <div className="dash-cards">
        <button className="dash-card" onClick={() => go('gateway')}>
          <span className="hint">协议网关</span>
          <b>{gatewayStatus?.enabled ? '运行中' : '已关闭'}</b>
          <span className="hint">MASTER_KEY {gatewayStatus?.configured ? '已配置' : '未配置'}</span>
        </button>
        <button className="dash-card" onClick={() => go('keys')}>
          <span className="hint">上游 Key</span>
          <b>{activeKeys.length}/{upstreamKeys.length}</b>
          <span className="hint">已启用 / 全部</span>
        </button>
        <button className="dash-card" onClick={() => go('tokens')}>
          <span className="hint">下游 Token</span>
          <b>{clientTokens.length}</b>
          <span className="hint">已发行凭证</span>
        </button>
        <button className="dash-card" onClick={() => go('sandbox')}>
          <span className="hint">沙盒会话</span>
          <b>{sessions.length}</b>
          <span className="hint">{selected ? `当前 Key ${selected.name}` : '尚未选择网页提交 Key'}</span>
        </button>
      </div>

      <section className="box">
        <div className="box-head">快捷入口</div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="btn" onClick={() => go('sandbox')}>提交沙盒任务</button>
          <button className="btn" onClick={() => go('keys')}>管理上游 Key</button>
          <button className="btn" onClick={() => go('tokens')}>发行下游 Token</button>
          <button className="btn" onClick={() => go('logs')}>查看请求日志</button>
          <button className="btn" onClick={() => go('settings')}>运行设置</button>
        </div>
      </section>

      <section className="box">
        <div className="box-head">最近沙盒会话</div>
        {sessions.length === 0 && <p className="hint">还没有网页沙盒会话。到「沙盒任务」提交一次即可。</p>}
        {sessions.slice(0, 6).map((session) => (
          <div className="gateway-row" key={session.id}>
            <div>
              <b>{session.name || session.envId}</b>
              <div className="hint mono">{session.envId}</div>
            </div>
            <button className="btn btn-sm" onClick={() => go('sandbox')}>打开</button>
          </div>
        ))}
      </section>
    </div>
  );
}
