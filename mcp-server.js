#!/usr/bin/env node
// mcp-server.js — MCP server exposing paperless-ai RAG search and chat
//
// Usage (stdio transport for Claude Desktop):
//   node mcp-server.js
//
// Environment variables:
//   PAPERLESS_AI_URL        — base URL of the paperless-ai web service (default: http://localhost:3000)
//   PAPERLESS_AI_API_KEY    — the instance's API key (Settings), sent as x-api-key; for AUTH_MODE=local
//   CF_ACCESS_CLIENT_ID     — Cloudflare Access service token ID; for AUTH_MODE=cf_access
//   CF_ACCESS_CLIENT_SECRET — Cloudflare Access service token secret
//
// Every endpoint used here requires authentication. In cf_access mode the
// service token signs in as "<client id>@service-token.cloudflareaccess",
// which an admin approves and grants rag_chat (and rag_settings for indexing)
// like any other user.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const BASE_URL = (process.env.PAPERLESS_AI_URL || 'http://localhost:3000').replace(/\/+$/, '');

function authHeaders() {
  const headers = {};
  if (process.env.PAPERLESS_AI_API_KEY) {
    headers['x-api-key'] = process.env.PAPERLESS_AI_API_KEY;
  }
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
  }
  return headers;
}

async function fetchJSON(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    // An unauthenticated request is redirected to the login page; follow
    // nothing, so that is reported as what it is instead of as bad JSON.
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...options.headers },
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Not authenticated (redirected to ${res.headers.get('location') || 'login'}): set PAPERLESS_AI_API_KEY, or CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw new Error(`Expected JSON from ${path} but got ${type || 'no content type'}; check authentication`);
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
        const docId = Number(args.doc_id);
        if (!Number.isInteger(docId) || docId <= 0) {
          throw new Error('doc_id must be a positive integer');
        }
        // A dedicated lookup by ID, checked against the caller's libraries
        const doc = await fetchJSON(`/api/rag/documents/${docId}`);
        const header = [
          `Title: ${doc.title || 'Untitled'}`,
          `Correspondent: ${doc.correspondent || ''}`,
          `Date: ${doc.created || ''}`,
          doc.document_type ? `Document type: ${doc.document_type}` : null,
          doc.storage_path ? `Storage path: ${doc.storage_path}` : null,
          doc.tags && doc.tags.length ? `Tags: ${doc.tags.join(', ')}` : null,
        ].filter(Boolean).join('\n');
        return { content: [{ type: 'text', text: `${header}\n\n${doc.content || ''}` }] };
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
