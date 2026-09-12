// Gemini Chat MindMap - 设置页
// 保存 / 测试 DeepSeek API Key 与模型选择（存于 chrome.storage.local）

(() => {
  'use strict';

  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('model');
  const btnSave = document.getElementById('btnSave');
  const btnTest = document.getElementById('btnTest');
  const msgEl = document.getElementById('msg');

  function setMsg(text, type) {
    msgEl.textContent = text;
    msgEl.className = 'msg' + (type ? ' ' + type : '');
  }

  async function init() {
    const { deepseekApiKey, deepseekModel } = await chrome.storage.local.get([
      'deepseekApiKey',
      'deepseekModel',
    ]);
    if (deepseekApiKey) apiKeyInput.value = deepseekApiKey;
    if (deepseekModel) modelSelect.value = deepseekModel;
  }

  async function save() {
    const key = apiKeyInput.value.trim();
    if (!key) {
      setMsg('请输入 API Key', 'err');
      return false;
    }
    await chrome.storage.local.set({
      deepseekApiKey: key,
      deepseekModel: modelSelect.value,
    });
    return true;
  }

  btnSave.addEventListener('click', async () => {
    if (await save()) setMsg('已保存', 'ok');
  });

  btnTest.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      setMsg('请先输入 API Key', 'err');
      return;
    }
    btnTest.disabled = true;
    setMsg('测试中…');
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: modelSelect.value,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
          stream: false,
        }),
      });
      if (res.ok) {
        setMsg('连接成功，Key 有效', 'ok');
        await save();
      } else if (res.status === 401) {
        setMsg('Key 无效（401）', 'err');
      } else {
        const body = await res.text().catch(() => '');
        setMsg(`请求失败（${res.status}）${body.slice(0, 120)}`, 'err');
      }
    } catch (e) {
      setMsg('网络错误：' + (e && e.message ? e.message : String(e)), 'err');
    } finally {
      btnTest.disabled = false;
    }
  });

  init();
})();
