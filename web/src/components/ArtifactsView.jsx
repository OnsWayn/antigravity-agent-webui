export default function ArtifactsView({
  provider, setProvider, forceRefresh, setForceRefresh,
  zipWorkspace, filePath, setFilePath, fetchFile, fileStatus, artifacts, setTab
}) {
  return (
    <>
      <section className="box">
        <div className="box-head">📦 打包整个 /workspace</div>
        <select className="select" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="snapshot">官方环境快照</option>
          <option value="chunked">Base64 分块</option>
          <option value="fileio">file.io</option>
          <option value="catbox">catbox</option>
        </select>
        <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={forceRefresh} onChange={(e) => setForceRefresh(e.target.checked)} /><span>强制刷新快照</span></label>
        <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={zipWorkspace}>打包并下载</button>
      </section>

      <section className="box">
        <div className="box-head">📁 按路径提取沙盒文件</div>
        <div className="row">
          <input className="input mono grow" value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="/workspace/file.svg" />
          <button className="btn" onClick={() => fetchFile()}>提取</button>
        </div>
        {fileStatus?.pending && <p className="hint">{fileStatus.pending}</p>}
        {fileStatus?.error && <p className="status-bad">{fileStatus.error}</p>}
        {fileStatus?.ok && (
          <div style={{ marginTop: 8 }}>
            <p className="status-ok">已提取 {fileStatus.filename} {fileStatus.cache ? ('(缓存 ' + fileStatus.cache + ')') : ''}</p>
            {fileStatus.archivePath && <p className="hint mono">{fileStatus.archivePath}</p>}
            {fileStatus.url && <a className="btn btn-sm" href={fileStatus.url} target="_blank" rel="noreferrer">打开直链</a>}
            {fileStatus.onDownload && <button className="btn btn-sm" onClick={fileStatus.onDownload}>保存本地</button>}
          </div>
        )}
      </section>

      <section className="box">
        <div className="box-head">🔍 输出中检测到的文件路径</div>
        {artifacts.length === 0 && <p className="hint">还没有检测到 /workspace 文件。</p>}
        {artifacts.map((path) => (
          <div className="gateway-row" key={path}>
            <span className="mono">{path}</span>
            <button className="btn btn-sm" onClick={() => { setFilePath(path); fetchFile(path); }}>提取</button>
          </div>
        ))}
      </section>
    </>
  );
}
