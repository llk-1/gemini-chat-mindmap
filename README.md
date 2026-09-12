# Gemini Chat MindMap

读取网页版 Gemini（gemini.google.com）当前会话的聊天记录，在浏览器侧边栏生成思维导图，并支持导图与原文双向跳转定位。

## 功能

- **规则解析**：按对话轮次自动生成导图，即时、零成本；长回答按标题/段落切分为子分支
- **AI 总结**（可选）：调用 DeepSeek API（`deepseek-chat`）将对话提炼为层级大纲，带来源的节点可跳转原文
- **双向跳转**：
  - 导图 → 原文：点击导图节点，页面滚动定位到对应消息并闪烁高亮
  - 原文 → 导图：悬停页面消息出现"导图"按钮，点击后侧边栏展开并高亮对应节点（侧边栏未打开时会自动打开）
- **导出**：右上角「导出」支持导出 PDF（按导图实际尺寸整页输出）和 XMind 文件（2020+ 格式，可在 XMind 中直接打开编辑）
- 会话内容变化后提示刷新；超过 50 轮仅展示最近 50 轮

## 安装（开发者模式）

1. 打开 `chrome://extensions`
2. 开启右上角"开发者模式"
3. 点击"加载已解压的扩展程序"，选择本目录
4. 打开 gemini.google.com 任一会话，点击工具栏插件图标打开侧边栏，点"生成导图"

> 要求 Chrome 116+。若 Gemini 页面在安装扩展前已打开，请先刷新页面。

## AI 总结配置

1. 在侧边栏右上角点"设置"
2. 填入 DeepSeek API Key（[获取地址](https://platform.deepseek.com/api_keys)），可点"测试连接"验证
3. 切换到"AI 总结"模式后点"生成导图"

API Key 仅保存在本机（`chrome.storage.local`），只用于直连 `api.deepseek.com`。

## 项目结构

```
manifest.json            # MV3 配置（权限：sidePanel、storage）
background.js            # Service Worker：侧边栏开关 + 原文→导图请求中转
content/content.js       # 内容脚本：DOM 解析、定位高亮、悬停按钮
content/content.css      # 页面内注入样式（gmm- 前缀）
sidepanel/               # 侧边栏 UI 与导图渲染（mind-elixir 5.15.1）
sidepanel/treeBuilder.js # 树构建纯函数（有单元测试）
options/                 # DeepSeek API Key 设置页
lib/                     # vendored 库：mind-elixir 5.15.1、jspdf 2.5.2、jszip 3.10.1
scripts/                 # 图标生成与单元测试
```

## 测试

```bash
node scripts/test_tree_builder.js   # 树构建逻辑单元测试（34 项）
```

## 维护提示

Gemini 前端 DOM 结构（`user-query`、`model-response` 等自定义元素与混淆类名）会随版本更新变化。若解析失效，请：

1. 在 Gemini 页面用 DevTools 检查消息节点的元素名/类名
2. 更新 `content/content.js` 顶部的 `USER_SEL` / `MODEL_SEL` 与 `findMessageEls()` 的降级选择器链

## 已知边界

- 仅支持 Chrome（MV3），仅处理当前打开的会话（不读取历史会话列表）
- AI 总结质量取决于 DeepSeek 返回结构，异常返回会以错误提示呈现，可重试
