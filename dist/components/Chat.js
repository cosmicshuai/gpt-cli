import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { Highlight } from 'ink-highlight';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { homedir } from 'os';
import { join, resolve, extname } from 'path';
import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises';
import { encode } from 'gpt-tokenizer';
dotenv.config();
const COMMANDS = [
    { name: '/clear', description: 'Clear chat history' },
    { name: '/exit', description: 'Exit the application' },
    { name: '/quit', description: 'Exit the application (alias)' },
    { name: '/model', description: 'Switch AI model', usage: '/model <model-name>' },
    { name: '/models', description: 'List available models' },
    { name: '/help', description: 'Show this help message' },
    { name: '/sessions', description: 'List recent sessions' },
    { name: '/resume', description: 'Resume a session', usage: '/resume <id>' },
    { name: '/new', description: 'Start a new session' },
];
const AVAILABLE_MODELS = [
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'o1',
    'o3-mini',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-3.5-turbo',
];
const CONFIG_DIR = join(homedir(), '.config', 'gpt-cli');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const HISTORY_DIR = join(CONFIG_DIR, 'history');
const MAX_HISTORY_SESSIONS = 50;
// Virtual scroll constants
const DEFAULT_TERMINAL_ROWS = 24;
const RESERVED_CHROME_ROWS = 8; // rows used by header, input, and other UI chrome
const MIN_VISIBLE_MESSAGES = 3;
const ROWS_PER_MESSAGE_OVERHEAD = 3; // marginY, role header, padding
const TERMINAL_COLS_FALLBACK = 80;
// Estimate how many terminal rows a message will occupy
const estimateMessageRows = (message, terminalCols) => {
    const content = message.content || '';
    const lines = content.split('\n');
    const usableCols = Math.max(1, terminalCols - 2); // account for 2-char left padding
    let rows = ROWS_PER_MESSAGE_OVERHEAD;
    for (const line of lines) {
        // Each line wraps based on terminal width; empty lines still occupy 1 row
        rows += line.length === 0 ? 1 : Math.ceil(line.length / usableCols);
    }
    return rows;
};
// Calculate tokens for messages
const calculateTokens = (messages) => {
    const text = messages.map(m => m.content).join('\n');
    return encode(text).length;
};
// Get model token limit
const getModelTokenLimit = (model) => {
    if (model.includes('gpt-4'))
        return 128000;
    if (model.includes('gpt-3.5'))
        return 16385;
    return 128000;
};
// Format number with commas
const formatNumber = (num) => {
    return num.toLocaleString();
};
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
// Scan files for @file autocomplete
const scanFiles = async (query) => {
    try {
        const cwd = process.cwd();
        const dir = query.includes('/')
            ? query.substring(0, query.lastIndexOf('/')) || cwd
            : cwd;
        const prefix = query.includes('/')
            ? query.substring(query.lastIndexOf('/') + 1)
            : query;
        const files = await readdir(dir);
        return files
            .filter(f => f.startsWith(prefix))
            .map(f => join(dir, f))
            .slice(0, 10);
    }
    catch {
        return [];
    }
};
// Read file content for @file reference
const readFileContent = async (filePath) => {
    try {
        const fullPath = resolve(filePath);
        const content = await readFile(fullPath, 'utf-8');
        // Truncate if too large (>1000 lines)
        const lines = content.split('\n');
        const truncated = lines.length > 1000
            ? lines.slice(0, 1000).join('\n') + '\n\n... (truncated, 1000+ lines)'
            : content;
        const ext = extname(fullPath).slice(1) || 'txt';
        return `## File: ${filePath}\n\n\`\`\`${ext}\n${truncated}\n\`\`\``;
    }
    catch {
        return null;
    }
};
// Generate a unique session ID
const generateSessionId = () => {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};
// Ensure config directories exist
const ensureConfigDir = async () => {
    try {
        await mkdir(CONFIG_DIR, { recursive: true });
        await mkdir(HISTORY_DIR, { recursive: true });
    }
    catch {
        // Ignore errors, directory might already exist
    }
};
// Load config from file
const loadConfig = async () => {
    try {
        const data = await readFile(CONFIG_FILE, 'utf-8');
        const config = JSON.parse(data);
        // Validate that the model is available
        if (!AVAILABLE_MODELS.includes(config.currentModel)) {
            config.currentModel = 'gpt-4o-mini';
        }
        return config;
    }
    catch {
        // Return default config if file doesn't exist or is invalid
        return { currentModel: 'gpt-4o-mini' };
    }
};
// Save config to file
const saveConfig = async (config) => {
    try {
        await ensureConfigDir();
        await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    }
    catch {
        // Ignore save errors
    }
};
// Load a session from history
const loadSession = async (sessionId) => {
    try {
        const filePath = join(HISTORY_DIR, `${sessionId}.json`);
        const data = await readFile(filePath, 'utf-8');
        return JSON.parse(data);
    }
    catch {
        return null;
    }
};
// Save a session to history
const saveSession = async (session) => {
    try {
        await ensureConfigDir();
        const filePath = join(HISTORY_DIR, `${session.id}.json`);
        await writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
    }
    catch {
        // Ignore save errors
    }
};
// List all sessions, sorted by updatedAt desc
const listSessions = async () => {
    try {
        const files = await readdir(HISTORY_DIR);
        const sessions = [];
        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const filePath = join(HISTORY_DIR, file);
                    const data = await readFile(filePath, 'utf-8');
                    const session = JSON.parse(data);
                    sessions.push(session);
                }
                catch {
                    // Skip invalid session files
                }
            }
        }
        // Sort by updatedAt desc and take last 10
        return sessions
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 10);
    }
    catch {
        return [];
    }
};
// Clean up old sessions, keep only MAX_HISTORY_SESSIONS most recent
const cleanupOldSessions = async () => {
    try {
        const files = await readdir(HISTORY_DIR);
        const sessions = [];
        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const filePath = join(HISTORY_DIR, file);
                    const data = await readFile(filePath, 'utf-8');
                    const session = JSON.parse(data);
                    sessions.push({ file, updatedAt: session.updatedAt });
                }
                catch {
                    // Skip invalid session files
                }
            }
        }
        if (sessions.length > MAX_HISTORY_SESSIONS) {
            // Sort by updatedAt asc and delete oldest ones
            const toDelete = sessions
                .sort((a, b) => a.updatedAt - b.updatedAt)
                .slice(0, sessions.length - MAX_HISTORY_SESSIONS);
            for (const { file } of toDelete) {
                try {
                    await unlink(join(HISTORY_DIR, file));
                }
                catch {
                    // Ignore delete errors
                }
            }
        }
    }
    catch {
        // Ignore cleanup errors
    }
};
// Generate a title for the session using GPT-4o-mini
const generateSessionTitle = async (firstMessage) => {
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'Generate a short, concise title (3-5 words) for a conversation that starts with this message. Respond with ONLY the title, no quotes or explanation.'
                },
                { role: 'user', content: firstMessage }
            ],
            max_tokens: 20,
        });
        const title = response.choices[0]?.message?.content?.trim() || 'Untitled';
        // Remove quotes if present
        return title.replace(/^["']|["']$/g, '');
    }
    catch {
        // Fallback to first few words
        const words = firstMessage.split(' ').slice(0, 5).join(' ');
        return words.length > 30 ? words.substring(0, 30) + '...' : words;
    }
};
// Component to render message content with code blocks
const MessageContent = ({ content, isStreaming, streamingContent }) => {
    const displayContent = isStreaming ? streamingContent : content;
    if (!displayContent)
        return null;
    // Split content by code blocks
    const parts = displayContent.split(/(```[\s\S]*?```)/);
    return (React.createElement(React.Fragment, null, parts.map((part, index) => {
        if (part.startsWith('```')) {
            // Parse code block
            const match = part.match(/```(\w+)?\n([\s\S]*?)```/);
            if (match) {
                const [, lang, code] = match;
                return (React.createElement(Box, { key: index, flexDirection: "column", marginY: 1 },
                    React.createElement(Box, { borderStyle: "single", borderColor: "gray", paddingX: 1 },
                        React.createElement(Text, { color: "cyan" },
                            "\uD83D\uDCC4 ",
                            lang || 'code',
                            " ")),
                    React.createElement(Box, { borderStyle: "round", borderColor: "gray", paddingX: 1, marginLeft: 2 }, lang ? (React.createElement(Highlight, { code: code.trim(), language: lang, theme: "dark" })) : (React.createElement(Text, null, code.trim())))));
            }
        }
        // Regular text - split by newlines
        return part.split('\n').map((line, lineIndex) => (React.createElement(Text, { key: `${index}-${lineIndex}` }, line || ' ')));
    })));
};
const Chat = () => {
    const { exit } = useApp();
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isThinking, setIsThinking] = useState(false);
    const [streamingContent, setStreamingContent] = useState('');
    const [currentModel, setCurrentModel] = useState('gpt-4o-mini');
    const [sessionId, setSessionId] = useState('');
    const [sessionTitle, setSessionTitle] = useState('');
    const [isInitialized, setIsInitialized] = useState(false);
    const [pendingSession, setPendingSession] = useState(null);
    // Command completion state
    const [showCommands, setShowCommands] = useState(false);
    const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
    const [filteredCommands, setFilteredCommands] = useState([]);
    // Model selection state
    const [showModelSelector, setShowModelSelector] = useState(false);
    const [selectedModelIndex, setSelectedModelIndex] = useState(0);
    // File attachment state
    const [showFileSelector, setShowFileSelector] = useState(false);
    const [fileList, setFileList] = useState([]);
    const [selectedFileIndex, setSelectedFileIndex] = useState(0);
    const [attachedFiles, setAttachedFiles] = useState([]);
    // Virtual scroll state
    const [scrollOffset, setScrollOffset] = useState(0);
    const { stdout } = useStdout();
    const terminalRows = stdout.rows || DEFAULT_TERMINAL_ROWS;
    const terminalCols = stdout.columns || TERMINAL_COLS_FALLBACK;
    const availableRows = terminalRows - RESERVED_CHROME_ROWS;
    // Dynamically compute how many messages fit by estimating rows from the bottom
    const computeMaxVisible = useCallback(() => {
        if (messages.length === 0)
            return MIN_VISIBLE_MESSAGES;
        let usedRows = 0;
        let count = 0;
        const endIdx = Math.max(0, messages.length - scrollOffset);
        for (let i = endIdx - 1; i >= 0; i--) {
            const rowsNeeded = estimateMessageRows(messages[i], terminalCols);
            if (usedRows + rowsNeeded > availableRows && count >= MIN_VISIBLE_MESSAGES)
                break;
            usedRows += rowsNeeded;
            count++;
        }
        return Math.max(MIN_VISIBLE_MESSAGES, count);
    }, [availableRows, terminalCols, messages, scrollOffset]);
    const maxVisibleMessages = computeMaxVisible();
    // Use ref to track if title has been generated
    const titleGeneratedRef = useRef(false);
    // Use ref to track latest messages for avoiding stale closure
    const messagesRef = useRef([]);
    // Use ref to preserve createdAt timestamp across saves
    const sessionCreatedAtRef = useRef(0);
    // Session start time for duration tracking
    const sessionStartTimeRef = useRef(Date.now());
    // Initialize config on mount
    useEffect(() => {
        const init = async () => {
            await ensureConfigDir();
            const config = await loadConfig();
            setCurrentModel(config.currentModel);
            // Generate new session ID
            const newSessionId = generateSessionId();
            setSessionId(newSessionId);
            // Check for last session
            if (config.lastSessionId) {
                const session = await loadSession(config.lastSessionId);
                if (session && session.messages.length > 0) {
                    setPendingSession(session);
                }
            }
            setIsInitialized(true);
        };
        init();
    }, []);
    // Save config when model changes
    useEffect(() => {
        if (isInitialized) {
            const updateConfig = async () => {
                const config = await loadConfig();
                config.currentModel = currentModel;
                config.lastSessionId = sessionId;
                await saveConfig(config);
            };
            updateConfig();
        }
    }, [currentModel, sessionId, isInitialized]);
    // Sync messagesRef with latest messages
    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);
    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
        setScrollOffset(0);
    }, [messages.length]);
    // Clamp scrollOffset when terminal resizes to prevent blank space
    useEffect(() => {
        setScrollOffset(prev => {
            const maxOffset = Math.max(0, messages.length - MIN_VISIBLE_MESSAGES);
            return Math.min(prev, maxOffset);
        });
    }, [terminalRows, terminalCols, messages.length]);
    // Compute visible messages window
    const totalMessages = messages.length;
    const startIndex = Math.max(0, totalMessages - maxVisibleMessages - scrollOffset);
    const endIndex = Math.max(0, totalMessages - scrollOffset);
    const visibleMessages = messages.slice(startIndex, endIndex);
    const hasMoreAbove = startIndex > 0;
    const hasMoreBelow = scrollOffset > 0;
    // Auto-save session when messages change
    useEffect(() => {
        if (isInitialized && messages.length > 0 && sessionId) {
            const saveCurrentSession = async () => {
                const session = {
                    id: sessionId,
                    title: sessionTitle || 'Untitled',
                    createdAt: sessionCreatedAtRef.current || Date.now(),
                    updatedAt: Date.now(),
                    messages,
                    model: currentModel,
                };
                await saveSession(session);
                await cleanupOldSessions();
            };
            saveCurrentSession();
        }
    }, [messages, sessionId, sessionTitle, currentModel, isInitialized]);
    // Filter commands when input starts with /
    useEffect(() => {
        if (input.startsWith('/')) {
            const query = input.toLowerCase();
            const filtered = COMMANDS.filter(cmd => cmd.name.toLowerCase().startsWith(query));
            setFilteredCommands(filtered);
            setShowCommands(filtered.length > 0 && input.length > 0 && !showModelSelector && !showFileSelector);
            setSelectedCommandIndex(0);
        }
        else {
            setShowCommands(false);
        }
    }, [input, showModelSelector, showFileSelector]);
    // File autocomplete when input contains @
    useEffect(() => {
        const atIndex = input.lastIndexOf('@');
        if (atIndex !== -1) {
            const afterAt = input.substring(atIndex + 1);
            // Only trigger if no space after @ and not in the middle of a word
            if (!afterAt.includes(' ') && !input.substring(atIndex - 1, atIndex).match(/\w/)) {
                scanFiles(afterAt).then(files => {
                    setFileList(files);
                    setShowFileSelector(files.length > 0);
                    setSelectedFileIndex(0);
                });
            }
            else {
                setShowFileSelector(false);
            }
        }
        else {
            setShowFileSelector(false);
        }
    }, [input]);
    const handleCommandSelect = useCallback((cmd) => {
        if (cmd.name === '/models' || cmd.name === '/model') {
            // Show model selector instead of just setting input
            setShowModelSelector(true);
            setShowCommands(false);
            // Find current model index
            const currentIndex = AVAILABLE_MODELS.indexOf(currentModel);
            setSelectedModelIndex(currentIndex >= 0 ? currentIndex : 0);
            setInput('');
        }
        else {
            setInput(cmd.name + ' ');
            setShowCommands(false);
        }
    }, [currentModel]);
    const handleModelSelect = useCallback((modelIndex) => {
        const selectedModel = AVAILABLE_MODELS[modelIndex];
        if (selectedModel) {
            setCurrentModel(selectedModel);
            setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `🤖 Model switched to ${selectedModel}`
                }]);
        }
        setShowModelSelector(false);
        setInput('');
    }, []);
    const handleModelSwitch = useCallback((modelName) => {
        const trimmedModel = modelName.trim();
        if (AVAILABLE_MODELS.includes(trimmedModel)) {
            setCurrentModel(trimmedModel);
            setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `🤖 Model switched to ${trimmedModel}`
                }]);
        }
        else {
            setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `⚠️ Unknown model: ${trimmedModel}\n\nAvailable models:\n${AVAILABLE_MODELS.join('\n')}`
                }]);
        }
    }, []);
    const showHelp = useCallback(() => {
        const helpText = COMMANDS.map(cmd => `  ${cmd.name.padEnd(12)} ${cmd.description}${cmd.usage ? ` · ${cmd.usage}` : ''}`).join('\n');
        setMessages(prev => [...prev, {
                role: 'assistant',
                content: `📖 Available Commands

${helpText}

⌨️  Keyboard Shortcuts
  Ctrl+R       Regenerate last response
  Ctrl+L       Clear chat history
  Ctrl+P / ↑   Edit last user message
  Ctrl+U       Scroll up messages
  Ctrl+D       Scroll down messages
  Shift+Enter  Insert new line (multiline)
  ESC          Exit / Cancel selection

💡 Tips
• Type / and use ↑↓ to select commands
• Use @filename to attach files
• Use Shift+Enter for multiline messages`
            }]);
    }, []);
    const showModels = useCallback(() => {
        setShowModelSelector(true);
        const currentIndex = AVAILABLE_MODELS.indexOf(currentModel);
        setSelectedModelIndex(currentIndex >= 0 ? currentIndex : 0);
    }, [currentModel]);
    const showSessions = useCallback(async () => {
        const sessions = await listSessions();
        if (sessions.length === 0) {
            setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: '💭 No saved sessions found.'
                }]);
            return;
        }
        const sessionList = sessions.map((s, i) => {
            const date = new Date(s.updatedAt).toLocaleDateString();
            const time = new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const isCurrent = s.id === sessionId;
            return `  ${i + 1}. ${isCurrent ? '▸ ' : '  '}${s.title} · ${date} ${time} · ${s.messages.length} messages${isCurrent ? ' (current)' : ''}`;
        }).join('\n');
        setMessages(prev => [...prev, {
                role: 'assistant',
                content: `📚 Recent Sessions (last 10)\n\n${sessionList}\n\n💡 Use /resume <id> to restore a session`
            }]);
    }, [sessionId]);
    const resumeSession = useCallback(async (targetSessionId) => {
        // Try to find session by full ID or partial match
        const sessions = await listSessions();
        const session = sessions.find(s => s.id.startsWith(targetSessionId)) || await loadSession(targetSessionId);
        if (session) {
            setMessages(session.messages);
            setCurrentModel(session.model);
            setSessionId(session.id);
            setSessionTitle(session.title);
            sessionCreatedAtRef.current = session.createdAt;
            sessionStartTimeRef.current = Date.now();
            titleGeneratedRef.current = true;
            setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `✨ Resumed session: "${session.title}"`
                }]);
        }
        else {
            setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `❌ Session not found: ${targetSessionId}`
                }]);
        }
    }, []);
    const startNewSession = useCallback(() => {
        setMessages([]);
        const newSessionId = generateSessionId();
        setSessionId(newSessionId);
        setSessionTitle('');
        titleGeneratedRef.current = false;
        sessionCreatedAtRef.current = Date.now();
        sessionStartTimeRef.current = Date.now();
        setMessages(prev => [...prev, {
                role: 'assistant',
                content: '✨ Started new session'
            }]);
    }, []);
    // Format duration from milliseconds to human-readable string
    const formatDuration = (ms) => {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        }
        if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        }
        return `${seconds}s`;
    };
    // Show exit statistics with a beautiful panel
    const showExitStats = useCallback(async () => {
        const duration = Date.now() - sessionStartTimeRef.current;
        const userMessages = messages.filter(m => m.role === 'user').length;
        const assistantMessages = messages.filter(m => m.role === 'assistant').length;
        const totalMessages = userMessages + assistantMessages;
        const totalTokens = calculateTokens(messages);
        // Create the stats panel
        const title = sessionTitle || 'Untitled Session';
        const displayTitle = title.length > 35 ? title.substring(0, 35) + '...' : title;
        const durationStr = formatDuration(duration);
        const tokensStr = formatNumber(totalTokens);
        // Print exit stats panel
        console.clear();
        console.log('');
        console.log('╔══════════════════════════════════════════════════════╗');
        console.log('║                                                      ║');
        console.log('║           👋  Thanks for chatting!                   ║');
        console.log('║                                                      ║');
        console.log('╠══════════════════════════════════════════════════════╣');
        console.log(`║  📋  Session : ${displayTitle.padEnd(39)}║`);
        console.log(`║  ⏱️   Duration : ${durationStr.padEnd(37)}║`);
        console.log(`║  💬  Messages: ${String(totalMessages).padStart(3)}  (${String(userMessages).padStart(2)} user · ${String(assistantMessages).padStart(2)} assistant)       ║`);
        console.log(`║  🤖  Model   : ${currentModel.padEnd(39)}║`);
        console.log(`║  🪙  Tokens  : ${tokensStr.padEnd(39)}║`);
        console.log('╚══════════════════════════════════════════════════════╝');
        console.log('');
        console.log('              Have a great day! ✨');
        console.log('');
        // Wait 1.5 seconds before exiting
        await new Promise(resolve => setTimeout(resolve, 1500));
        exit();
    }, [messages, sessionTitle, currentModel, exit]);
    const handleResumePrompt = useCallback((accept) => {
        if (accept && pendingSession) {
            setMessages(pendingSession.messages);
            setCurrentModel(pendingSession.model);
            setSessionId(pendingSession.id);
            setSessionTitle(pendingSession.title);
            titleGeneratedRef.current = true;
            sessionStartTimeRef.current = Date.now();
            setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `✨ Resumed session: "${pendingSession.title}"`
                }]);
        }
        else {
            // Start fresh with new session ID
            const newSessionId = generateSessionId();
            setSessionId(newSessionId);
            sessionStartTimeRef.current = Date.now();
        }
        setPendingSession(null);
    }, [pendingSession]);
    const handleSubmit = useCallback(async (value) => {
        // 阻止并发请求
        if (isLoading || isThinking) {
            return;
        }
        if (showCommands || showModelSelector || showFileSelector) {
            return;
        }
        if (!value.trim())
            return;
        const trimmedValue = value.trim();
        // Handle commands
        if (trimmedValue === '/clear') {
            setMessages([]);
            setInput('');
            return;
        }
        if (trimmedValue === '/exit' || trimmedValue === '/quit') {
            await showExitStats();
            return;
        }
        if (trimmedValue === '/help') {
            showHelp();
            setInput('');
            return;
        }
        if (trimmedValue === '/models') {
            showModels();
            setInput('');
            return;
        }
        if (trimmedValue.startsWith('/model ')) {
            const modelName = trimmedValue.slice(7).trim();
            handleModelSwitch(modelName);
            setInput('');
            return;
        }
        if (trimmedValue === '/model') {
            showModels();
            setInput('');
            return;
        }
        if (trimmedValue === '/sessions') {
            await showSessions();
            setInput('');
            return;
        }
        if (trimmedValue.startsWith('/resume ')) {
            const targetSessionId = trimmedValue.slice(8).trim();
            await resumeSession(targetSessionId);
            setInput('');
            return;
        }
        if (trimmedValue === '/new') {
            startNewSession();
            setInput('');
            return;
        }
        // Parse file references from attachedFiles
        let finalContent = trimmedValue;
        if (attachedFiles.length > 0) {
            const fileContents = [];
            for (const filePath of attachedFiles) {
                const fullPath = resolve(filePath);
                try {
                    const content = await readFile(fullPath, 'utf-8');
                    // Truncate if too large (>1000 lines)
                    const lines = content.split('\n');
                    const truncated = lines.length > 1000
                        ? lines.slice(0, 1000).join('\n') + '\n\n... (truncated, 1000+ lines)'
                        : content;
                    fileContents.push(`文件"${filePath}", 内容是：\n\`\`\`\n${truncated}\n\`\`\``);
                }
                catch {
                    // If file can't be read, add error message
                    fileContents.push(`[无法读取文件: ${filePath}]`);
                }
            }
            finalContent = finalContent + '\n\n' + fileContents.join('\n\n');
        }
        const userMessage = { role: 'user', content: finalContent };
        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setAttachedFiles([]);
        setIsLoading(true);
        setIsThinking(true);
        setStreamingContent('');
        // Generate title on first user message if not already generated
        if (!titleGeneratedRef.current && messages.length === 0) {
            titleGeneratedRef.current = true;
            const title = await generateSessionTitle(value);
            setSessionTitle(title);
        }
        try {
            const stream = await openai.chat.completions.create({
                model: currentModel,
                messages: [
                    ...messages.map(m => ({ role: m.role, content: m.content })),
                    { role: 'user', content: finalContent }
                ],
                stream: true,
            });
            let fullContent = '';
            setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: '',
                    isStreaming: true,
                    model: currentModel
                }]);
            for await (const chunk of stream) {
                setIsThinking(false);
                const content = chunk.choices[0]?.delta?.content || '';
                fullContent += content;
                setStreamingContent(fullContent);
            }
            setMessages(prev => {
                const newMessages = [...prev];
                const lastMessage = newMessages[newMessages.length - 1];
                if (lastMessage.role === 'assistant') {
                    lastMessage.content = fullContent;
                    lastMessage.isStreaming = false;
                    lastMessage.model = currentModel;
                }
                return newMessages;
            });
        }
        catch (error) {
            setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
                }]);
        }
        finally {
            setIsLoading(false);
            setStreamingContent('');
            setIsThinking(false);
        }
    }, [messages, exit, currentModel, showHelp, showModels, handleModelSwitch, showCommands, showModelSelector, showFileSelector, showSessions, resumeSession, startNewSession, sessionTitle, attachedFiles, isLoading, isThinking]);
    // Regenerate last assistant response
    const regenerateLastResponse = useCallback(async () => {
        // Use messagesRef.current to get latest messages and avoid stale closure
        const latestMessages = messagesRef.current;
        // Find last assistant message (iterate backwards)
        let lastAssistantIndex = -1;
        for (let i = latestMessages.length - 1; i >= 0; i--) {
            if (latestMessages[i].role === 'assistant') {
                lastAssistantIndex = i;
                break;
            }
        }
        if (lastAssistantIndex === -1)
            return;
        // Find corresponding user message (iterate backwards from assistant)
        let lastUserIndex = -1;
        for (let i = lastAssistantIndex - 1; i >= 0; i--) {
            if (latestMessages[i].role === 'user') {
                lastUserIndex = i;
                break;
            }
        }
        if (lastUserIndex === -1)
            return;
        const userMessage = latestMessages[lastUserIndex];
        // Remove assistant message and all after it
        const newMessages = latestMessages.slice(0, lastAssistantIndex);
        setMessages(newMessages);
        // Resubmit user message
        setInput(userMessage.content);
        // Use setTimeout to ensure state update before submit
        setTimeout(() => handleSubmit(userMessage.content), 0);
    }, [handleSubmit]);
    // Edit last user message
    const editLastUserMessage = useCallback(() => {
        // Use messagesRef.current to get latest messages and avoid stale closure
        const latestMessages = messagesRef.current;
        let lastUserMessage;
        for (let i = latestMessages.length - 1; i >= 0; i--) {
            if (latestMessages[i].role === 'user') {
                lastUserMessage = latestMessages[i];
                break;
            }
        }
        if (lastUserMessage) {
            setInput(lastUserMessage.content);
        }
    }, []);
    // Handle keyboard navigation
    useInput((ch, key) => {
        // Handle Shift+Enter for new line (multiline input)
        if (key.return && key.shift) {
            setInput(prev => prev + '\n');
            return;
        }
        // Handle keyboard shortcuts (Ctrl+key)
        if (key.ctrl && ch) {
            // Ctrl+R: Regenerate last response
            if (ch.toLowerCase() === 'r') {
                regenerateLastResponse();
                return;
            }
            // Ctrl+L: Clear screen
            if (ch.toLowerCase() === 'l') {
                setMessages([]);
                return;
            }
            // Ctrl+P or Ctrl+↑: Edit last user message
            if (ch.toLowerCase() === 'p' || key.upArrow) {
                editLastUserMessage();
                return;
            }
            // Ctrl+U: Scroll up messages
            if (ch.toLowerCase() === 'u') {
                const maxScrollOffset = Math.max(0, messages.length - maxVisibleMessages);
                setScrollOffset(prev => Math.min(prev + maxVisibleMessages, maxScrollOffset));
                return;
            }
            // Ctrl+D: Scroll down messages
            if (ch.toLowerCase() === 'd') {
                setScrollOffset(prev => Math.max(0, prev - maxVisibleMessages));
                return;
            }
        }
        // Handle resume prompt Y/N
        if (pendingSession) {
            if (ch.toLowerCase() === 'y') {
                handleResumePrompt(true);
                return;
            }
            if (ch.toLowerCase() === 'n') {
                handleResumePrompt(false);
                return;
            }
            return; // Ignore other inputs while showing resume prompt
        }
        if (key.escape) {
            if (showFileSelector) {
                setShowFileSelector(false);
            }
            else if (showModelSelector) {
                setShowModelSelector(false);
            }
            else if (showCommands) {
                setShowCommands(false);
            }
            else {
                exit();
            }
        }
        // File selector keyboard navigation
        if (showFileSelector) {
            if (key.upArrow) {
                setSelectedFileIndex(prev => prev > 0 ? prev - 1 : fileList.length - 1);
            }
            if (key.downArrow) {
                setSelectedFileIndex(prev => prev < fileList.length - 1 ? prev + 1 : 0);
            }
            if (key.return || key.tab) {
                const selectedFile = fileList[selectedFileIndex];
                if (selectedFile) {
                    const atIndex = input.lastIndexOf('@');
                    const beforeAt = input.substring(0, atIndex);
                    // Add filename without @ symbol to input
                    setInput(beforeAt + selectedFile + ' ');
                    setAttachedFiles(prev => [...prev, selectedFile]);
                    setShowFileSelector(false);
                }
            }
            return; // Block other inputs while file selector is open
        }
        if (showModelSelector) {
            if (key.upArrow) {
                setSelectedModelIndex(prev => prev > 0 ? prev - 1 : AVAILABLE_MODELS.length - 1);
            }
            if (key.downArrow) {
                setSelectedModelIndex(prev => prev < AVAILABLE_MODELS.length - 1 ? prev + 1 : 0);
            }
            if (key.return || key.tab) {
                handleModelSelect(selectedModelIndex);
            }
        }
        else if (showCommands) {
            if (key.upArrow) {
                setSelectedCommandIndex(prev => prev > 0 ? prev - 1 : filteredCommands.length - 1);
            }
            if (key.downArrow) {
                setSelectedCommandIndex(prev => prev < filteredCommands.length - 1 ? prev + 1 : 0);
            }
            if (key.tab || key.return) {
                const selectedCmd = filteredCommands[selectedCommandIndex];
                if (selectedCmd) {
                    handleCommandSelect(selectedCmd);
                }
            }
        }
    });
    // Show loading state while initializing
    if (!isInitialized) {
        return (React.createElement(Box, { flexDirection: "column", height: "100%", justifyContent: "center", alignItems: "center" },
            React.createElement(Text, { color: "cyan" },
                React.createElement(Spinner, { type: "dots" }),
                ' ',
                "Initializing..."),
            React.createElement(Text, { color: "gray" }, "Loading configuration and checking for previous sessions")));
    }
    return (React.createElement(Box, { flexDirection: "column", height: "100%" },
        React.createElement(Box, { borderStyle: "round", borderColor: "cyan", paddingX: 1 },
            React.createElement(Text, { bold: true, color: "cyan" }, "\u26A1 GPT CLI"),
            React.createElement(Text, { color: "gray" }, " \u2502 "),
            React.createElement(Text, { color: "white" }, "Model:"),
            React.createElement(Text, { bold: true, color: "yellow" },
                " ",
                currentModel),
            sessionTitle && (React.createElement(React.Fragment, null,
                React.createElement(Text, { color: "gray" }, " \u2502 "),
                React.createElement(Text, { color: "white" }, "Session:"),
                React.createElement(Text, { bold: true, color: "green" },
                    " ",
                    sessionTitle.length > 20 ? sessionTitle.substring(0, 20) + '...' : sessionTitle))),
            React.createElement(Text, { color: "gray" }, " \u2502 "),
            React.createElement(Text, { color: "gray" },
                "\uD83E\uDE99 ",
                formatNumber(calculateTokens(messages)),
                "/",
                formatNumber(getModelTokenLimit(currentModel))),
            React.createElement(Text, { color: "gray" }, " \u2502 "),
            React.createElement(Text, { bold: true, color: "cyan" }, "/help")),
        pendingSession && (React.createElement(Box, { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 2, marginX: 1, marginY: 1 },
            React.createElement(Text, { bold: true, color: "yellow" }, "\uD83D\uDCBE Resume Previous Session?"),
            React.createElement(Box, { marginY: 1 },
                React.createElement(Text, { color: "white" }, "Session: "),
                React.createElement(Text, { bold: true, color: "green" },
                    "\"",
                    pendingSession.title,
                    "\"")),
            React.createElement(Box, null,
                React.createElement(Text, { color: "gray" },
                    "\uD83D\uDCAC ",
                    pendingSession.messages.length,
                    " messages \u00B7 \uD83D\uDCC5 ",
                    new Date(pendingSession.updatedAt).toLocaleString())),
            React.createElement(Box, { marginTop: 1 },
                React.createElement(Text, { color: "gray" }, "Press "),
                React.createElement(Text, { bold: true, color: "green" }, "Y"),
                React.createElement(Text, { color: "gray" }, " to resume, "),
                React.createElement(Text, { bold: true, color: "red" }, "N"),
                React.createElement(Text, { color: "gray" }, " to start fresh")))),
        React.createElement(Box, { flexDirection: "column", flexGrow: 1, padding: 1 },
            messages.length === 0 && !pendingSession && (React.createElement(Box, { flexDirection: "column" },
                React.createElement(Text, { color: "cyan" }, "\uD83D\uDC4B Welcome! Start typing to chat with GPT."),
                React.createElement(Box, { marginTop: 1 },
                    React.createElement(Text, { color: "gray" }, "\uD83D\uDCA1 Tip: Type "),
                    React.createElement(Text, { bold: true, color: "cyan" }, "/"),
                    React.createElement(Text, { color: "gray" }, " for commands, "),
                    React.createElement(Text, { bold: true, color: "cyan" }, "Shift+Enter"),
                    React.createElement(Text, { color: "gray" }, " for new line")))),
            hasMoreAbove && (React.createElement(Box, null,
                React.createElement(Text, { color: "gray" },
                    "\u25B2 ",
                    startIndex,
                    " earlier message",
                    startIndex !== 1 ? 's' : '',
                    " (Ctrl+U to scroll up)"))),
            visibleMessages.map((message, index) => (React.createElement(Box, { key: startIndex + index, flexDirection: "column", marginY: 1 },
                React.createElement(Box, null,
                    React.createElement(Text, { bold: true, color: message.role === 'user' ? 'green' : 'blue' }, message.role === 'user' ? '🧑 You' : '✨ Assistant'),
                    message.model && message.role === 'assistant' && (React.createElement(Text, { color: "gray" },
                        " \u00B7 ",
                        message.model))),
                React.createElement(Box, { paddingLeft: 2, flexDirection: "column", borderLeft: message.role === 'user', borderColor: message.role === 'user' ? 'green' : 'blue' },
                    React.createElement(MessageContent, { content: message.content, isStreaming: message.isStreaming, streamingContent: streamingContent }))))),
            isThinking && (React.createElement(Box, null,
                React.createElement(Text, { color: "yellow" },
                    React.createElement(Spinner, { type: "dots" }),
                    ' ',
                    "Thinking..."))),
            hasMoreBelow && (React.createElement(Box, null,
                React.createElement(Text, { color: "gray" },
                    "\u25BC ",
                    scrollOffset,
                    " newer message",
                    scrollOffset !== 1 ? 's' : '',
                    " (Ctrl+D to scroll down)")))),
        showModelSelector && (React.createElement(Box, { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1, marginX: 1 },
            React.createElement(Text, { bold: true, color: "yellow" }, "\uD83E\uDD16 Select Model:"),
            AVAILABLE_MODELS.map((model, index) => (React.createElement(Box, { key: model },
                React.createElement(Text, { color: index === selectedModelIndex ? 'yellow' : 'white' }, index === selectedModelIndex ? '● ' : '○ '),
                React.createElement(Text, { bold: index === selectedModelIndex, color: index === selectedModelIndex ? 'yellow' : model === currentModel ? 'green' : 'white' }, model),
                model === currentModel && (React.createElement(Text, { color: "green" }, " \u2713 current"))))),
            React.createElement(Text, { color: "gray" }, "Use \u2191\u2193 to navigate, Enter to select, ESC to cancel"))),
        showCommands && (React.createElement(Box, { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1, marginX: 1 },
            React.createElement(Text, { bold: true, color: "cyan" }, "Commands:"),
            filteredCommands.map((cmd, index) => (React.createElement(Box, { key: cmd.name },
                React.createElement(Text, { color: index === selectedCommandIndex ? 'cyan' : 'white' }, index === selectedCommandIndex ? '● ' : '○ '),
                React.createElement(Text, { bold: index === selectedCommandIndex, color: index === selectedCommandIndex ? 'cyan' : 'white' }, cmd.name),
                React.createElement(Text, { color: "gray" },
                    " \u2014 ",
                    cmd.description)))),
            React.createElement(Text, { color: "gray" }, "Use \u2191\u2193 to navigate, Tab/Enter to select"))),
        showFileSelector && (React.createElement(Box, { flexDirection: "column", borderStyle: "round", borderColor: "magenta", paddingX: 1, marginX: 1, marginBottom: 1 },
            React.createElement(Text, { bold: true, color: "magenta" }, "\uD83D\uDCCE Attach File:"),
            fileList.map((file, index) => (React.createElement(Box, { key: file },
                React.createElement(Text, { color: index === selectedFileIndex ? 'magenta' : 'white' }, index === selectedFileIndex ? '● ' : '○ '),
                React.createElement(Text, { color: index === selectedFileIndex ? 'magenta' : 'white' }, file)))),
            React.createElement(Text, { color: "gray" }, "Use \u2191\u2193 to navigate, Tab/Enter to select, ESC to cancel"))),
        attachedFiles.length > 0 && !showFileSelector && (React.createElement(Box, { marginX: 1, marginBottom: 1 },
            React.createElement(Text, { color: "magenta" },
                "\uD83D\uDCCE ",
                attachedFiles.join(', ')))),
        React.createElement(Box, { borderStyle: "round", borderColor: showModelSelector ? 'yellow' : 'green', paddingX: 1 },
            React.createElement(Box, { marginRight: 1 },
                React.createElement(Text, { bold: true, color: "green" }, "\u276F")),
            React.createElement(TextInput, { value: input, onChange: setInput, onSubmit: handleSubmit, focus: !showCommands && !showModelSelector && !showFileSelector, placeholder: showModelSelector ? "Use ↑↓ to select a model, Enter to confirm" : "Type a message... (Shift+Enter for new line, / for commands, ESC to exit)" }))));
};
export default Chat;
//# sourceMappingURL=Chat.js.map