import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { Highlight } from 'ink-highlight';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { homedir } from 'os';
import { join, resolve, extname } from 'path';
import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'fs/promises';
import { encode } from 'gpt-tokenizer';

dotenv.config();

interface Message {
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  model?: string;
}

interface Command {
  name: string;
  description: string;
  usage?: string;
}

interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  model: string;
}

interface Config {
  currentModel: string;
  lastSessionId?: string;
}

const COMMANDS: Command[] = [
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

// Calculate tokens for messages
const calculateTokens = (messages: Message[]): number => {
  const text = messages.map(m => m.content).join('\n');
  return encode(text).length;
};

// Get model token limit
const getModelTokenLimit = (model: string): number => {
  if (model.includes('gpt-4')) return 128000;
  if (model.includes('gpt-3.5')) return 16385;
  return 128000;
};

// Format number with commas
const formatNumber = (num: number): string => {
  return num.toLocaleString();
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Scan files for @file autocomplete
const scanFiles = async (query: string): Promise<string[]> => {
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
  } catch {
    return [];
  }
};

// Read file content for @file reference
const readFileContent = async (filePath: string): Promise<string | null> => {
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
  } catch {
    return null;
  }
};

// Generate a unique session ID
const generateSessionId = (): string => {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

// Ensure config directories exist
const ensureConfigDir = async (): Promise<void> => {
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await mkdir(HISTORY_DIR, { recursive: true });
  } catch {
    // Ignore errors, directory might already exist
  }
};

// Load config from file
const loadConfig = async (): Promise<Config> => {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(data) as Config;
    // Validate that the model is available
    if (!AVAILABLE_MODELS.includes(config.currentModel)) {
      config.currentModel = 'gpt-4o-mini';
    }
    return config;
  } catch {
    // Return default config if file doesn't exist or is invalid
    return { currentModel: 'gpt-4o-mini' };
  }
};

// Save config to file
const saveConfig = async (config: Config): Promise<void> => {
  try {
    await ensureConfigDir();
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    // Ignore save errors
  }
};

// Load a session from history
const loadSession = async (sessionId: string): Promise<Session | null> => {
  try {
    const filePath = join(HISTORY_DIR, `${sessionId}.json`);
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data) as Session;
  } catch {
    return null;
  }
};

// Save a session to history
const saveSession = async (session: Session): Promise<void> => {
  try {
    await ensureConfigDir();
    const filePath = join(HISTORY_DIR, `${session.id}.json`);
    await writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
  } catch {
    // Ignore save errors
  }
};

// List all sessions, sorted by updatedAt desc
const listSessions = async (): Promise<Session[]> => {
  try {
    const files = await readdir(HISTORY_DIR);
    const sessions: Session[] = [];
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const filePath = join(HISTORY_DIR, file);
          const data = await readFile(filePath, 'utf-8');
          const session = JSON.parse(data) as Session;
          sessions.push(session);
        } catch {
          // Skip invalid session files
        }
      }
    }
    
    // Sort by updatedAt desc and take last 10
    return sessions
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10);
  } catch {
    return [];
  }
};

// Clean up old sessions, keep only MAX_HISTORY_SESSIONS most recent
const cleanupOldSessions = async (): Promise<void> => {
  try {
    const files = await readdir(HISTORY_DIR);
    const sessions: { file: string; updatedAt: number }[] = [];
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const filePath = join(HISTORY_DIR, file);
          const data = await readFile(filePath, 'utf-8');
          const session = JSON.parse(data) as Session;
          sessions.push({ file, updatedAt: session.updatedAt });
        } catch {
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
        } catch {
          // Ignore delete errors
        }
      }
    }
  } catch {
    // Ignore cleanup errors
  }
};

// Generate a title for the session using GPT-4o-mini
const generateSessionTitle = async (firstMessage: string): Promise<string> => {
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
  } catch {
    // Fallback to first few words
    const words = firstMessage.split(' ').slice(0, 5).join(' ');
    return words.length > 30 ? words.substring(0, 30) + '...' : words;
  }
};

