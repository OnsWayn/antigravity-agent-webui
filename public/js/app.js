function safeGetStorage(key, defaultVal = '') {
    try {
      return localStorage.getItem(key) ?? defaultVal;
    } catch (e) {
      console.warn(`[Storage Warning] Cannot read '${key}' from localStorage:`, e);
      return defaultVal;
    }
  }

  function safeSetStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn(`[Storage Warning] Cannot write '${key}' to localStorage:`, e);
    }
  }

  function safeRemoveStorage(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn(`[Storage Warning] Cannot remove '${key}' from localStorage:`, e);
    }
  }

function initApp() {
  // Global State
  let apiKey = safeGetStorage('antigravity_gemini_api_key', '');
  let activeEnvironmentId = '';
  let lastInteractionId = '';
  let activeSessionId = null;
  let uploadedImageBase64 = null;
  let uploadedImageMime = null;
  let sourcesCount = 0;
  let lastRequestPayload = null;

  // Legacy browser sessions are loaded once and migrated to SQLite below.
  let savedSessions = [];
  try {
    const rawSess = safeGetStorage('antigravity_sessions', '');
    savedSessions = rawSess ? JSON.parse(rawSess) : [];
  } catch (e) {
    savedSessions = [];
  }
  const legacySessions = savedSessions.slice();

  // DOM Elements - Key & Modal
  const apiKeyBadge = document.getElementById('apiKeyBadge');
  const openApiKeyModalBtn = document.getElementById('openApiKeyModalBtn');
  const apiKeyModal = document.getElementById('apiKeyModal');
  const closeApiKeyModalBtn = document.getElementById('closeApiKeyModalBtn');
  const cancelApiKeyBtn = document.getElementById('cancelApiKeyBtn');
  const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
  const modalApiKeyInput = document.getElementById('modalApiKeyInput');

  // DOM Elements - Proxy Settings
  const useProxyCheckbox = document.getElementById('useProxyCheckbox');
  const proxyUrlGroup = document.getElementById('proxyUrlGroup');
  const proxyUrlInput = document.getElementById('proxyUrlInput');

  // DOM Elements - Sessions Management
  const btnCreateNewSession = document.getElementById('btnCreateNewSession');
  const btnCreateSessionInEnvironment = document.getElementById('btnCreateSessionInEnvironment');
  const sessionsListContainer = document.getElementById('sessionsListContainer');

  // DOM Elements - Environment & Setup
  const envModeRadios = document.querySelectorAll('input[name="envMode"]');
  const envIdGroup = document.getElementById('envIdGroup');
  const envIdInput = document.getElementById('envIdInput');
  const copyEnvIdBtn = document.getElementById('copyEnvIdBtn');
  const reuseFreshSessionCheckbox = document.getElementById('reuseFreshSessionCheckbox');
  const sourcesContainer = document.getElementById('sourcesContainer');
  const addSourceBtn = document.getElementById('addSourceBtn');

  // DOM Elements - Model & Tools
  const modelSelect = document.getElementById('modelSelect');
  const maxTokensInput = document.getElementById('maxTokensInput');
  const toolCodeExec = document.getElementById('toolCodeExec');
  const toolGoogleSearch = document.getElementById('toolGoogleSearch');
  const toolUrlContext = document.getElementById('toolUrlContext');
  const mcpToggleBtn = document.getElementById('mcpToggleBtn');
  const mcpBody = document.getElementById('mcpBody');
  const mcpName = document.getElementById('mcpName');
  const mcpUrl = document.getElementById('mcpUrl');

  // DOM Elements - Task Input & Presets
  const taskInput = document.getElementById('taskInput');
  const uploadImageBtn = document.getElementById('uploadImageBtn');
  const imageFileInput = document.getElementById('imageFileInput');
  const imagePreviewContainer = document.getElementById('imagePreviewContainer');
  const imagePreview = document.getElementById('imagePreview');
  const removeImageBtn = document.getElementById('removeImageBtn');
  const runTaskBtn = document.getElementById('runTaskBtn');
  const presetBtns = document.querySelectorAll('.pill-btn');

  // DOM Elements - Workspace & Results
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const taskStatusBadge = document.getElementById('taskStatusBadge');
  const statTokens = document.getElementById('statTokens');
  const statEnvId = document.getElementById('statEnvId');
  const emptyStateTrace = document.getElementById('emptyStateTrace');
  const traceContainer = document.getElementById('traceContainer');
  const finalOutputText = document.getElementById('finalOutputText');
  const stepsList = document.getElementById('stepsList');
  const copyOutputBtn = document.getElementById('copyOutputBtn');

  // DOM Elements - Artifact Downloader
  const fetchFilePathInput = document.getElementById('fetchFilePathInput');
  const fetchFileBtn = document.getElementById('fetchFileBtn');
  const fetchFileStatus = document.getElementById('fetchFileStatus');
  const detectedArtifactsList = document.getElementById('detectedArtifactsList');
  const btnZipWorkspace = document.getElementById('btnZipWorkspace');
  const transferProviderSelect = document.getElementById('transferProviderSelect');
  const forceRefreshSnapshotCheckbox = document.getElementById('forceRefreshSnapshotCheckbox');

  // DOM Elements - Debug Logs
  const debugLogsViewer = document.getElementById('debugLogsViewer');
  const clearLogsBtn = document.getElementById('clearLogsBtn');
  const copyLogsBtn = document.getElementById('copyLogsBtn');

  // DOM Elements - Error Inspector Modal
  const errorModal = document.getElementById('errorModal');
  const closeErrorModalBtn = document.getElementById('closeErrorModalBtn');
  const dismissErrorModalBtn = document.getElementById('dismissErrorModalBtn');
  const switchLogsTabBtn = document.getElementById('switchLogsTabBtn');
  const errorModalOverview = document.getElementById('errorModalOverview');
  const errorModalRequest = document.getElementById('errorModalRequest');
  const errorModalRaw = document.getElementById('errorModalRaw');

  // Logging Utility
  function appendDebugLog(level, message, details = null) {
    const timestamp = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.className = `log-entry log-${level}`;

    let detailsStr = '';
    if (details) {
      try {
        detailsStr = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
      } catch (e) {
        detailsStr = String(details);
      }
    }

    div.innerHTML = `[${timestamp}] [${level.toUpperCase()}] ${escapeHtml(message)} ${detailsStr ? `<pre style="margin-top:4px; opacity:0.9;">${escapeHtml(detailsStr)}</pre>` : ''}`;
    debugLogsViewer.appendChild(div);
    debugLogsViewer.scrollTop = debugLogsViewer.scrollHeight;

    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${timestamp}] ${message}`, details || '');
  }

  // Text Extraction Safeguard
  function extractOutputText(data) {
    if (data.output_text && data.output_text.trim()) {
      return data.output_text;
    }

    const textParts = [];
    if (data.steps && Array.isArray(data.steps)) {
      for (const step of data.steps) {
        if (step.type === 'model_output' || step.type === 'output') {
          if (Array.isArray(step.content)) {
            for (const item of step.content) {
              if (item.type === 'text' && item.text) {
                textParts.push(item.text);
              } else if (typeof item === 'string') {
                textParts.push(item);
              }
            }
          } else if (typeof step.content === 'string') {
            textParts.push(step.content);
          } else if (step.text) {
            textParts.push(step.text);
          }
        }
      }
    }

    return textParts.join('\n\n') || '';
  }

  // Initialize Proxy Controls
  const storedUseProxy = safeGetStorage('antigravity_use_proxy', 'false') === 'true';
  const storedProxyUrl = safeGetStorage('antigravity_proxy_url', 'http://127.0.0.1:10808');

  useProxyCheckbox.checked = storedUseProxy;
  proxyUrlInput.value = storedProxyUrl;
  proxyUrlGroup.style.display = storedUseProxy ? 'block' : 'none';

  useProxyCheckbox.addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    proxyUrlGroup.style.display = isChecked ? 'block' : 'none';
    safeSetStorage('antigravity_use_proxy', isChecked);
    appendDebugLog('info', `网络代理设置: ${isChecked ? '开启 (' + proxyUrlInput.value + ')' : '关闭'}`);
  });

  proxyUrlInput.addEventListener('change', () => {
    safeSetStorage('antigravity_proxy_url', proxyUrlInput.value.trim());
  });

  // Initialize UI
  updateApiKeyBadge();
  renderSessionsList();
  appendDebugLog('info', 'Antigravity Agent Web UI 已就绪。目标 API: antigravity-preview-05-2026');
  void hydrateSessionsFromDatabase();

  // 1. API Key Modal Management
  openApiKeyModalBtn.addEventListener('click', () => {
    modalApiKeyInput.value = apiKey;
    apiKeyModal.style.display = 'flex';
  });

  const closeModal = () => { apiKeyModal.style.display = 'none'; };
  closeApiKeyModalBtn.addEventListener('click', closeModal);
  cancelApiKeyBtn.addEventListener('click', closeModal);

  saveApiKeyBtn.addEventListener('click', () => {
    const val = modalApiKeyInput.value.trim();
    apiKey = val;
    safeSetStorage('antigravity_gemini_api_key', apiKey);
    updateApiKeyBadge();
    appendDebugLog('info', 'API Key 已保存');
    closeModal();
  });

  function updateApiKeyBadge() {
    if (apiKey) {
      apiKeyBadge.querySelector('.status-dot').className = 'status-dot success';
      apiKeyBadge.querySelector('.status-text').textContent = 'API Key 已设置';
    } else {
      apiKeyBadge.querySelector('.status-dot').className = 'status-dot warning';
      apiKeyBadge.querySelector('.status-text').textContent = '未设置 API Key';
    }
  }

  // 2. Sessions Management & Nested Turns Logic
  let expandedSessions = new Set();

  async function hydrateSessionsFromDatabase() {
    try {
      if (legacySessions.length > 0) {
        const importResponse = await fetch('/api/sessions/import', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessions: legacySessions })
        });
        const importResult = await importResponse.json();
        if (!importResponse.ok || !importResult.success) {
          throw new Error(importResult.error?.message || '旧会话迁移失败');
        }
      }

      await refreshSessionsFromDatabase();
      if (legacySessions.length > 0) {
        safeRemoveStorage('antigravity_sessions');
        appendDebugLog('success', `已将 ${legacySessions.length} 个浏览器历史会话迁移至本地 SQLite 数据库`);
      } else {
        appendDebugLog('info', '会话记录已从本地 SQLite 数据库加载');
      }
    } catch (error) {
      appendDebugLog('warn', `数据库暂时不可用，保留当前页面中的会话记录: ${error.message}`);
    }
  }

  async function refreshSessionsFromDatabase() {
    const response = await fetch('/api/sessions', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || !result.success || !Array.isArray(result.sessions)) {
      throw new Error(result.error?.message || '读取会话数据库失败');
    }
    savedSessions = result.sessions;
    renderSessionsList();
  }

  function renderSessionsList() {
    sessionsListContainer.innerHTML = '';

    if (savedSessions.length === 0) {
      sessionsListContainer.innerHTML = '<div class="empty-hint">暂无保存的沙盒会话。发起代理任务后会自动归档到会话列表。</div>';
      return;
    }

    savedSessions.forEach((sess) => {
      if (!sess || typeof sess !== 'object') return;
      const isExpanded = expandedSessions.has(sess.id);
      const turns = sess.turns && sess.turns.length > 0 ? sess.turns : [
        {
          interactionId: sess.lastInteractionId,
          prompt: sess.lastPrompt,
          outputText: sess.lastOutput,
          steps: sess.steps,
          timestamp: sess.updatedAt
        }
      ];

      const item = document.createElement('div');
      item.className = `session-card ${activeSessionId === sess.id ? 'active' : ''}`;
      item.dataset.id = sess.id;

      const dateStr = new Date(sess.updatedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      item.innerHTML = `
        <div class="session-header" onclick="window.switchSession('${sess.id}')">
          <div class="session-title-box">
            <button type="button" class="btn-icon btn-toggle-expand" onclick="event.stopPropagation(); window.toggleSessionExpand('${sess.id}')" title="展开/收起此会话下的轮次">
              <span class="material-symbols-outlined" style="font-size: 18px;">${isExpanded ? 'expand_more' : 'chevron_right'}</span>
            </button>
            <div class="session-info">
              <div class="session-title-line">
                <span class="session-title">${escapeHtml(sess.name || sess.envId)}</span>
                <span class="badge-turns">${turns.length}轮交互</span>
              </div>
              <span class="session-env mono">${escapeHtml(sess.envId)}</span>
            </div>
          </div>
          <div class="session-actions">
            <span class="session-time">${dateStr}</span>
            <button type="button" class="btn-delete-session" onclick="event.stopPropagation(); window.deleteSession('${sess.id}')" title="删除该会话">
              <span class="material-symbols-outlined" style="font-size: 16px;">delete</span>
            </button>
          </div>
        </div>

        <div class="session-turns-list" style="display: ${isExpanded ? 'flex' : 'none'};">
          ${turns.map((turn, tIdx) => {
            const shortId = turn.interactionId ? turn.interactionId.slice(-8) : `T${tIdx+1}`;
            const isTurnActive = (activeSessionId === sess.id && lastInteractionId === turn.interactionId);
            const rawSnippet = turn.outputText ? turn.outputText.trim().replace(/\s+/g, ' ') : '(无响应文本)';
            const truncatedSnippet = rawSnippet.length > 70 ? rawSnippet.slice(0, 70) + '...' : rawSnippet;
            const promptSnippet = turn.prompt ? (turn.prompt.length > 35 ? turn.prompt.slice(0, 35) + '...' : turn.prompt) : '';

            return `
              <div class="turn-item ${isTurnActive ? 'active' : ''}" onclick="event.stopPropagation(); window.viewTurnDetails('${sess.id}', ${tIdx})">
                <div class="turn-header">
                  <span class="turn-tag">#${tIdx + 1} 轮</span>
                  <span class="turn-id mono" title="${turn.interactionId}">${shortId}</span>
                </div>
                ${promptSnippet ? `<div class="turn-prompt">💬 ${escapeHtml(promptSnippet)}</div>` : ''}
                <div class="turn-output">🤖 ${escapeHtml(truncatedSnippet)}</div>
              </div>
            `;
          }).join('')}
        </div>
      `;

      sessionsListContainer.appendChild(item);
    });
  }

  window.toggleSessionExpand = function(sessionId) {
    if (expandedSessions.has(sessionId)) {
      expandedSessions.delete(sessionId);
    } else {
      expandedSessions.add(sessionId);
    }
    renderSessionsList();
  };

  function saveSessionTurn(sessionId, envId, turnData) {
    // turnData: { interactionId, prompt, outputText, steps, timestamp }
    let session = savedSessions.find(s => s.id === sessionId);
    if (!session) {
      session = {
        id: sessionId,
        name: `会话 ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        envId: envId,
        lastInteractionId: turnData.interactionId,
        lastPrompt: turnData.prompt,
        lastOutput: turnData.outputText,
        steps: turnData.steps,
        turns: [],
        updatedAt: Date.now()
      };
      savedSessions.unshift(session);
      expandedSessions.add(sessionId); // Auto-expand newly created session
    }

    if (!session.turns) {
      session.turns = [];
      if (session.lastInteractionId) {
        session.turns.push({
          interactionId: session.lastInteractionId,
          prompt: session.lastPrompt,
          outputText: session.lastOutput,
          steps: session.steps,
          timestamp: session.updatedAt || Date.now()
        });
      }
    }

    const existingTurnIdx = session.turns.findIndex(t => t.interactionId === turnData.interactionId);
    if (existingTurnIdx >= 0) {
      session.turns[existingTurnIdx] = { ...session.turns[existingTurnIdx], ...turnData };
    } else {
      session.turns.push(turnData);
    }

    session.lastInteractionId = turnData.interactionId;
    session.lastPrompt = turnData.prompt;
    session.lastOutput = turnData.outputText;
    session.steps = turnData.steps;
    session.updatedAt = Date.now();

    renderSessionsList();
    void refreshSessionsFromDatabase().catch(error => {
      appendDebugLog('warn', `刷新数据库会话列表失败: ${error.message}`);
    });
  }

  window.switchSession = function(sessionId) {
    const session = savedSessions.find(s => s.id === sessionId);
    if (!session) return;

    activeSessionId = session.id;
    activeEnvironmentId = session.envId;
    
    // Pick the last interactionId in this session to ensure seamless turn continuation!
    const turns = session.turns || [];
    if (turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      lastInteractionId = lastTurn.interactionId || session.lastInteractionId || '';
    } else {
      lastInteractionId = session.lastInteractionId || '';
    }

    // Switch Environment mode to "reuse"
    document.querySelector('input[name="envMode"][value="reuse"]').checked = true;
    envIdGroup.style.display = 'block';
    envIdInput.value = session.envId;
    if (reuseFreshSessionCheckbox) reuseFreshSessionCheckbox.checked = false;
    if (btnCreateSessionInEnvironment) btnCreateSessionInEnvironment.disabled = false;

    statEnvId.textContent = session.envId;

    // Render workspace output of last turn
    emptyStateTrace.style.display = 'none';
    traceContainer.style.display = 'block';

    const renderText = session.lastOutput || '<em>(该沙盒会话中尚无文本输出)</em>';
    finalOutputText.innerHTML = renderMarkdown(renderText);
    detectArtifactsFromText(renderText);

    // Render Steps
    stepsList.innerHTML = '';
    if (session.steps && Array.isArray(session.steps)) {
      session.steps.forEach((step, idx) => {
        const stepDiv = document.createElement('div');
        stepDiv.className = 'step-item';
        stepDiv.innerHTML = `
          <div class="step-header">
            <span class="step-type">步骤 #${idx + 1} - ${step.type || 'EXECUTION'}</span>
            <span>${step.id || ''}</span>
          </div>
          <div class="step-body">${escapeHtml(JSON.stringify(step, null, 2))}</div>
        `;
        stepsList.appendChild(stepDiv);
      });
    }

    renderSessionsList();
    appendDebugLog('info', `已切换至沙盒会话: ${session.envId} [衔接 Interaction ID: ${lastInteractionId || 'None'}]`);
  };

  window.viewTurnDetails = function(sessionId, turnIndex) {
    const session = savedSessions.find(s => s.id === sessionId);
    if (!session || !session.turns || !session.turns[turnIndex]) return;

    const turn = session.turns[turnIndex];

    activeSessionId = session.id;
    activeEnvironmentId = session.envId;
    lastInteractionId = turn.interactionId || session.lastInteractionId || '';

    // Switch Environment mode to "reuse"
    document.querySelector('input[name="envMode"][value="reuse"]').checked = true;
    envIdGroup.style.display = 'block';
    envIdInput.value = session.envId;
    if (reuseFreshSessionCheckbox) reuseFreshSessionCheckbox.checked = false;
    if (btnCreateSessionInEnvironment) btnCreateSessionInEnvironment.disabled = false;
    statEnvId.textContent = session.envId;

    emptyStateTrace.style.display = 'none';
    traceContainer.style.display = 'block';

    const renderText = turn.outputText || '<em>(该轮次无直接文本响应)</em>';
    finalOutputText.innerHTML = renderMarkdown(renderText);
    detectArtifactsFromText(renderText);

    stepsList.innerHTML = '';
    if (turn.steps && Array.isArray(turn.steps)) {
      turn.steps.forEach((step, idx) => {
        const stepDiv = document.createElement('div');
        stepDiv.className = 'step-item';
        stepDiv.innerHTML = `
          <div class="step-header">
            <span class="step-type">步骤 #${idx + 1} - ${step.type || 'EXECUTION'}</span>
            <span>${step.id || ''}</span>
          </div>
          <div class="step-body">${escapeHtml(JSON.stringify(step, null, 2))}</div>
        `;
        stepsList.appendChild(stepDiv);
      });
    }

    renderSessionsList();
    appendDebugLog('info', `已查看沙盒会话 [${session.envId}] 第 #${turnIndex + 1} 轮交互 (ID: ${turn.interactionId})`);
  };

  window.deleteSession = async function(sessionId) {
    const previousSessions = savedSessions;
    savedSessions = savedSessions.filter(s => s.id !== sessionId);
    expandedSessions.delete(sessionId);

    if (activeSessionId === sessionId) {
      activeSessionId = null;
      activeEnvironmentId = '';
      lastInteractionId = '';
      document.querySelector('input[name="envMode"][value="new"]').checked = true;
      envIdGroup.style.display = 'none';
      envIdInput.value = '';
      if (btnCreateSessionInEnvironment) btnCreateSessionInEnvironment.disabled = true;
      statEnvId.textContent = 'None';
      emptyStateTrace.style.display = 'block';
      traceContainer.style.display = 'none';
    }

    renderSessionsList();
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        cache: 'no-store'
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error?.message || '数据库删除失败');
      }
      appendDebugLog('info', `已从数据库删除会话: ${sessionId}`);
    } catch (error) {
      savedSessions = previousSessions;
      renderSessionsList();
      appendDebugLog('error', `删除会话失败，已恢复页面记录: ${error.message}`);
    }
  };

  btnCreateNewSession.addEventListener('click', () => {
    activeSessionId = null;
    activeEnvironmentId = '';
    lastInteractionId = '';

    document.querySelector('input[name="envMode"][value="new"]').checked = true;
    envIdGroup.style.display = 'none';
    envIdInput.value = '';
    if (reuseFreshSessionCheckbox) reuseFreshSessionCheckbox.checked = false;
    if (btnCreateSessionInEnvironment) btnCreateSessionInEnvironment.disabled = true;
    statEnvId.textContent = 'None';
    taskInput.value = '';

    emptyStateTrace.style.display = 'block';
    traceContainer.style.display = 'none';

    renderSessionsList();
    appendDebugLog('info', '已重置为新沙盒、新会话状态');
  });

  btnCreateSessionInEnvironment.addEventListener('click', () => {
    const targetEnvironmentId = activeEnvironmentId || envIdInput.value.trim();
    if (!targetEnvironmentId) {
      alert('请先选择一个已有会话或填写 Environment ID。');
      return;
    }
    activeEnvironmentId = targetEnvironmentId;
    activeSessionId = null;
    lastInteractionId = '';
    document.querySelector('input[name="envMode"][value="reuse"]').checked = true;
    envIdGroup.style.display = 'block';
    envIdInput.value = targetEnvironmentId;
    if (reuseFreshSessionCheckbox) reuseFreshSessionCheckbox.checked = true;
    taskInput.value = '';
    emptyStateTrace.style.display = 'block';
    traceContainer.style.display = 'none';
    renderSessionsList();
    appendDebugLog('info', `将在沙盒 ${targetEnvironmentId} 中创建不继承旧上下文的新会话`);
  });

  // Environment Mode Radios
  envModeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      if (e.target.value === 'reuse') {
        envIdGroup.style.display = 'block';
        if (btnCreateSessionInEnvironment) btnCreateSessionInEnvironment.disabled = !envIdInput.value.trim();
      } else {
        envIdGroup.style.display = 'none';
        if (reuseFreshSessionCheckbox) reuseFreshSessionCheckbox.checked = false;
        if (btnCreateSessionInEnvironment) btnCreateSessionInEnvironment.disabled = true;
      }
    });
  });

  envIdInput.addEventListener('input', () => {
    if (btnCreateSessionInEnvironment) btnCreateSessionInEnvironment.disabled = !envIdInput.value.trim();
  });

  copyEnvIdBtn.addEventListener('click', () => {
    if (envIdInput.value) {
      navigator.clipboard.writeText(envIdInput.value);
      alert('Environment ID 已复制到剪贴板！');
    }
  });

  // Sources Injector
  addSourceBtn.addEventListener('click', () => {
    sourcesCount++;
    const sourceId = `source_${sourcesCount}`;
    const div = document.createElement('div');
    div.className = 'card margin-top';
    div.style.padding = '10px';
    div.id = sourceId;
    div.innerHTML = `
      <div class="label-with-action" style="margin-bottom: 6px;">
        <span style="font-size: 0.8rem; font-weight: 600;">注入文件 #${sourcesCount}</span>
        <button type="button" class="btn-text" style="color: var(--accent-danger);" onclick="document.getElementById('${sourceId}').remove()">移除</button>
      </div>
      <input type="text" placeholder="/workspace/data.txt" class="form-control mono source-target" style="margin-bottom: 6px;">
      <textarea placeholder="文件内容..." class="form-control mono source-content" rows="2"></textarea>
    `;
    sourcesContainer.appendChild(div);
  });

  // Collapsible MCP section
  mcpToggleBtn.addEventListener('click', () => {
    const isHidden = mcpBody.style.display === 'none';
    mcpBody.style.display = isHidden ? 'block' : 'none';
    mcpToggleBtn.querySelector('.icon-arrow').textContent = isHidden ? 'expand_less' : 'expand_more';
  });

  // Preset Prompts
  const PRESETS = {
    news: '请在远程 Linux 沙盒中检索最新的 Hacker News 或 Google News AI 科技要闻，总结前 10 条热门资讯，并在 /workspace 目录中生成一份格式排版精美的 PDF 报告文件 (如 /workspace/ai_news_summary.pdf)。',
    data: '请在沙盒中编写 Python 脚本，创建一个包含 100 条模拟销售数据的 Pandas DataFrame，计算平均值与月度趋势，使用 Matplotlib / Seaborn 绘制柱状图保存至 /workspace/sales_chart.png，并将分析结论写入 /workspace/report.txt。',
    code: '请在沙盒中建立一个轻量级 Node.js Express 后端框架项目（位于 /workspace/my_server 目录），安装 express 依赖并编写 index.js 提供一个GET /api/health 接口，最后运行 `node -v` 和 `npm -v` 验证沙盒环境。'
  };

  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const presetKey = btn.dataset.preset;
      if (PRESETS[presetKey]) {
        taskInput.value = PRESETS[presetKey];
        appendDebugLog('info', `已加载预设模版: ${presetKey}`);
      }
    });
  });

  // Multimodal Image Upload
  uploadImageBtn.addEventListener('click', () => imageFileInput.click());

  imageFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    uploadedImageMime = file.type;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const dataUrl = evt.target.result;
      imagePreview.src = dataUrl;
      imagePreviewContainer.style.display = 'block';
      uploadedImageBase64 = dataUrl.split(',')[1];
      appendDebugLog('info', `图片附件已加载: ${file.name}`);
    };
    reader.readAsDataURL(file);
  });

  removeImageBtn.addEventListener('click', () => {
    uploadedImageBase64 = null;
    uploadedImageMime = null;
    imageFileInput.value = '';
    imagePreviewContainer.style.display = 'none';
    imagePreview.src = '';
    appendDebugLog('info', '已移除图片附件');
  });

  // Tab Navigation
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const targetTab = btn.dataset.tab;
      if (targetTab === 'trace') document.getElementById('tabTrace').classList.add('active');
      if (targetTab === 'artifacts') document.getElementById('tabArtifacts').classList.add('active');
      if (targetTab === 'logs') document.getElementById('tabLogs').classList.add('active');
      if (targetTab === 'docs') document.getElementById('tabDocs').classList.add('active');
    });
  });

  // Run Task Submission
  runTaskBtn.addEventListener('click', async () => {
    try {
      if (!apiKey) {
        alert('请先配置 GEMINI API Key！');
        if (openApiKeyModalBtn) openApiKeyModalBtn.click();
        return;
      }

      const textPrompt = taskInput ? taskInput.value.trim() : '';
      if (!textPrompt) {
        alert('请输入任务 Prompt 指令！');
        return;
      }

      const tools = [];
      if (toolCodeExec && toolCodeExec.checked) tools.push({ type: 'code_execution' });
      if (toolGoogleSearch && toolGoogleSearch.checked) tools.push({ type: 'google_search' });
      if (toolUrlContext && toolUrlContext.checked) tools.push({ type: 'url_context' });

      if (mcpName && mcpUrl && mcpName.value.trim() && mcpUrl.value.trim()) {
        tools.push({
          type: 'mcp_server',
          name: mcpName.value.trim().toLowerCase(),
          url: mcpUrl.value.trim()
        });
      }

      let inputPayload = textPrompt;
      if (uploadedImageBase64) {
        inputPayload = [
          { type: 'text', text: textPrompt },
          { type: 'image', mime_type: uploadedImageMime, data: uploadedImageBase64 }
        ];
      }

      const envModeRadio = document.querySelector('input[name="envMode"]:checked');
      const envMode = envModeRadio ? envModeRadio.value : 'new';
      let envPayload = 'remote';
      let prevIdToUse = undefined;
      let localSessionIdToUse = undefined;
      let startNewSession = envMode === 'new';

      if (envMode === 'reuse') {
        const targetEnvId = (envIdInput ? envIdInput.value.trim() : '') || activeEnvironmentId;
        if (targetEnvId) {
          envPayload = targetEnvId;
          startNewSession = Boolean(reuseFreshSessionCheckbox && reuseFreshSessionCheckbox.checked);
          if (!startNewSession) {
            const activeSession = savedSessions.find(s => s.id === activeSessionId && s.envId === targetEnvId);
            const targetSession = activeSession || savedSessions.find(s => s.envId === targetEnvId);
            localSessionIdToUse = targetSession?.id || activeSessionId || undefined;
            if (targetSession && targetSession.lastInteractionId) {
              prevIdToUse = targetSession.lastInteractionId;
            } else if (lastInteractionId) {
              prevIdToUse = lastInteractionId;
            }
          }
        }
      } else {
        // NEW environment -> MUST NOT pass previousInteractionId!
        prevIdToUse = undefined;
        const sources = [];
        const sourceTargets = document.querySelectorAll('.source-target');
        const sourceContents = document.querySelectorAll('.source-content');
        sourceTargets.forEach((input, idx) => {
          const target = input.value.trim();
          const content = sourceContents[idx] ? sourceContents[idx].value : '';
          if (target && content) {
            sources.push({ target, content });
          }
        });
        if (sources.length > 0) {
          envPayload = { type: 'remote', sources };
        }
      }

      const requestBody = {
        agent: 'antigravity-preview-05-2026',
        input: inputPayload,
        environment: envPayload,
        model: modelSelect ? modelSelect.value : 'gemini-3.6-flash',
        maxTotalTokens: (maxTokensInput && maxTokensInput.value) ? Number(maxTokensInput.value) : undefined,
        tools: tools.length > 0 ? tools : undefined,
        previousInteractionId: prevIdToUse,
        localSessionId: localSessionIdToUse,
        startNewSession,
        ...getProxySettings()
      };

      lastRequestPayload = requestBody;

      // Log the COMPLETE FULL request body in debug logs!
      appendDebugLog('info', '正在发起 Agent 代理任务 POST /api/interactions/create...', requestBody);

      if (runTaskBtn) {
        runTaskBtn.disabled = true;
        runTaskBtn.innerHTML = '<span class="material-symbols-outlined spin">sync</span> 执行中 (Running)...';
      }
      if (taskStatusBadge) {
        taskStatusBadge.className = 'badge badge-running';
        taskStatusBadge.textContent = 'RUNNING';
      }

      if (emptyStateTrace) emptyStateTrace.style.display = 'none';
      if (traceContainer) traceContainer.style.display = 'block';
      if (finalOutputText) finalOutputText.innerHTML = '<em>Agent 正在远程 Linux 沙盒中推理并执行工具操作，请稍候...</em>';
      if (stepsList) stepsList.innerHTML = '';

      const response = await fetch('/api/interactions/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(requestBody)
      });

      const resJson = await response.json();

      if (!response.ok || !resJson.success) {
        const errObj = resJson.error || { message: `HTTP ${response.status} Error` };
        appendDebugLog('error', `Agent 代理任务执行失败 (HTTP ${response.status})`, errObj);
        showErrorInspector(errObj, requestBody);
        throw new Error(errObj.message || 'API Call Failed');
      }

      // Clear input prompt only after successful submission initiation
      if (taskInput) taskInput.value = '';

      const data = resJson.data;
      const extractedOutput = extractOutputText(data);

      appendDebugLog('success', 'Agent 代理任务执行成功返回!', {
        id: data.id,
        status: data.status,
        environment_id: data.environment_id,
        outputTextLength: extractedOutput.length,
        usage: data.usage
      });

      lastInteractionId = data.id || '';
      activeEnvironmentId = data.environment_id || activeEnvironmentId;
      activeSessionId = resJson.sessionId || data.local_session_id || activeSessionId;

      if (statEnvId) statEnvId.textContent = activeEnvironmentId || 'None';
      if (envIdInput) envIdInput.value = activeEnvironmentId;
      if (fetchFilePathInput) fetchFilePathInput.value = '/workspace/report.pdf';

      // Auto switch UI mode to reuse for subsequent turns in this sandbox
      const reuseRadio = document.querySelector('input[name="envMode"][value="reuse"]');
      if (reuseRadio) reuseRadio.checked = true;
      if (envIdGroup) envIdGroup.style.display = 'block';
      if (reuseFreshSessionCheckbox) reuseFreshSessionCheckbox.checked = false;
      if (btnCreateSessionInEnvironment) btnCreateSessionInEnvironment.disabled = false;

      if (data.usage && statTokens) {
        statTokens.textContent = `${data.usage.total_tokens || 0} (${data.usage.cached_tokens || 0} cached)`;
      }

      const status = (data.status || 'completed').toUpperCase();
      if (taskStatusBadge) {
        taskStatusBadge.textContent = status;
        if (status === 'COMPLETED') taskStatusBadge.className = 'badge badge-completed';
        else if (status === 'INCOMPLETE') taskStatusBadge.className = 'badge badge-idle';
        else taskStatusBadge.className = 'badge badge-error';
      }

      if (finalOutputText) {
        if (extractedOutput) {
          finalOutputText.innerHTML = renderMarkdown(extractedOutput);
          detectArtifactsFromText(extractedOutput);
        } else {
          finalOutputText.innerHTML = '<em>(无直接文本响应)</em>';
        }
      }

      if (stepsList && data.steps && Array.isArray(data.steps)) {
        data.steps.forEach((step, idx) => {
          const stepDiv = document.createElement('div');
          stepDiv.className = 'step-item';
          stepDiv.innerHTML = `
            <div class="step-header">
              <span class="step-type">步骤 #${idx + 1} - ${step.type || 'EXECUTION'}</span>
              <span>${step.id || ''}</span>
            </div>
            <div class="step-body">${escapeHtml(JSON.stringify(step, null, 2))}</div>
          `;
          stepsList.appendChild(stepDiv);
        });
      }

      // Save to Session Storage with Turn details
      if (activeEnvironmentId && activeSessionId) {
        saveSessionTurn(activeSessionId, activeEnvironmentId, {
          interactionId: lastInteractionId,
          prompt: textPrompt,
          outputText: extractedOutput,
          steps: data.steps,
          timestamp: Date.now()
        });
      }

    } catch (err) {
      if (taskStatusBadge) {
        taskStatusBadge.className = 'badge badge-error';
        taskStatusBadge.textContent = 'ERROR';
      }
      if (finalOutputText) {
        finalOutputText.innerHTML = `
          <div style="color: var(--accent-danger); background-color: rgba(239,68,68,0.1); padding: 16px; border-radius: 8px; border: 1px solid rgba(239,68,68,0.3);">
            <h4 style="margin-bottom: 8px;">❌ 任务运行发生异常失败</h4>
            <p style="font-size: 0.9rem; font-family: var(--font-mono);">${escapeHtml(err.message)}</p>
            <button class="btn btn-secondary btn-sm" style="margin-top: 12px;" onclick="window.reopenErrorInspector()">🔍 查看 API 详细 Error JSON 堆栈</button>
          </div>
        `;
      }
    } finally {
      if (runTaskBtn) {
        runTaskBtn.disabled = false;
        runTaskBtn.innerHTML = '<span class="material-symbols-outlined">rocket_launch</span> 提交代理任务 (Run Agent Interaction)';
      }
    }
  });

  // Zip Entire Workspace One-Click Helper
  btnZipWorkspace.addEventListener('click', async () => {
    if (!activeEnvironmentId) {
      alert('未找到活跃的 Environment ID！请先运行一个 Agent 任务。');
      return;
    }

    appendDebugLog('info', '一键打包沙盒工作区：正在要求 Agent 将 /workspace 打包为 ZIP...');
    const zipPath = '/tmp/workspace_project.zip';
    fetchFilePathInput.value = zipPath;

    try {
      fetchFileStatus.style.display = 'block';
      fetchFileStatus.innerHTML = `⏳ 正在打包沙盒工作区文件夹，请稍候...`;

      const response = await fetch('/api/interactions/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          agent: 'antigravity-preview-05-2026',
          input: 'You must use the code_execution tool now. Execute exactly: cd /workspace && python3 -c "import shutil; shutil.make_archive(\'/tmp/workspace_project\', \'zip\', \'/workspace\')". Then execute: test -s /tmp/workspace_project.zip && ls -lh /tmp/workspace_project.zip. Do not merely explain the command; run it and confirm the file exists.',
          environment: activeEnvironmentId,
          model: modelSelect.value,
          tools: [{ type: 'code_execution' }],
          previousInteractionId: lastInteractionId || undefined,
          localSessionId: activeSessionId || undefined,
          startNewSession: false,
          ...getProxySettings()
        })
      });

      const resData = await response.json();
      if (!response.ok || !resData.success) {
        const errObj = resData.error || { message: `HTTP ${response.status}` };
        appendDebugLog('error', '沙盒工作区打包失败', errObj);
        throw new Error(errObj.message || '打包请求失败');
      }
      if (resData.data && resData.data.id) {
        lastInteractionId = resData.data.id;
      }
      if (resData.sessionId || resData.data?.local_session_id) {
        activeSessionId = resData.sessionId || resData.data.local_session_id;
      }
      if (resData.data && resData.data.environment_id) {
        activeEnvironmentId = resData.data.environment_id;
      }

      // Now trigger file fetch using selected provider
      fetchFileBtn.click();
    } catch (e) {
      fetchFileStatus.innerHTML = `<div style="color: var(--accent-danger);">❌ 打包失败: ${escapeHtml(e.message)}</div>`;
    }
  });

  // Copy Output
  copyOutputBtn.addEventListener('click', () => {
    const rawText = finalOutputText.innerText;
    if (rawText) {
      navigator.clipboard.writeText(rawText);
      alert('已复制 Agent 输出文本到剪贴板！');
    }
  });

  // Fetch File from Remote Sandbox (official snapshot plus legacy fallbacks)
  fetchFileBtn.addEventListener('click', async () => {
    const filePath = fetchFilePathInput.value.trim();
    const provider = transferProviderSelect ? transferProviderSelect.value : 'snapshot';
    const providerLabel = provider === 'snapshot' ? 'Gemini 官方环境快照' : provider;

    if (!filePath) {
      alert('请输入要从远程沙盒中调取的文件路径！');
      return;
    }
    if (!activeEnvironmentId) {
      alert('未找到活跃的 Environment ID！请先运行一个 Agent 任务或在左侧指定 Environment ID。');
      return;
    }

    fetchFileStatus.style.display = 'block';
    fetchFileStatus.innerHTML = `⏳ 正在通过 [${providerLabel}] 从远程沙盒提取文件 "${escapeHtml(filePath)}"...`;
    appendDebugLog('info', `正在从沙盒 ${activeEnvironmentId} (通道: ${providerLabel}) 传输文件: ${filePath}`);

    try {
      const requestHeaders = {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      };
      // Snapshot downloads are returned as a binary response to avoid the
      // extra Base64 encoding/decoding and memory overhead of JSON.
      if (provider === 'snapshot') {
        requestHeaders.Accept = 'application/octet-stream';
      }

      const res = await fetch('/api/interactions/fetch-file', {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({
          apiKey,
          environmentId: activeEnvironmentId,
          previousInteractionId: lastInteractionId || undefined,
          filePath,
          provider,
          forceRefresh: provider === 'snapshot' && Boolean(forceRefreshSnapshotCheckbox?.checked),
          ...getProxySettings()
        })
      });

      if (provider === 'snapshot' && res.ok && res.headers.get('content-type')?.includes('application/octet-stream')) {
        const blob = await res.blob();
        const filename = decodeResponseHeader(res.headers.get('x-file-name')) || filePath.split('/').pop() || 'download.bin';
        const archivePath = decodeResponseHeader(res.headers.get('x-archive-path'));
        const matchedBy = res.headers.get('x-matched-by') || 'exact';
        const cacheState = res.headers.get('x-snapshot-cache') || 'MISS';
        appendDebugLog('success', `官方环境快照文件提取成功: ${filePath} (${(blob.size / 1024).toFixed(2)} KB, 缓存 ${cacheState})`);
        const locatedPath = archivePath
          ? `<div style="color: var(--text-secondary); margin-bottom: 8px;">实际路径：<span class="mono">${escapeHtml(archivePath)}</span>${matchedBy === 'basename' ? '（按文件名自动定位）' : ''}</div>`
          : '';
        fetchFileStatus.innerHTML = `
          <div style="color: var(--accent-success); font-weight: 600; margin-bottom: 8px;">
            ✅ 已提取文件 "${escapeHtml(filename)}" (${(blob.size / 1024).toFixed(2)} KB)，快照缓存：${escapeHtml(cacheState)}
          </div>
          ${locatedPath}
          <button class="btn btn-primary btn-sm" id="downloadBlobBtn">
            <span class="material-symbols-outlined">download</span> 保存为本地文件 (${escapeHtml(filename)})
          </button>
        `;
        document.getElementById('downloadBlobBtn').addEventListener('click', () => downloadBlobFile(blob, filename));
        if (forceRefreshSnapshotCheckbox) forceRefreshSnapshotCheckbox.checked = false;
        return;
      }

      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.success) {
        const errObj = result.error || { message: '获取文件失败' };
        appendDebugLog('error', `获取文件失败: ${filePath}`, errObj);
        const visiblePaths = Array.isArray(errObj.availablePaths) && errObj.availablePaths.length > 0
          ? `\n\n快照中可见的文件：\n${errObj.availablePaths.slice(0, 20).join('\n')}`
          : '';
        throw new Error(`${errObj.message || '获取远程文件失败'}${visiblePaths}`);
      }

      if (result.downloadUrl) {
        appendDebugLog('success', `远程文件传输成功！[通道: ${result.provider || provider}] 获得直联 URL: ${result.downloadUrl}`);

        fetchFileStatus.innerHTML = `
          <div style="color: var(--accent-success); font-weight: 600; margin-bottom: 8px;">
            ✅ 成功通过 ${result.provider || provider} 通道生成文件 "${result.filename}" 的无损直链！
          </div>
          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <a href="${result.downloadUrl}" target="_blank" download="${result.filename}" class="btn btn-primary btn-sm">
              <span class="material-symbols-outlined">download</span> 立即下载完整文件 (${result.filename})
            </a>
            <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${result.downloadUrl}'); alert('已复制下载直链！')">
              复制直链 URL
            </button>
          </div>
        `;
      } else if (result.base64Data) {
        const resultProviderLabel = result.provider === 'snapshot' ? 'Gemini 官方环境快照' : (result.provider || providerLabel);
        appendDebugLog('success', `${resultProviderLabel}文件提取成功: ${filePath} (${(result.sizeBytes / 1024).toFixed(2)} KB)`);
        const locatedPath = result.matchedBy === 'basename' && result.filePath
          ? `<div style="color: var(--text-secondary); margin-bottom: 8px;">自动定位到：<span class="mono">${escapeHtml(result.filePath)}</span></div>`
          : '';

        fetchFileStatus.innerHTML = `
          <div style="color: var(--accent-success); font-weight: 600; margin-bottom: 8px;">
            ✅ 已通过 ${escapeHtml(resultProviderLabel)} 提取文件 "${escapeHtml(result.filename)}" (${(result.sizeBytes / 1024).toFixed(2)} KB)！
          </div>
          ${locatedPath}
          <button class="btn btn-primary btn-sm" id="downloadBlobBtn">
            <span class="material-symbols-outlined">download</span> 保存为本地文件 (${result.filename})
          </button>
        `;

        document.getElementById('downloadBlobBtn').addEventListener('click', () => {
          downloadBase64File(result.base64Data, result.filename);
        });
        if (forceRefreshSnapshotCheckbox) forceRefreshSnapshotCheckbox.checked = false;
      }

    } catch (err) {
      fetchFileStatus.innerHTML = `<div style="color: var(--accent-danger); white-space: pre-wrap;">❌ 提取文件失败: ${escapeHtml(err.message)}</div>`;
    }
  });

  // Error Inspector Modal Controls
  let currentErrorObj = null;
  function showErrorInspector(errObj, requestPayload) {
    currentErrorObj = errObj;
    errorModalOverview.innerHTML = `
<strong>HTTP Status</strong>: ${errObj.status || 500}<br>
<strong>Error Code</strong>: ${escapeHtml(errObj.code || 'UNKNOWN')}<br>
<strong>Message</strong>: ${escapeHtml(errObj.message || 'No error message provided')}
    `;

    errorModalRequest.textContent = JSON.stringify(requestPayload || lastRequestPayload, null, 2);
    errorModalRaw.textContent = JSON.stringify(errObj.rawError || errObj, null, 2);

    errorModal.style.display = 'flex';
  }

  window.reopenErrorInspector = function() {
    if (currentErrorObj) {
      errorModal.style.display = 'flex';
    }
  };

  const closeErrorModal = () => { errorModal.style.display = 'none'; };
  closeErrorModalBtn.addEventListener('click', closeErrorModal);
  dismissErrorModalBtn.addEventListener('click', closeErrorModal);

  switchLogsTabBtn.addEventListener('click', () => {
    closeErrorModal();
    document.querySelector('.tab-btn[data-tab="logs"]').click();
  });

  // Clear & Copy Debug Logs
  clearLogsBtn.addEventListener('click', () => {
    debugLogsViewer.innerHTML = '<div class="log-entry log-info">[SYSTEM] 日志已清空</div>';
  });

  copyLogsBtn.addEventListener('click', () => {
    const text = debugLogsViewer.innerText;
    navigator.clipboard.writeText(text);
    alert('全量调试日志已复制到剪贴板！');
  });

  // Detect potential artifacts/files mentioned in agent output
  function detectArtifactsFromText(text) {
    detectedArtifactsList.innerHTML = '';
    const regex = /\/workspace\/[a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+/g;
    const matches = Array.from(new Set(text.match(regex) || []));

    if (matches.length === 0) {
      detectedArtifactsList.innerHTML = '<div class="empty-hint">在 Agent 输出文本中未自动侦测到 `/workspace/` 路径文件，您可以在上方手动输入要下载的文件路径。</div>';
      return;
    }

    matches.forEach(path => {
      const item = document.createElement('div');
      item.className = 'card margin-top';
      item.style.padding = '10px';
      item.style.display = 'flex';
      item.style.justifySpaceBetween = 'space-between';
      item.style.alignItems = 'center';

      item.innerHTML = `
        <div>
          <span class="material-symbols-outlined" style="vertical-align: middle; color: var(--accent-cyan);">description</span>
          <span class="mono" style="margin-left: 8px; font-weight: 600;">${escapeHtml(path)}</span>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="triggerFetchPath('${escapeHtml(path)}')">
          一键调取下载
        </button>
      `;
      detectedArtifactsList.appendChild(item);
    });
  }

  window.triggerFetchPath = function(path) {
    fetchFilePathInput.value = path;
    document.querySelector('.tab-btn[data-tab="artifacts"]').click();
    fetchFileBtn.click();
  };

  // Helper Functions
  function downloadBase64File(base64Data, filename) {
    const link = document.createElement('a');
    link.href = 'data:application/octet-stream;base64,' + base64Data;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function downloadBlobFile(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  function decodeResponseHeader(value) {
    if (!value) return '';
    try { return decodeURIComponent(value); } catch { return value; }
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return String(str);
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Render markdown with XSS sanitization (DOMPurify) and fallback
  function renderMarkdown(text) {
    if (!text) return '';
    try {
      if (window.marked && window.DOMPurify) {
        return window.DOMPurify.sanitize(window.marked.parse(text));
      }
      return escapeHtml(text).replace(/\n/g, '<br>');
    } catch (e) {
      return escapeHtml(text).replace(/\n/g, '<br>');
    }
  }

  // Current proxy settings to pass to the backend with each request
  function getProxySettings() {
    return {
      useProxy: useProxyCheckbox ? useProxyCheckbox.checked : false,
      proxyUrl: proxyUrlInput ? proxyUrlInput.value.trim() : ''
    };
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
