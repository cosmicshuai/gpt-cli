## Task: Interactive GPT CLI Tool with Ink

**目标**: 使用 Node.js + Ink (React for CLI) 创建一个类似 Claude Code 的交互式 GPT 聊天 CLI 工具。

**技术栈**:
- Node.js + TypeScript
- Ink (React for CLI)
- OpenAI API
- Ink-spinner / Ink-text-input (交互组件)

**功能要求**:
1. **交互式界面**: 类似 Claude Code 的 UI，有输入框和消息历史
2. **Streaming 显示**: GPT 回复时逐字显示（打字机效果）
3. **支持 clear 命令**: 输入 `/clear` 清空对话历史
4. **对话历史**: 保持上下文，支持多轮对话
5. **配置加载**: 从环境变量读取 OPENAI_API_KEY

**项目结构**:
```
gpt-cli/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.tsx          # 入口文件
│   ├── components/
│   │   ├── Chat.tsx       # 主聊天界面
│   │   ├── Message.tsx    # 单条消息组件
│   │   ├── Input.tsx      # 输入框组件
│   │   └── Thinking.tsx   # GPT thinking 状态
│   ├── hooks/
│   │   └── useOpenAI.ts   # OpenAI API hook
│   └── types.ts           # 类型定义
└── .env.example
```

**核心功能实现**:
1. 使用 Ink 的 `useInput` 处理键盘输入
2. 使用 OpenAI 的 `stream: true` 实现逐字输出
3. 使用 React state 管理消息历史
4. 解析 `/clear` 等特殊命令

**依赖包**:
- `ink`
- `react`
- `openai`
- `ink-text-input`
- `ink-spinner`
- `chalk`
- `dotenv`

**安装步骤**:
```bash
npm init -y
npm install ink react react-dom openai ink-text-input ink-spinner chalk dotenv
npm install -D typescript @types/react @types/node ts-node
```

**验收标准**:
- [ ] 运行 `npm start` 启动 CLI 工具
- [ ] 能正常输入消息并发送给 GPT
- [ ] GPT 回复是 streaming 逐字显示
- [ ] 输入 `/clear` 清空历史
- [ ] UI 美观，有类似 Claude Code 的视觉效果
- [ ] 支持上下箭头浏览历史消息
- [ ] 正确处理错误和网络问题

**参考项目**:
- Claude Code (github.com/anthropics/claude-code)
- Ink 文档 (github.com/vadimdemedes/ink)

**输出要求**:
- 完整的可运行代码
- README.md 说明如何安装和使用
- .env.example 配置文件示例