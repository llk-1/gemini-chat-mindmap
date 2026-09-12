// Gemini Chat MindMap - Side Panel
// 职责：
//  1. 通过内容脚本读取当前 Gemini 会话
//  2. 规则解析 / DeepSeek AI 总结两种模式构建导图树，mind-elixir 渲染
//  3. 导图 → 原文：节点点击发送 GMM_LOCATE
//  4. 原文 → 导图：消费 background 暂存的 pendingHighlight 并高亮节点

(() => {
  'use strict';

  const TB = window.GMMTreeBuilder; // 纯函数树构建模块（treeBuilder.js）
  const GEMINI_ORIGIN = 'https://gemini.google.com';
  const PENDING_KEY = 'pendingHighlight';

  // ---------------- 状态 ----------------

  let currentMode = 'rule'; // 'rule' | 'ai'
  let currentConv = null; // { title, messages }
  let currentTree = null; // { nodeData, truncated }
  let payloadMap = null; // Map<nodeId, messageIndex>
  let mapInstance = null;
  let mapInitialized = false;

  // ---------------- DOM ----------------

  const $ = (id) => document.getElementById(id);
  const mapEl = $('map');
  const emptyEl = $('empty');
  const emptyText = $('emptyText');
  const statusEl = $('status');
  const updateBar = $('updateBar');
  const btnGenerate = $('btnGenerate');
  const btnRefresh = $('btnRefresh');
  const btnSettings = $('btnSettings');
  const modeRuleBtn = $('modeRule');
  const modeAIBtn = $('modeAI');
  const btnExport = $('btnExport');
  const exportMenu = $('exportMenu');
  const btnExportPdf = $('btnExportPdf');
  const btnExportXmind = $('btnExportXmind');

  // ---------------- 工具 ----------------

  function showStatus(text, type = 'info') {
    statusEl.textContent = text;
    statusEl.classList.toggle('gmm-error', type === 'error');
    statusEl.hidden = false;
  }

  function clearStatus() {
    statusEl.hidden = true;
    statusEl.textContent = '';
  }

  function showEmpty(text) {
    emptyText.textContent = text;
    emptyEl.hidden = false;
  }

  function hideEmpty() {
    emptyEl.hidden = true;
  }

  function setBusy(busy) {
    btnGenerate.disabled = busy;
    btnGenerate.textContent = busy ? '生成中…' : '生成导图';
  }

  // ---------------- 页面通信 ----------------

  async function getGeminiTabId() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.url !== 'string' || !tab.url.startsWith(GEMINI_ORIGIN)) {
      showEmpty('请在 Gemini（gemini.google.com）页面点击插件图标使用');
      return null;
    }
    return tab.id;
  }

  async function sendToContent(tabId, payload) {
    return chrome.tabs.sendMessage(tabId, payload);
  }

  // 扩展重载/升级后，页面中旧内容脚本上下文会失效（sendMessage 报连接失败）。
  // 此时用 scripting 自动重新注入内容脚本与样式，再重试一次。
  async function sendToContentWithRecovery(tabId, payload) {
    try {
      return await sendToContent(tabId, payload);
    } catch (e) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js'],
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/content.css'],
      });
      return sendToContent(tabId, payload);
    }
  }

  async function fetchConversation() {
    const tabId = await getGeminiTabId();
    if (tabId == null) return null;
    try {
      const conv = await sendToContentWithRecovery(tabId, { type: 'GMM_GET_CONVERSATION' });
      if (!conv || !conv.ok) throw new Error('bad response');
      return conv;
    } catch (e) {
      showEmpty('无法读取页面内容');
      showStatus(
        '无法与 Gemini 页面通信。若刚安装或更新扩展，请刷新 Gemini 页面后重试。',
        'error'
      );
      return null;
    }
  }

  async function sendLocate(msgIndex) {
    const tabId = await getGeminiTabId();
    if (tabId == null) return;
    try {
      await sendToContentWithRecovery(tabId, { type: 'GMM_LOCATE', index: msgIndex });
    } catch (e) {
      showStatus('无法定位原文：请刷新 Gemini 页面后重试', 'error');
    }
  }

  // ---------------- AI 总结（DeepSeek） ----------------

  const SYSTEM_PROMPT =
    '你是聊天记录思维导图助手。你必须只输出一个 JSON 对象，不要输出任何其他文字或代码围栏。';

  const USER_PROMPT_HEAD =
    '请阅读以下 Gemini 对话记录，将其提炼为一份高质量的思维导图大纲，帮助用户快速回顾对话、梳理思路。\n\n' +
    '输出要求：\n' +
    '1. 只输出一个 JSON 对象（不要输出任何其他文字或代码围栏），格式：\n' +
    '   {"topic":"对话核心主题","children":[{"topic":"主题","children":[{"topic":"要点","ref":3}]}]}\n' +
    '2. 第一层 children 按"主题/问题域"聚合，不要简单按轮次罗列；相同话题的多轮对话合并为一个分支\n' +
    '3. topic 用精炼的中文短语概括核心信息（不超过 15 字），避免"第n轮""用户问"这类元描述\n' +
    '4. 层级 2~4 层：主题 → 子主题 → 关键结论/细节；每个节点的子节点 3~8 个\n' +
    '5. ref 为该节点内容最相关的对话轮次号（依据文中【第n轮】标注），能确定就必须给出\n' +
    '6. 必须覆盖所有轮次的关键信息：核心问题、推理过程、结论、遗留待办\n\n' +
    '以下是对话记录：\n\n';

  async function callDeepSeek(apiKey, transcript, model) {
    const body = {
      model: model || 'deepseek-chat',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_PROMPT_HEAD + transcript },
      ],
      stream: false,
    };
    if (body.model === 'deepseek-chat') {
      // JSON 输出模式仅 deepseek-chat 支持；reasoner 依赖提示词 + 宽松解析
      body.response_format = { type: 'json_object' };
      body.temperature = 0.3;
    }
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401) throw new Error('API Key 无效（401），请在设置中检查');
      throw new Error(`DeepSeek 请求失败（${res.status}）：${body.slice(0, 160)}`);
    }
    const data = await res.json();
    return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }

  async function buildAiTree(conv) {
    const { deepseekApiKey, deepseekModel } = await chrome.storage.local.get([
      'deepseekApiKey',
      'deepseekModel',
    ]);
    if (!deepseekApiKey) {
      showStatus('尚未配置 DeepSeek API Key：请点击右上角"设置"填写', 'error');
      return null;
    }
    const model = deepseekModel || 'deepseek-chat';
    showStatus(`AI 总结生成中…（${model}，可能需要数十秒）`);
    const { transcript, rounds, truncated } = TB.buildTranscript(conv);
    if (!transcript.trim()) {
      showStatus('对话内容为空，无法总结', 'error');
      return null;
    }
    const content = await callDeepSeek(deepseekApiKey, transcript, model);
    const raw = TB.parseJsonLoose(content);
    const payload = new Map();
    const root = TB.sanitizeAiTree(raw, rounds, payload);
    if (!root) throw new Error('AI 返回的 JSON 结构无法解析');
    return {
      nodeData: root,
      truncated,
      note: 'AI 总结模式：仅带来源的节点可跳转原文',
    };
  }

  // ---------------- 渲染 ----------------

  function collectRefs(node) {
    if (!node) return;
    if (node.ref != null) payloadMap.set(node.id, node.ref);
    (node.children || []).forEach(collectRefs);
  }

  function findPath(node, targetId, trail = []) {
    if (!node) return null;
    const next = [...trail, node.id];
    if (node.id === targetId) return next;
    for (const c of node.children || []) {
      const r = findPath(c, targetId, next);
      if (r) return r;
    }
    return null;
  }

  // IIFE 构建导出的是 { default: 类, SIDE, ... } 对象，需要兼容取真正的构造函数
  const MindElixirCtor = window.MindElixir && (window.MindElixir.default || window.MindElixir);
  const MindElixirConsts = window.MindElixir || {};

  function renderMap(tree) {
    currentTree = tree;
    payloadMap = new Map();
    collectRefs(tree.nodeData);
    if (!mapInstance) {
      mapInstance = new MindElixirCtor({
        el: mapEl,
        direction: MindElixirConsts.SIDE,
        editable: false,
        contextMenu: false,
        toolBar: false,
        keypress: false,
        overflowHidden: false,
      });
      mapEl.addEventListener(
        'click',
        (e) => {
          const nodeEl = e.target && e.target.closest ? e.target.closest('[data-nodeid]') : null;
          if (!nodeEl) return;
          const nid = (nodeEl.getAttribute('data-nodeid') || '').replace(/^me/, '');
          const ref = payloadMap && payloadMap.get(nid);
          if (ref == null) return;
          sendLocate(ref);
        },
        true
      );
    }
    if (!mapInitialized) {
      mapInstance.init(tree);
      mapInitialized = true;
    } else {
      mapInstance.refresh(tree);
    }
    try {
      mapInstance.scaleFit();
    } catch (e) {
      /* 忽略缩放适配失败 */
    }
  }

  // ---------------- 导出（PDF / XMind） ----------------

  function exportFileName(ext) {
    const title = (currentConv && currentConv.title) || 'gemini-mindmap';
    const safe = title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'gemini-mindmap';
    return `${safe}.${ext}`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('读取图像数据失败'));
      fr.readAsDataURL(blob);
    });
  }

  function loadImageSize(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('解析图像失败'));
      img.src = dataUrl;
    });
  }

  async function exportPdf() {
    if (!mapInstance || !currentTree) {
      showStatus('请先生成导图', 'error');
      return;
    }
    showStatus('正在导出 PDF…');
    try {
      const blob = await mapInstance.exportPng(false);
      if (!blob) throw new Error('导图图像导出为空');
      const dataUrl = await blobToDataUrl(blob);
      const { w, h } = await loadImageSize(dataUrl);
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({
        orientation: w >= h ? 'landscape' : 'portrait',
        unit: 'pt',
        format: [w, h], // 页面尺寸与导图一致，避免内容被缩放裁剪
      });
      pdf.addImage(dataUrl, 'PNG', 0, 0, w, h);
      pdf.save(exportFileName('pdf'));
      clearStatus();
    } catch (e) {
      showStatus('导出 PDF 失败：' + (e && e.message ? e.message : String(e)), 'error');
    }
  }

  // XMind 2020+ 格式：zip 包含 content.json / metadata.json / manifest.json
  function toXmindTopic(node) {
    const t = { id: String(node.id), class: 'topic', title: String(node.topic) };
    const kids = (node.children || []).map(toXmindTopic);
    if (kids.length) t.children = { attached: kids };
    return t;
  }

  async function exportXmind() {
    if (!currentTree) {
      showStatus('请先生成导图', 'error');
      return;
    }
    showStatus('正在导出 XMind…');
    try {
      const title = String(currentTree.nodeData.topic || '会话导图');
      const content = [
        {
          id: 'sheet-1',
          class: 'sheet',
          title,
          rootTopic: toXmindTopic(currentTree.nodeData),
        },
      ];
      const zip = new JSZip();
      zip.file('content.json', JSON.stringify(content));
      zip.file(
        'metadata.json',
        JSON.stringify({ creator: { name: 'Gemini Chat MindMap', version: '0.1.0' } })
      );
      zip.file(
        'manifest.json',
        JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } })
      );
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, exportFileName('xmind'));
      clearStatus();
    } catch (e) {
      showStatus('导出 XMind 失败：' + (e && e.message ? e.message : String(e)), 'error');
    }
  }

  function toggleExportMenu(show) {
    exportMenu.hidden = show != null ? !show : !exportMenu.hidden;
  }

  // ---------------- 原文 → 导图 ----------------

  async function highlightMessage(msgIndex) {
    if (!payloadMap || !mapInstance) return false;
    let nodeId = null;
    for (const [id, ref] of payloadMap.entries()) {
      if (ref === msgIndex) {
        nodeId = id;
        break;
      }
    }
    if (nodeId == null) {
      showStatus('当前导图中没有该消息对应的节点，请重新生成导图', 'error');
      return false;
    }
    const path = findPath(currentTree.nodeData, nodeId) || [];
    for (const ancestorId of path.slice(0, -1)) {
      try {
        const el = mapInstance.findEle(ancestorId);
        if (el) mapInstance.expandNode(el, true);
      } catch (e) {
        /* 展开失败不阻塞 */
      }
    }
    const el = mapInstance.findEle(nodeId);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    el.classList.remove('gmm-node-flash');
    void el.offsetWidth;
    el.classList.add('gmm-node-flash');
    setTimeout(() => el.classList.remove('gmm-node-flash'), 2000);
    return true;
  }

  async function consumePending() {
    const { pendingHighlight } = await chrome.storage.session.get(PENDING_KEY);
    if (!pendingHighlight) return;
    if (Date.now() - (pendingHighlight.ts || 0) > 30000) {
      await chrome.storage.session.remove(PENDING_KEY);
      return;
    }
    try {
      const tab = await chrome.tabs.get(pendingHighlight.tabId);
      const win = await chrome.windows.getCurrent();
      if (tab.windowId !== win.id) return; // 其他窗口的请求
      await chrome.storage.session.remove(PENDING_KEY);
      if (!currentTree) {
        // 面板刚打开：先出规则导图再高亮
        await generate('rule');
      }
      await highlightMessage(pendingHighlight.index);
    } catch (e) {
      /* 标签页可能已关闭 */
    }
  }

  // ---------------- 生成入口 ----------------

  async function generate(mode = currentMode) {
    const conv = await fetchConversation();
    if (!conv) return;
    if (!conv.messages || !conv.messages.length) {
      showEmpty('未读取到聊天内容：请先在 Gemini 页面打开一个会话');
      return;
    }
    currentConv = conv;
    updateBar.hidden = true;
    hideEmpty();
    setBusy(true);
    try {
      if (mode === 'rule') {
        const tree = TB.buildRuleTree(conv);
        renderMap(tree);
        clearStatus();
        if (tree.truncated) showStatus('会话较长，仅展示最近 ' + TB.MAX_ROUNDS + ' 轮');
      } else {
        const tree = await buildAiTree(conv);
        if (!tree) return;
        renderMap(tree);
        showStatus(tree.note + (tree.truncated ? '（内容较长，已截断）' : ''));
      }
      await consumePending();
    } catch (e) {
      showStatus('生成失败：' + (e && e.message ? e.message : String(e)), 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---------------- 事件绑定 ----------------

  function setMode(mode) {
    currentMode = mode;
    modeRuleBtn.classList.toggle('active', mode === 'rule');
    modeAIBtn.classList.toggle('active', mode === 'ai');
  }

  // 切换模式即按新模式重新生成导图
  function switchMode(mode) {
    if (mode === currentMode) return;
    setMode(mode);
    generate(mode);
  }

  function bindEvents() {
    btnGenerate.addEventListener('click', () => generate());
    btnRefresh.addEventListener('click', () => generate());
    btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
    modeRuleBtn.addEventListener('click', () => switchMode('rule'));
    modeAIBtn.addEventListener('click', () => switchMode('ai'));

    btnExport.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExportMenu();
    });
    btnExportPdf.addEventListener('click', () => {
      toggleExportMenu(false);
      exportPdf();
    });
    btnExportXmind.addEventListener('click', () => {
      toggleExportMenu(false);
      exportXmind();
    });
    document.addEventListener('click', (e) => {
      if (!exportMenu.hidden && !e.target.closest('.gmm-export-wrap')) {
        toggleExportMenu(false);
      }
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'GMM_UPDATED') updateBar.hidden = false;
      return false;
    });

    chrome.storage.session.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes.pendingHighlight && changes.pendingHighlight.newValue) {
        consumePending();
      }
    });
  }

  // ---------------- 启动 ----------------

  async function init() {
    bindEvents();
    await consumePending();
    await generate('rule');
  }

  init();
})();
