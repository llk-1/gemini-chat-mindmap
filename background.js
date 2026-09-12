// Gemini Chat MindMap - Background Service Worker
// 职责：
//  1. 注册"点击工具栏图标打开侧边栏"
//  2. 接收内容脚本的 GMM_HIGHLIGHT（原文→导图）：暂存待高亮消息并打开侧边栏
//     侧边栏通过 storage.session.onChanged / 初始化消费 pendingHighlight

const PENDING_KEY = 'pendingHighlight';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('[GMM] setPanelBehavior failed:', e));
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'GMM_HIGHLIGHT') return false;
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return false;
  chrome.storage.session
    .set({ [PENDING_KEY]: { index: msg.index, tabId, ts: Date.now() } })
    .then(() => chrome.sidePanel.open({ tabId }))
    .catch((e) => console.error('[GMM] open sidePanel failed:', e));
  return false;
});