// Component to render message content with code blocks
const MessageContent: React.FC<{ content: string; isStreaming?: boolean; streamingContent?: string }> = ({ 
  content, 
  isStreaming, 
  streamingContent 
}) => {
  const displayContent = isStreaming ? streamingContent : content;
  
  if (!displayContent) return null;
  
  // Split content by code blocks
  const parts = displayContent.split(/(```[\s\S]*?```)/);
  
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('```')) {
          // Parse code block
          const match = part.match(/```(\w+)?\n([\s\S]*?)```/);
          if (match) {
            const [, lang, code] = match;
            return (
              <Box key={index} flexDirection="column" marginY={1}>
                <Box borderStyle="single" borderColor="gray" paddingX={1}>
                  <Text color="cyan">📄 {lang || 'code'} </Text>
                </Box>
                <Box borderStyle="round" borderColor="gray" paddingX={1} marginLeft={2}>
                  {lang ? (
                    <Highlight code={code.trim()} language={lang} theme="dark" />
                  ) : (
                    <Text>{code.trim()}</Text>
                  )}
                </Box>
              </Box>
            );
          }
        }
        // Regular text - split by newlines
        return part.split('\n').map((line, lineIndex) => (
          <Text key={`${index}-${lineIndex}`}>{line || ' '}</Text>
        ));
      })}
    </>
  );
};

