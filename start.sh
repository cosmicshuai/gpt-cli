#!/bin/bash

# GPT CLI Launcher
# This script sets up the environment and runs the GPT CLI

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🤖 GPT CLI Launcher${NC}"
echo "===================="
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️  .env file not found!${NC}"
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo ""
    echo -e "${RED}Please edit .env and add your OpenAI API key:${NC}"
    echo "  OPENAI_API_KEY=sk-your-api-key-here"
    echo ""
    exit 1
fi

# Check if node_modules exists
if [ ! -d node_modules ]; then
    echo -e "${YELLOW}📦 Installing dependencies...${NC}"
    npm install
    echo ""
fi

# Check if dist exists
if [ ! -d dist ]; then
    echo -e "${YELLOW}🔨 Building project...${NC}"
    npm run build
    echo ""
fi

echo -e "${GREEN}🚀 Starting GPT CLI...${NC}"
echo ""
echo "Commands:"
echo "  /help           - Show all commands"
echo "  /models         - List available models"
echo "  /model <name>   - Switch model (gpt-4o, gpt-4o-mini, gpt-3.5-turbo)"
echo "  /clear          - Clear chat history"
echo "  /exit           - Exit the application"
echo "  ESC             - Exit the application"
echo ""
echo "Tip: Type / to see command suggestions with auto-completion"
echo ""

# Run the CLI
node dist/index.js