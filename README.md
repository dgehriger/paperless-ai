# 📄 Paperless-AI

[![GitHub commit activity](https://img.shields.io/github/commit-activity/t/clusterzx/paperless-ai)](https://github.com/clusterzx/paperless-ai/commits/main)
[![Docker Pulls](https://img.shields.io/docker/pulls/clusterzx/paperless-ai)](https://hub.docker.com/r/clusterzx/paperless-ai)
[![GitHub Stars](https://img.shields.io/github/stars/clusterzx)](https://github.com/clusterzx)
[![License](https://img.shields.io/github/license/clusterzx/paperless-ai?cacheSeconds=1)](LICENSE)

---

**Paperless-AI** is an AI-powered extension for [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) that brings automatic document classification, smart tagging, and semantic search using OpenAI-compatible APIs and Ollama.

It enables **fully automated document workflows**, **contextual chat**, and **powerful customization** — all via an intuitive web interface.

> 💡 Just ask:  
> “When did I sign my rental agreement?”  
> “What was the amount of the last electricity bill?”  
> “Which documents mention my health insurance?”

Powered by **Retrieval-Augmented Generation (RAG)**, you can now search semantically across your full archive and get precise, natural language answers.

---

## ✨ Features

### 🔄 Automated Document Processing

- Detects new documents in Paperless-ngx automatically
- Analyzes content using OpenAI API, Ollama, and other compatible backends
- Assigns title, tags, document type, and correspondent
- Built-in support for:
  - Ollama (Mistral, Llama, Phi-3, Gemma-2)
  - OpenAI
  - DeepSeek.ai
  - OpenRouter.ai
  - Perplexity.ai
  - Together.ai
  - LiteLLM
  - VLLM
  - Fastchat
  - Gemini (Google)
  - ...and more!

### 🧠 RAG-Based AI Chat

- Natural language document search and Q&A
- Understands full document context (not just keywords)
- Semantic memory powered by your own data
- Fast, intelligent, privacy-friendly document queries  
  ![RAG_CHAT_DEMO](https://raw.githubusercontent.com/clusterzx/paperless-ai/refs/heads/main/ppairag.png)

### ⚙️ Manual Processing

- Web interface for manual AI tagging
- Useful when reviewing sensitive documents
- Accessible via `/manual`

### 🧩 Smart Tagging & Rules

- Define rules to limit which documents are processed
- Disable prompts and apply tags automatically
- Set custom output tags for tracked classification  
  ![PPAI_SHOWCASE3](https://github.com/user-attachments/assets/1fc9f470-6e45-43e0-a212-b8fa6225e8dd)

---

## 🚀 Installation

> ⚠️ **First-time install:** Restart the container **after completing setup** (API keys, preferences) to build RAG index.  
> 🔁 Not required for updates.

📘 [Installation Wiki](https://github.com/clusterzx/paperless-ai/wiki/2.-Installation)

---

## 🐳 Docker Support

- Health monitoring and auto-restart
- Persistent volumes and graceful shutdown
- Works out of the box with minimal setup

---

## 🔧 Local Development

```bash
# Install dependencies
npm install

# Start development/test mode
npm run test
```

---

## 🧭 Roadmap Highlights

- ✅ Multi-AI model support
- ✅ Multilingual document analysis
- ✅ Tag rules and filters
- ✅ Integrated document chat with RAG
- ✅ Responsive web interface

---

## 🧭 RAG Embeddings

RAG chat embeds documents through an OpenAI-compatible `/embeddings` endpoint; no model runs locally. Explicit settings take precedence:

| Variable                 | Meaning                                         |
| ------------------------ | ----------------------------------------------- |
| `RAG_EMBEDDINGS_API_URL` | Base URL of the endpoint, e.g. `https://api.openai.com/v1` |
| `RAG_EMBEDDINGS_API_KEY` | API key for that endpoint                       |
| `RAG_EMBEDDINGS_MODEL`   | Embedding model (default `text-embedding-3-small`) |

Without them, the endpoint follows `AI_PROVIDER`: `openai` uses `OPENAI_API_KEY`, `ollama` uses `OLLAMA_API_URL` with the model `nomic-embed-text`, and `custom` uses `CUSTOM_BASE_URL` and `CUSTOM_API_KEY`. Azure and any other provider need the `RAG_EMBEDDINGS_*` variables; until they are set, indexing stops and the RAG status reports what is missing.

The index records which endpoint and model built it. When either changes, including on the first start after an upgrade from a local model, the index is rebuilt automatically. A document whose embedding fails stays searchable by keyword and is embedded again on the next indexing run.

---

## 👥 Multi-User Access (Cloudflare Access)

With `AUTH_MODE=cf_access`, Paperless-AI sits behind a Cloudflare Access application and every visitor gets their own account:

| Variable                | Meaning                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `CF_ACCESS_TEAM_DOMAIN` | Your team domain, e.g. `yourteam.cloudflareaccess.com`            |
| `CF_ACCESS_AUD`         | The Access application's audience (AUD) tag                       |
| `ADMIN_EMAILS`          | Comma-separated addresses that become administrators on first login |

Identity comes only from the `Cf-Access-Jwt-Assertion` token, verified against your team's signing keys, audience and issuer; requests without a valid token are refused. Both variables are required in this mode. Do not publish the container port beyond the tunnel.

New users wait for approval in the admin panel (`/admin`), where an administrator grants permissions per feature and assigns libraries. A library restricts a user to documents matching all of its filters (storage paths, tags, correspondents, document types); a user with several libraries sees documents matching any of them, and a user with none sees every document. The `dashboard`, `manual`, `playground` and `settings` permissions cover the whole archive and its configuration, so grant them only to trusted users.

---

## 🔌 MCP Server (Model Context Protocol)

Paperless-AI includes an MCP server (`mcp-server.js`) that exposes your document archive as tools for AI assistants like Claude Desktop, VS Code Copilot, and other MCP-compatible clients.

### Available Tools

| Tool               | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| `search_documents` | Hybrid BM25 + semantic search with optional date/correspondent filters   |
| `ask_question`     | RAG-powered Q&A — retrieves context and generates an answer with sources |
| `get_document`     | Retrieve a specific document by its Paperless-ngx ID                     |
| `index_documents`  | Trigger reindexing of the RAG search engine                              |
| `get_status`       | Check index health, document count, and AI model info                    |

### Prerequisites

The MCP server connects to a running paperless-ai instance over HTTP and authenticates on every request:

| Variable                                     | Meaning                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `PAPERLESS_AI_URL`                           | Your instance (default `http://localhost:3000`)                         |
| `PAPERLESS_AI_API_KEY`                       | The instance's API key from Settings (`AUTH_MODE=local`)                |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | A Cloudflare Access service token (`AUTH_MODE=cf_access`)           |

A service token signs in as `<client id>@service-token.cloudflareaccess`. Approve it in the admin panel and grant `rag_chat`, plus `rag_settings` for `index_documents`. Add the variables to the `env` block of the client configurations below.

### Claude Desktop

Add to `~/.claude/claude_desktop_config.json` (macOS/Linux) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "paperless-ai": {
      "command": "node",
      "args": ["/absolute/path/to/paperless-ai/mcp-server.js"],
      "env": {
        "PAPERLESS_AI_URL": "https://your-paperless-ai-instance:3000",
        "PAPERLESS_AI_API_KEY": "your-api-key"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` in your workspace (or user-level `settings.json` under `"mcp"`):

```json
{
  "servers": {
    "paperless-ai": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/paperless-ai/mcp-server.js"],
      "env": {
        "PAPERLESS_AI_URL": "https://your-paperless-ai-instance:3000",
        "PAPERLESS_AI_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "paperless-ai": {
      "command": "node",
      "args": ["/absolute/path/to/paperless-ai/mcp-server.js"],
      "env": {
        "PAPERLESS_AI_URL": "https://your-paperless-ai-instance:3000",
        "PAPERLESS_AI_API_KEY": "your-api-key"
      }
    }
  }
}
```

---

## 🤝 Contributing

We welcome PRs and contributions!

```bash
# Fork, clone, then:
git checkout -b feature/YourFeature
# After changes:
git commit -m "Add YourFeature"
git push origin feature/YourFeature
```

Then open a Pull Request via GitHub.

---

## 🆘 Support & Community

- [Issues](https://github.com/clusterzx/paperless-ai/issues)
- [Discord](https://discord.gg/AvNekAfK38)

---

## 📄 License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

## 🙏 Support Development

[![Patreon](https://img.shields.io/badge/Patreon-F96854?style=for-the-badge&logo=patreon&logoColor=white)](https://www.patreon.com/c/clusterzx)
[![PayPal](https://img.shields.io/badge/PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/paypalme/bech0r)
[![BuyMeACoffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/clusterzx)
[![Ko-Fi](https://img.shields.io/badge/Ko--fi-F16061?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/clusterzx)
