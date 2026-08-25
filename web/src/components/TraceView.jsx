import { renderMarkdown } from '../lib';

export default function TraceView({ output, steps = [], running, json }) {
  if (!output && !running) {
    return (
      <div className="empty">
        <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.3 }}>🚀</div>
        <h3>等待沙盒任务</h3>
        <p>在左侧输入任务描述并提交，Agent 将在 Google 远程 Linux 沙盒中执行。执行轨迹和最终输出会实时显示在这里。</p>
      </div>
    );
  }

  return (
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
        <div className="box-head">⚡ 执行步骤与工具调用</div>
        {(steps || []).map((step, index) => (
          <div className="step" key={step.id || index}>
            <div className="step-h">#{index + 1} {step.type || 'step'}</div>
            <pre className="step-body">{json(step)}</pre>
          </div>
        ))}
      </section>
    </>
  );
}
