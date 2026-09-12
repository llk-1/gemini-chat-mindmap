#!/usr/bin/env node
// treeBuilder.js 单元测试：node scripts/test_tree_builder.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'treeBuilder.js'), 'utf8'),
  sandbox
);
const T = sandbox.window.GMMTreeBuilder;

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log('  ok  -', name);
  } else {
    failed++;
    console.error('  FAIL -', name, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

// ---------- mock 会话 ----------
const conv = {
  title: '思想实验讨论',
  messages: [
    { type: 'user', index: 0, text: '第一问：什么是思想实验？请详细解释' },
    {
      type: 'model',
      index: 1,
      text: '开头介绍。\n\n定义段落内容。\n\n历史段落内容。\n\n用途段落内容。',
      headings: ['定义', '历史', '用途'],
    },
    { type: 'user', index: 2, text: '第二问：举几个著名例子' },
    { type: 'model', index: 3, text: '单一回答内容，没有分节' },
  ],
};

// ---------- 规则树 ----------
console.log('[buildRuleTree]');
const rule = T.buildRuleTree(conv);
check('根节点为会话标题', rule.nodeData.topic === '思想实验讨论');
check('两轮对话生成两个分支', rule.nodeData.children.length === 2);
check('未截断标记为 false', rule.truncated === false);
const r1 = rule.nodeData.children[0];
check('轮次编号与提问预览', r1.topic.startsWith('1. 第一问'), r1.topic);
check('轮次分支 ref 指向用户消息 index 0', r1.ref === 0);
check('有 headings>=2 时按标题分节', r1.children.length === 3, r1.children);
check('分节 ref 指向模型消息 index 1', r1.children.every((c) => c.ref === 1));
const r2 = rule.nodeData.children[1];
check('无分节时单一子节点', r2.children.length === 1);
check('单一子节点 ref 指向 index 3', r2.children[0].ref === 3);
check('所有节点均有唯一 id（根1+轮2+分节4=7）', (() => {
  const ids = new Set();
  let dup = false;
  (function walk(n) {
    if (ids.has(n.id)) dup = true;
    ids.add(n.id);
    (n.children || []).forEach(walk);
  })(rule.nodeData);
  return !dup && ids.size === 7;
})());

// ---------- 开场无用户提问 ----------
console.log('[开场模型消息]');
const conv2 = {
  title: 't',
  messages: [{ type: 'model', index: 0, text: '你好！我是 Gemini' }],
};
const rule2 = T.buildRuleTree(conv2);
check('开场模型消息单独成轮', rule2.nodeData.children.length === 1);
check('开场轮标记为(助手发起)', rule2.nodeData.children[0].topic.includes('(助手发起)'));
check('开场轮 ref 指向 index 0', rule2.nodeData.children[0].ref === 0);

// ---------- 轮次截断 ----------
console.log('[截断]');
const longMessages = [];
let idx = 0;
for (let i = 0; i < 60; i++) {
  longMessages.push({ type: 'user', index: idx++, text: `问题${i + 1}` });
  longMessages.push({ type: 'model', index: idx++, text: `回答${i + 1}` });
}
const rule3 = T.buildRuleTree({ title: 't', messages: longMessages });
check('超过50轮时截断为50个分支', rule3.nodeData.children.length === 50);
check('截断标记为 true', rule3.truncated === true);
check('保留最近轮次（最后一轮为第60轮）', rule3.nodeData.children[49].topic.startsWith('60.'));
check('截断后 ref 仍指向正确消息', rule3.nodeData.children[49].ref === 118);

// ---------- AI 转录 ----------
console.log('[buildTranscript]');
const tr = T.buildTranscript(conv);
check('转录包含第1轮用户标注', tr.transcript.includes('【第1轮·用户】'));
check('转录包含第2轮助手标注', tr.transcript.includes('【第2轮·助手】'));
check('rounds 保留轮次映射', tr.rounds.length === 2 && tr.rounds[1].userIndex === 2);
check('无截断', tr.truncated === false);

// ---------- AI 树清洗 ----------
console.log('[sanitizeAiTree]');
const payload = new Map();
const aiRoot = T.sanitizeAiTree(
  {
    topic: '对话主题',
    children: [
      { topic: '要点A', ref: 2 },
      { topic: '要点B', ref: [1], children: [{ topic: '子要点', ref: 99 }] },
      { topic: '无引用要点' },
      { ref: 1 }, // 缺 topic
    ],
  },
  tr.rounds,
  payload
);
check('根节点 topic 保留', aiRoot.topic === '对话主题');
check('ref=2 解析为 userIndex 2', payload.get(aiRoot.children[0].id) === 2);
check('数组 ref 取第一个并解析为 index 0', payload.get(aiRoot.children[1].id) === 0);
check('非法 ref(99) 被剔除，节点保留', aiRoot.children[1].children[0].ref === undefined && aiRoot.children[1].children[0].topic === '子要点');
check('无 ref 节点不写入 payload', ![...payload.values()].includes(undefined));
check('缺失 topic 补（空节点）', aiRoot.children[3].topic === '（空节点）');
check('超过8个子节点被截断', (() => {
  const payload2 = new Map();
  const node = T.sanitizeAiTree(
    { topic: 'x', children: Array.from({ length: 12 }, (_, i) => ({ topic: 'c' + i, ref: 1 })) },
    tr.rounds,
    payload2
  );
  return node.children.length === 8;
})());

// ---------- JSON 宽松解析 ----------
console.log('[parseJsonLoose]');
check('纯 JSON', T.parseJsonLoose('{"topic":"a"}').topic === 'a');
check('带 json 围栏', T.parseJsonLoose('```json\n{"topic":"b"}\n```').topic === 'b');
check('带前后缀文本', T.parseJsonLoose('结果如下：{"topic":"c"} 以上。').topic === 'c');

// ---------- 深度防护 ----------
console.log('[深度防护]');
const deep = { topic: 'L1', children: [{ topic: 'L2', children: [{ topic: 'L3', children: [{ topic: 'L4', children: [{ topic: 'L5', children: [{ topic: 'L6' }] }] }] }] }] };
const deepRoot = T.sanitizeAiTree(deep, tr.rounds, new Map());
check('超过5层的分支被剪掉', (() => {
  let maxDepth = 0;
  (function d(n, depth) {
    maxDepth = Math.max(maxDepth, depth);
    (n.children || []).forEach((c) => d(c, depth + 1));
  })(deepRoot, 1);
  return maxDepth <= 5;
})());

// ---------- 预览函数 ----------
console.log('[preview]');
check('首行预览', T.preview('第一行\n第二行', 20) === '第一行');
check('超长截断加省略号', T.preview('x'.repeat(50), 10) === 'x'.repeat(10) + '…');

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
