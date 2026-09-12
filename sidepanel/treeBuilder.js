// Gemini Chat MindMap - 导图树构建（纯函数，无 chrome/DOM 依赖，便于单元测试）
// 被 sidepanel.js 使用：window.GMMTreeBuilder

(() => {
  'use strict';

  const MAX_ROUNDS = 50;
  const AI_MSG_CHARS = 2500;
  const AI_TOTAL_CHARS = 45000;

  let uidCounter = 0;
  const uid = () => 'n' + ++uidCounter;

  function preview(text, n) {
    const firstLine = (String(text).split('\n').find((l) => l.trim()) || '').replace(/\s+/g, ' ').trim();
    return firstLine.length > n ? firstLine.slice(0, n) + '…' : firstLine;
  }

  // 将顺序消息流按"用户提问 → 助手回答"分组为轮次
  function groupRounds(messages) {
    const rounds = [];
    let round = null;
    for (const m of messages) {
      if (m.type === 'user') {
        round = {
          no: rounds.length + 1,
          userIndex: m.index,
          userText: m.text,
          modelIndex: null,
          modelText: '',
          headings: [],
        };
        rounds.push(round);
      } else if (!round) {
        // 开场无用户提问的模型消息
        round = {
          no: rounds.length + 1,
          userIndex: m.index,
          userText: '',
          modelIndex: m.index,
          modelText: m.text,
          headings: m.headings || [],
        };
        rounds.push(round);
      } else if (round.modelIndex == null) {
        round.modelIndex = m.index;
        round.modelText = m.text;
        round.headings = m.headings || [];
      } else {
        round.modelText += '\n' + m.text;
        round.headings = round.headings.concat(m.headings || []);
      }
    }
    return rounds;
  }

  function modelSections(round) {
    if (!round.modelText) return [];
    if (round.headings && round.headings.length >= 2) {
      return round.headings.slice(0, 10).map((h) => preview(h, 34));
    }
    const paras = round.modelText.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    if (paras.length <= 1) return [preview(round.modelText, 40)];
    return paras.slice(0, 8).map((p) => preview(p, 30));
  }

  // 规则模式：按轮次生成导图树，节点 ref 指向消息 index
  function buildRuleTree(conv) {
    const rounds = groupRounds(conv.messages);
    const truncated = rounds.length > MAX_ROUNDS;
    const kept = truncated ? rounds.slice(rounds.length - MAX_ROUNDS) : rounds;

    const root = {
      topic: conv.title || '会话导图',
      id: uid(),
      children: kept.map((r) => {
        const sections = modelSections(r);
        return {
          topic: `${r.no}. ${r.userText ? preview(r.userText, 24) : '(助手发起)'}`,
          id: uid(),
          ref: r.userIndex,
          children: sections.map((s) => ({
            topic: s,
            id: uid(),
            ref: r.modelIndex != null ? r.modelIndex : r.userIndex,
          })),
        };
      }),
    };
    return { nodeData: root, truncated };
  }

  // AI 模式：构建对话文本 + 保留轮次映射（供 ref → 消息 index）
  function buildTranscript(conv) {
    const rounds = groupRounds(conv.messages);
    const kept = rounds.length > MAX_ROUNDS ? rounds.slice(rounds.length - MAX_ROUNDS) : rounds;
    const lines = [];
    let total = 0;
    let dropped = 0;
    for (let i = 0; i < kept.length; i++) {
      const r = kept[i];
      const parts = [];
      if (r.userText) parts.push(`【第${r.no}轮·用户】${r.userText.slice(0, AI_MSG_CHARS)}`);
      if (r.modelText) parts.push(`【第${r.no}轮·助手】${r.modelText.slice(0, AI_MSG_CHARS)}`);
      const block = parts.join('\n');
      if (total + block.length > AI_TOTAL_CHARS) {
        dropped = kept.length - i;
        break;
      }
      total += block.length;
      lines.push(block);
    }
    return {
      transcript: lines.join('\n\n'),
      rounds: kept,
      truncated: dropped > 0 || rounds.length > MAX_ROUNDS,
    };
  }

  // 宽松解析 AI 返回的 JSON（容忍代码围栏与前后缀文本）
  function parseJsonLoose(s) {
    let t = String(s).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
    return JSON.parse(t);
  }

  // 校验并规范化 AI 返回的树：生成节点 id，ref(轮次号) → 消息 index
  function sanitizeAiTree(raw, rounds, payload) {
    function walk(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 5) return null;
      const topic = preview(String(obj.topic != null ? obj.topic : '').trim() || '（空节点）', 24);
      const node = { topic, id: uid() };
      let refVal = obj.ref;
      if (Array.isArray(refVal)) refVal = refVal[0];
      if (refVal != null) {
        const r = rounds.find((x) => x.no === Number(refVal));
        if (r) node.ref = r.userIndex;
      }
      const children = Array.isArray(obj.children) ? obj.children.slice(0, 8) : [];
      const kids = children.map((c) => walk(c, depth + 1)).filter(Boolean);
      if (kids.length) node.children = kids;
      if (node.ref != null) payload.set(node.id, node.ref);
      return node;
    }
    return walk(raw, 1);
  }

  const api = {
    MAX_ROUNDS,
    AI_MSG_CHARS,
    AI_TOTAL_CHARS,
    preview,
    groupRounds,
    buildRuleTree,
    buildTranscript,
    parseJsonLoose,
    sanitizeAiTree,
  };

  if (typeof window !== 'undefined') {
    window.GMMTreeBuilder = api;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.GMMTreeBuilder = api;
  }
})();