const Chat: React.FC = () => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [currentModel, setCurrentModel] = useState('gpt-4o-mini');
  const [sessionId, setSessionId] = useState<string>('');
  const [sessionTitle, setSessionTitle] = useState<string>('');
  const [isInitialized, setIsInitialized] = useState(false);
  const [pendingSession, setPendingSession] = useState<Session | null>(null);
  
  // Command completion state
  const [showCommands, setShowCommands] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [filteredCommands, setFilteredCommands] = useState<Command[]>([]);
  
  // Model selection state
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);

  // File attachment state
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [fileList, setFileList] = useState<string[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);

  // Virtual scroll state
  const [scrollOffset, setScrollOffset] = useState(0);
  const { stdout } = useStdout();
  const terminalRows = stdout.rows || 24;
  // Estimate visible messages: reserve ~8 rows for header/input/chrome, ~4 rows per message avg
  const maxVisibleMessages = Math.max(3, Math.floor((terminalRows - 8) / 4));

  // Use ref to track if title has been generated
  const titleGeneratedRef = useRef(false);

  // Use ref to track latest messages for avoiding stale closure
  const messagesRef = useRef<Message[]>([]);

  // Use ref to preserve createdAt timestamp across saves
  const sessionCreatedAtRef = useRef<number>(0);

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
        const session: Session = {
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
      const filtered = COMMANDS.filter(cmd => 
        cmd.name.toLowerCase().startsWith(query)
      );
      setFilteredCommands(filtered);
      setShowCommands(filtered.length > 0 && input.length > 0 && !showModelSelector && !showFileSelector);
      setSelectedCommandIndex(0);
    } else {
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
      } else {
        setShowFileSelector(false);
      }
    } else {
      setShowFileSelector(false);
    }
  }, [input]);

  const handleCommandSelect = useCallback((cmd: Command) => {
    if (cmd.name === '/models' || cmd.name === '/model') {
      // Show model selector instead of just setting input
      setShowModelSelector(true);
      setShowCommands(false);
      // Find current model index
      const currentIndex = AVAILABLE_MODELS.indexOf(currentModel);
      setSelectedModelIndex(currentIndex >= 0 ? currentIndex : 0);
      setInput('');
    } else {
      setInput(cmd.name + ' ');
      setShowCommands(false);
    }
  }, [currentModel]);

  const handleModelSelect = useCallback((modelIndex: number) => {
    const selectedModel = AVAILABLE_MODELS[modelIndex];
    if (selectedModel) {
      setCurrentModel(selectedModel);
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: `✅ Model switched to ${selectedModel}` 
      }]);
    }
    setShowModelSelector(false);
    setInput('');
  }, []);

  const handleModelSwitch = useCallback((modelName: string) => {
    const trimmedModel = modelName.trim();
    if (AVAILABLE_MODELS.includes(trimmedModel)) {
      setCurrentModel(trimmedModel);
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: `✅ Model switched to ${trimmedModel}` 
      }]);
    } else {
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: `❌ Unknown model: ${trimmedModel}\nAvailable models: ${AVAILABLE_MODELS.join(', ')}` 
      }]);
    }
  }, []);

  const showHelp = useCallback(() => {
    const helpText = COMMANDS.map(cmd => 
      `  ${cmd.name.padEnd(12)} ${cmd.description}${cmd.usage ? ` (${cmd.usage})` : ''}`
    ).join('\n');
    
    setMessages(prev => [...prev, { 
      role: 'assistant', 
      content: `📖 Available Commands:\n\n${helpText}\n\nKeyboard Shortcuts:\n  Ctrl+R         Regenerate last response\n  Ctrl+L         Clear chat history\n  Ctrl+P/↑       Edit last user message\n  Ctrl+U         Scroll up messages\n  Ctrl+D         Scroll down messages\n  Shift+Enter    Insert new line (multiline input)\n  ESC            Exit / Cancel selection\n\nTips:\n• Type / and use ↑↓ to select commands\n• Use @filename to attach files\n• Use Shift+Enter for multiline messages` 
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
        content: 'No saved sessions found.' 
      }]);
      return;
    }
    
    const sessionList = sessions.map((s, i) => {
      const date = new Date(s.updatedAt).toLocaleDateString();
      const time = new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `  ${i + 1}. ${s.title} | ${date} ${time} | ${s.messages.length} messages`;
    }).join('\n');
    
    setMessages(prev => [...prev, { 
      role: 'assistant', 
      content: `📚 Recent Sessions (last 10):\n\n${sessionList}\n\nUse /resume <id> to restore a session.\nCurrent session ID: ${sessionId.slice(0, 8)}...` 
    }]);
  }, [sessionId]);

  const resumeSession = useCallback(async (targetSessionId: string) => {
    // Try to find session by full ID or partial match
    const sessions = await listSessions();
    const session = sessions.find(s => s.id.startsWith(targetSessionId)) || await loadSession(targetSessionId);
    
    if (session) {
      setMessages(session.messages);
      setCurrentModel(session.model);
      setSessionId(session.id);
      setSessionTitle(session.title);
      sessionCreatedAtRef.current = session.createdAt;
      titleGeneratedRef.current = true;
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: `✅ Resumed session: "${session.title}"` 
      }]);
    } else {
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
    setMessages(prev => [...prev, { 
      role: 'assistant', 
      content: '✅ Started new session' 
    }]);
  }, []);

  const handleResumePrompt = useCallback((accept: boolean) => {
    if (accept && pendingSession) {
      setMessages(pendingSession.messages);
      setCurrentModel(pendingSession.model);
      setSessionId(pendingSession.id);
      setSessionTitle(pendingSession.title);
      titleGeneratedRef.current = true;
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: `✅ Resumed session: "${pendingSession.title}"` 
      }]);
    } else {
      // Start fresh with new session ID
      const newSessionId = generateSessionId();
      setSessionId(newSessionId);
    }
    setPendingSession(null);
  }, [pendingSession]);

  const handleSubmit = useCallback(async (value: string) => {
    // 阻止并发请求
    if (isLoading || isThinking) {
      return;
    }

    if (showCommands || showModelSelector || showFileSelector) {
      return;
    }
    if (!value.trim()) return;

    const trimmedValue = value.trim();

    // Handle commands
    if (trimmedValue === '/clear') {
      setMessages([]);
      setInput('');
      return;
    }

    if (trimmedValue === '/exit' || trimmedValue === '/quit') {
      exit();
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
      const fileContents: string[] = [];
      
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
        } catch {
          // If file can't be read, add error message
          fileContents.push(`[无法读取文件: ${filePath}]`);
        }
      }
      
      finalContent = finalContent + '\n\n' + fileContents.join('\n\n');
    }

    const userMessage: Message = { role: 'user', content: finalContent };
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
    } catch (error) {
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` 
      }]);
    } finally {
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
    if (lastAssistantIndex === -1) return;

    // Find corresponding user message (iterate backwards from assistant)
    let lastUserIndex = -1;
    for (let i = lastAssistantIndex - 1; i >= 0; i--) {
      if (latestMessages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) return;

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
    let lastUserMessage: Message | undefined;
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
        setScrollOffset(prev => Math.min(prev + maxVisibleMessages, Math.max(0, messages.length - maxVisibleMessages)));
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
      } else if (showModelSelector) {
        setShowModelSelector(false);
      } else if (showCommands) {
        setShowCommands(false);
      } else {
        exit();
      }
    }
    
    // File selector keyboard navigation
    if (showFileSelector) {
      if (key.upArrow) {
        setSelectedFileIndex(prev => 
          prev > 0 ? prev - 1 : fileList.length - 1
        );
      }
      if (key.downArrow) {
        setSelectedFileIndex(prev => 
          prev < fileList.length - 1 ? prev + 1 : 0
        );
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
        setSelectedModelIndex(prev => 
          prev > 0 ? prev - 1 : AVAILABLE_MODELS.length - 1
        );
      }
      if (key.downArrow) {
        setSelectedModelIndex(prev => 
          prev < AVAILABLE_MODELS.length - 1 ? prev + 1 : 0
        );
      }
      if (key.return || key.tab) {
        handleModelSelect(selectedModelIndex);
      }
    } else if (showCommands) {
      if (key.upArrow) {
        setSelectedCommandIndex(prev => 
          prev > 0 ? prev - 1 : filteredCommands.length - 1
        );
      }
      if (key.downArrow) {
        setSelectedCommandIndex(prev => 
          prev < filteredCommands.length - 1 ? prev + 1 : 0
        );
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
    return (
      <Box flexDirection="column" height="100%" justifyContent="center" alignItems="center">
        <Text color="cyan">
          <Spinner type="dots" />
          {' '}Loading...
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box borderStyle="single" paddingX={1}>
        <Text bold color="cyan">🤖 GPT CLI</Text>
        <Text> | Model: </Text>
        <Text bold color="yellow">{currentModel}</Text>
        {sessionTitle && (
          <>
            <Text> | </Text>
            <Text bold color="green">{sessionTitle}</Text>
          </>
        )}
        <Text> | </Text>
        <Text color="gray">Tokens: {formatNumber(calculateTokens(messages))} / {formatNumber(getModelTokenLimit(currentModel))}</Text>
        <Text> | </Text>
        <Text bold>/help</Text>
      </Box>

      {/* Resume Prompt */}
      {pendingSession && (
        <Box 
          flexDirection="column" 
          borderStyle="round" 
          borderColor="yellow"
          paddingX={1}
          marginX={1}
          marginY={1}
        >
          <Text bold color="yellow">💾 Resume Previous Session?</Text>
          <Text>Last session: "{pendingSession.title}"</Text>
          <Text>Messages: {pendingSession.messages.length}</Text>
          <Text>Last updated: {new Date(pendingSession.updatedAt).toLocaleString()}</Text>
          <Box marginTop={1}>
            <Text color="gray">Press </Text>
            <Text bold color="green">Y</Text>
            <Text color="gray"> to resume, </Text>
            <Text bold color="red">N</Text>
            <Text color="gray"> to start fresh</Text>
          </Box>
        </Box>
      )}

      {/* Messages (virtual scrolling - only renders visible messages) */}
      <Box flexDirection="column" flexGrow={1} padding={1}>
        {messages.length === 0 && !pendingSession && (
          <Box>
            <Text color="gray">Welcome! Start typing to chat with GPT.\n</Text>
            <Text color="gray">Type </Text>
            <Text bold color="cyan">/</Text>
            <Text color="gray"> for commands, </Text>
            <Text bold color="cyan">Shift+Enter</Text>
            <Text color="gray"> for new line.</Text>
          </Box>
        )}
        
        {hasMoreAbove && (
          <Box>
            <Text color="gray">▲ {startIndex} earlier message{startIndex !== 1 ? 's' : ''} (Ctrl+U to scroll up)</Text>
          </Box>
        )}

        {visibleMessages.map((message, index) => (
          <Box key={startIndex + index} flexDirection="column" marginY={1}>
            <Box>
              <Text bold color={message.role === 'user' ? 'green' : 'blue'}>
                {message.role === 'user' ? 'You:' : 'GPT:'}
              </Text>
              {message.model && (
                <Text color="gray"> ({message.model})</Text>
              )}
            </Box>
            <Box paddingLeft={2} flexDirection="column">
              <MessageContent 
                content={message.content} 
                isStreaming={message.isStreaming}
                streamingContent={streamingContent}
              />
            </Box>
          </Box>
        ))}
        
        {isThinking && (
          <Box>
            <Text color="yellow">
              <Spinner type="dots" />
              {' '}Thinking...
            </Text>
          </Box>
        )}

        {hasMoreBelow && (
          <Box>
            <Text color="gray">▼ {scrollOffset} newer message{scrollOffset !== 1 ? 's' : ''} (Ctrl+D to scroll down)</Text>
          </Box>
        )}
      </Box>

      {/* Model Selector */}
      {showModelSelector && (
        <Box 
          flexDirection="column" 
          borderStyle="round" 
          borderColor="yellow"
          paddingX={1}
          marginX={1}
        >
          <Text bold color="yellow">🤖 Select Model:</Text>
          {AVAILABLE_MODELS.map((model, index) => (
            <Box key={model}>
              <Text color={index === selectedModelIndex ? 'yellow' : 'white'}>
                {index === selectedModelIndex ? '▶ ' : '  '}
              </Text>
              <Text 
                bold={index === selectedModelIndex}
                color={index === selectedModelIndex ? 'yellow' : model === currentModel ? 'green' : 'white'}
              >
                {model}
              </Text>
              {model === currentModel && (
                <Text color="green"> ✓ current</Text>
              )}
            </Box>
          ))}
          <Text color="gray">Use ↑↓ to navigate, Enter to select, ESC to cancel</Text>
        </Box>
      )}

      {/* Command Suggestions */}
      {showCommands && (
        <Box 
          flexDirection="column" 
          borderStyle="round" 
          borderColor="cyan"
          paddingX={1}
          marginX={1}
        >
          <Text bold color="cyan">Commands:</Text>
          {filteredCommands.map((cmd, index) => (
            <Box key={cmd.name}>
              <Text color={index === selectedCommandIndex ? 'cyan' : 'white'}>
                {index === selectedCommandIndex ? '▶ ' : '  '}
              </Text>
              <Text 
                bold={index === selectedCommandIndex}
                color={index === selectedCommandIndex ? 'cyan' : 'white'}
              >
                {cmd.name}
              </Text>
              <Text color="gray"> - {cmd.description}</Text>
            </Box>
          ))}
          <Text color="gray">Use ↑↓ to navigate, Tab/Enter to select</Text>
        </Box>
      )}

      {/* File Selector */}
      {showFileSelector && (
        <Box 
          flexDirection="column" 
          borderStyle="round" 
          borderColor="magenta"
          paddingX={1}
          marginX={1}
          marginBottom={1}
        >
          <Text bold color="magenta">📎 Attach File:</Text>
          {fileList.map((file, index) => (
            <Box key={file}>
              <Text color={index === selectedFileIndex ? 'magenta' : 'white'}>
                {index === selectedFileIndex ? '▶ ' : '  '}
                {file}
              </Text>
            </Box>
          ))}
          <Text color="gray">Use ↑↓ to navigate, Tab/Enter to select, ESC to cancel</Text>
        </Box>
      )}

      {/* File attachment hint */}
      {attachedFiles.length > 0 && !showFileSelector && (
        <Box marginX={1} marginBottom={1}>
          <Text color="gray">📎 {attachedFiles.join(', ')}</Text>
        </Box>
      )}

      {/* Input */}
      <Box borderStyle="single" borderColor={showModelSelector ? 'yellow' : 'cyan'} paddingX={1}>
        <Box marginRight={1}>
          <Text bold color="green">➜</Text>
        </Box>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={showModelSelector ? "Select model with arrow keys..." : "Type message (Shift+Enter for new line, / for commands)..."}
        />
      </Box>
    </Box>
  );
};

export default Chat;
