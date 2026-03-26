#!/usr/bin/env node
// mcp-server.js — MCP server exposing paperless-ai RAG search and chat
//
// Usage (stdio transport for Claude Desktop):
//   node mcp-server.js
//
// Environment variables:
//   PAPERLESS_AI_URL  — base URL of the paperless-ai web service (default: http://localhost:3000)

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const BASE_URL = process.env.PAPERLESS_AI_URL || 'http://localhost:3000';

async function fetchJSON(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

const server = new Server(
  { name: 'paperless-ai-rag', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_documents',
      description: 'Search indexed paperless-ngx documents using hybrid BM25 + semantic search. Returns matching documents with titles, correspondents, dates, and relevance scores.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          from_date: { type: 'string', description: 'Filter: start date (YYYY-MM-DD)' },
          to_date: { type: 'string', description: 'Filter: end date (YYYY-MM-DD)' },
          correspondent: { type: 'string', description: 'Filter: correspondent name' },
        },
        required: ['query'],
      },
    },
    {
      name: 'ask_question',
      description: 'Ask a question about your paperless-ngx documents. Retrieves relevant context via RAG and generates an AI answer with source references.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Question to ask about documents' },
        },
        required: ['question'],
      },
    },
    {
      name: 'get_document',
      description: 'Retrieve a specific document from paperless-ngx by its ID. Returns the full document text content.',
      inputSchema: {
        type: 'object',
        properties: {
          doc_id: { type: 'number', description: 'Paperless-ngx document ID' },
        },
        required: ['doc_id'],
      },
    },
    {
      name: 'index_documents',
      description: 'Trigger reindexing of paperless-ngx documents in the RAG search engine.',
      inputSchema: {
        type: 'object',
        properties: {
          force: { type: 'boolean', description: 'Force full reindex (default: false)' },
        },
      },
    },
    {
      name: 'get_status',
      description: 'Get the current status of the paperless-ai RAG service including index health, document count, and AI model info.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'search_documents': {
        const body = { query: args.query };
        if (args.from_date) body.from_date = args.from_date;
        if (args.to_date) body.to_date = args.to_date;
        if (args.correspondent) body.correspondent = args.correspondent;
        const results = await fetchJSON('/api/rag/search', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      }

      case 'ask_question': {
        const result = await fetchJSON('/api/rag/ask', {
          method: 'POST',
          body: JSON.stringify({ question: args.question }),
        });
        let text = result.answer;
        if (result.sources && result.sources.length > 0) {
          text += '\n\n---\nSources:\n';
          result.sources.forEach((s, i) => {
            text += `${i + 1}. ${s.title || 'Untitled'}`;
            if (s.correspondent) text += ` (${s.correspondent})`;
            if (s.date) text += ` — ${s.date}`;
            if (s.doc_id) text += ` [doc #${s.doc_id}]`;
            text += '\n';
          });
        }
        return { content: [{ type: 'text', text }] };
      }

      case 'get_document': {
        // Use the paperless-ai proxy to get document content
        const result = await fetchJSON('/api/rag/search', {
          method: 'POST',
          body: JSON.stringify({ query: `id:${args.doc_id}` }),
        });
        const doc = result.find(r => r.doc_id === args.doc_id);
        if (doc) {
          return { content: [{ type: 'text', text: `Title: ${doc.title}\nCorrespondent: ${doc.correspondent}\nDate: ${doc.date}\n\n${doc.snippet}` }] };
        }
        return { content: [{ type: 'text', text: `Document ${args.doc_id} not found in index.` }] };
      }

      case 'index_documents': {
        const result = await fetchJSON('/api/rag/index', {
          method: 'POST',
          body: JSON.stringify({ force: args.force || false }),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_status': {
        const status = await fetchJSON('/api/rag/status');
        return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Paperless-AI RAG MCP server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
