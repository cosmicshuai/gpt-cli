# GPT CLI

Interactive GPT CLI tool built with Ink (React for CLI) and OpenAI API.

## Features

- 🎨 Beautiful terminal UI with Ink
- 💬 Real-time streaming responses from GPT
- 🧹 Clear chat history with `/clear` command
- ⌨️ Keyboard navigation support
- 🚀 Fast and lightweight

## Installation

```bash
# Clone or download the project
cd gpt-cli

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env and add your OpenAI API key
```

## Usage

```bash
# Development mode
npm run dev

# Build and run
npm start
```

## Commands

| Command | Description |
|---------|-------------|
| `/clear` | Clear chat history |
| `/exit` or `/quit` | Exit the application |
| `ESC` | Exit the application |

## Environment Variables

- `OPENAI_API_KEY` - Your OpenAI API key (required)

## Tech Stack

- **Node.js** - Runtime
- **TypeScript** - Language
- **Ink** - React for CLI
- **OpenAI API** - GPT integration
- **Chalk** - Terminal colors

## License

MIT