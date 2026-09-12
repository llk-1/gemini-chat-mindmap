// Gemini Chat MindMap - Content Script
// 注入 gemini.google.com：
//  1. 解析当前会话消息（选择器链降级，容忍 Gemini DOM 变更）
//  2. 处理侧边栏发来的 LOCATE 请求（滚动定位 + 闪烁高亮）
//  3. 悬停消息时展示"导图"按钮，点击后请求侧边栏高亮对应节点

(() => {
  'use strict';

  // 支持重复注入（扩展重载后旧脚本上下文失效，侧边栏会自动重新注入）：
  // 注入前执行上一次注册的清理函数，移除旧监听器与悬停按钮，避免重复
  if (typeof window.__GMM_CLEANUP__ === 'function') {
    try {
      window.__GMM_CLEANUP__();
    } catch (e) {
      /* 忽略旧脚本清理失败 */
    }
  }
  const cleanups = [];
  const onCleanup = (fn) => cleanups.push(fn);
  window.__GMM_CLEANUP__ = () => {
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        /* 忽略 */
      }
    });
  };

  const USER_SEL = 'user-query';
  const MODEL_SEL = 'model-response';
  const MSG_SEL = `${USER_SEL}, ${MODEL_SEL}`;
  const MAX_MSG_CHARS = 4000;

  let currentEls = []; // 与消息 index 对齐的 DOM 元素缓存
  let hoverHost = null;
  let hoverBtn = null;
  let hoverTimer = null;

  // ---------------- 解析 ----------------

  function findMessageEls() {
    let els = [];
    // 策略 1：chat-history 容器内的自定义元素（近年最稳定）
    const history = document.querySelector('chat-history');
    if (history) els = [...history.querySelectorAll(MSG_SEL)];
    // 策略 2：chat-window / conversation-container 范围
    if (!els.length) {
      const scope = document.querySelector('chat-window') || document;
      els = [...scope.querySelectorAll(MSG_SEL)];
    }
    // 策略 3：document 全局兜底
    if (!els.length) {
      els = [...document.querySelectorAll(MSG_SEL)];
    }
    // 去掉互相嵌套的重复项，并按文档顺序排列
    els = els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
    els.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    return els;
  }

  function extractText(el) {
    const clone = el.cloneNode(true);
    // 清理我们注入的元素，避免干扰文本
    clone.querySelectorAll('.gmm-host, .gmm-hover-btn').forEach((n) => n.remove());
    let text = clone.innerText || clone.textContent || '';
    text = text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    // 剥离 Gemini 为屏幕阅读器注入的无障碍前缀（如 "You said" / "Gemini said"）
    text = text.replace(/^(You said|Gemini said|你说|Gemini 说|助手说)[\s:：,，.]*/i, '').trim();
    return text.slice(0, MAX_MSG_CHARS);
  }

  function extractHeadings(el) {
    return [...el.querySelectorAll('h1,h2,h3,h4')]
      .map((h) => (h.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  function collectMessages() {
    const els = findMessageEls();
    const messages = [];
    currentEls = [];
    for (const el of els) {
      const type = el.matches(USER_SEL) ? 'user' : 'model';
      const text = extractText(el);
      if (!text) continue; // 空消息（加载中等）跳过，不占用 index
      const msg = {
        type,
        index: messages.length,
        text,
        headings: type === 'model' ? extractHeadings(el) : [],
      };
      messages.push(msg);
      currentEls[msg.index] = el;
    }
    return messages;
  }

  function getConversationTitle() {
    const t = document.title || '';
    return t.replace(/\s*-\s*Gemini\s*$/i, '').trim() || '未命名会话';
  }

  // ---------------- 原文 → 导图（悬停按钮） ----------------

  function ensureHoverButton() {
    if (hoverHost) return;
    // 移除历史注入遗留的悬停按钮
    document.querySelectorAll('.gmm-host').forEach((n) => n.remove());
    hoverHost = document.createElement('div');
    hoverHost.className = 'gmm-host';
    hoverBtn = document.createElement('button');
    hoverBtn.className = 'gmm-hover-btn';
    hoverBtn.type = 'button';
    hoverBtn.textContent = '导图';
    hoverBtn.title = '在思维导图中定位此消息';
    hoverBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(hoverBtn.dataset.index);
      if (Number.isNaN(idx)) return;
      chrome.runtime.sendMessage({ type: 'GMM_HIGHLIGHT', index: idx }).catch(() => {});
    });
    hoverHost.appendChild(hoverBtn);
    document.documentElement.appendChild(hoverHost);
    onCleanup(() => hoverHost && hoverHost.remove());
  }

  function hideHoverButton() {
    if (hoverHost) hoverHost.classList.remove('gmm-visible');
  }

  function indexOfMessageEl(el) {
    // 优先使用缓存（init / 变更检测时已收集），避免每次悬停都整页解析
    for (let i = 0; i < currentEls.length; i++) {
      if (currentEls[i] === el) return i;
    }
    // 元素可能是新渲染的（处于防抖窗口内），兜底重新收集一次
    const msgs = collectMessages();
    for (const m of msgs) {
      if (currentEls[m.index] === el) return m.index;
    }
    return null;
  }

  function setupHoverListener() {
    const onMouseOver = (e) => {
      ensureHoverButton();
      if (hoverHost.contains(e.target)) return; // 悬停按钮自身不隐藏
      const el = e.target.closest ? e.target.closest(MSG_SEL) : null;
      if (!el) {
        hideHoverButton();
        return;
      }
      const idx = indexOfMessageEl(el);
      if (idx == null) {
        hideHoverButton();
        return;
      }
      const r = el.getBoundingClientRect();
      hoverBtn.dataset.index = String(idx);
      hoverHost.style.left = `${window.scrollX + r.right - 58}px`;
      hoverHost.style.top = `${window.scrollY + r.top + 6}px`;
      hoverHost.classList.add('gmm-visible');
    };
    document.addEventListener('mouseover', onMouseOver, true);
    window.addEventListener('scroll', hideHoverButton, { passive: true });
    onCleanup(() => {
      document.removeEventListener('mouseover', onMouseOver, true);
      window.removeEventListener('scroll', hideHoverButton);
    });
  }

  // ---------------- 导图 → 原文（定位 + 闪烁） ----------------

  function flash(el) {
    el.classList.remove('gmm-flash');
    // 强制 reflow 以重启动画
    void el.offsetWidth;
    el.classList.add('gmm-flash');
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => el.classList.remove('gmm-flash'), 1800);
  }

  function locateMessage(index) {
    collectMessages(); // 重新解析，保证元素与 index 最新
    const el = currentEls[index];
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(el);
    return true;
  }

  // ---------------- 消息监听 ----------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    switch (msg.type) {
      case 'GMM_GET_CONVERSATION': {
        const messages = collectMessages();
        sendResponse({
          ok: true,
          title: getConversationTitle(),
          messages: messages.map(({ index, type, text, headings }) => ({ index, type, text, headings })),
          count: messages.length,
        });
        break;
      }
      case 'GMM_LOCATE': {
        sendResponse({ ok: locateMessage(msg.index) });
        break;
      }
      default:
        break;
    }
    return false; // 均为同步响应
  });

  // ---------------- 会话变化检测 ----------------

  let debounceTimer = null;
  let lastCount = -1;
  let lastTitle = '';

  function notifyUpdate() {
    const msgs = collectMessages();
    const title = getConversationTitle();
    if (msgs.length !== lastCount || title !== lastTitle) {
      const first = lastCount === -1;
      lastCount = msgs.length;
      lastTitle = title;
      if (!first) {
        chrome.runtime.sendMessage({ type: 'GMM_UPDATED', count: msgs.length }).catch(() => {});
      }
    }
  }

  function setupObserver() {
    const target = document.querySelector('chat-history') || document.body;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(notifyUpdate, 800);
    });
    observer.observe(target, { childList: true, subtree: true });
    onCleanup(() => {
      observer.disconnect();
      clearTimeout(debounceTimer);
    });
  }

  function init() {
    ensureHoverButton();
    setupHoverListener();
    setupObserver();
    lastTitle = getConversationTitle();
    lastCount = collectMessages().length;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
