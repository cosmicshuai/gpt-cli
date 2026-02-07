export interface Message {
    role: 'user' | 'assistant';
    content: string;
    isStreaming?: boolean;
    model?: string;
}
export interface Command {
    name: string;
    description: string;
    usage?: string;
}
export declare const COMMANDS: Command[];
export declare const AVAILABLE_MODELS: string[];
//# sourceMappingURL=types.d.ts.map