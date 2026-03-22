// services/ragService.js
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config/config');
const AIServiceFactory = require('./aiServiceFactory');
const paperlessService = require('./paperlessService');

const SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'data', 'rag-system-prompt.txt');

class RagService {
  constructor() {
    this.baseUrl = process.env.RAG_SERVICE_URL || 'http://localhost:8000';
    this.maxSources = parseInt(process.env.RAG_MAX_SOURCES || '10', 10);
    this.ragChatModel = process.env.RAG_CHAT_MODEL || '';  // If empty, use default AI service
    this.paperlessPublicUrl = process.env.PAPERLESS_PUBLIC_URL || '';
  }

  async getSystemPrompt() {
    try {
      return (await fs.readFile(SYSTEM_PROMPT_FILE, 'utf-8')).trim();
    } catch {
      return '';
    }
  }

  async setSystemPrompt(prompt) {
    await fs.mkdir(path.dirname(SYSTEM_PROMPT_FILE), { recursive: true });
    await fs.writeFile(SYSTEM_PROMPT_FILE, prompt, 'utf-8');
  }

  getDefaultPrompt() {
    return [
      'You are a knowledgeable document assistant with access to a curated archive.',
      'Answer questions precisely based on the provided documents.',
      'Always attribute facts to the specific document they come from, using the metadata (title, correspondent, date, tags, storage path) to distinguish between documents.',
      'When multiple documents are relevant, synthesize information across them.',
      'If the answer is not contained in the provided documents, say so clearly.',
    ].join('\n');
  }

  /**
   * Detect if a question is a follow-up that refers to the previous answer
   * (e.g. "show as a table", "summarize that", "explain more")
   */
  _isFollowUpQuestion(question) {
    const q = question.toLowerCase().trim();
    // Short questions referring to prior context
    if (q.length < 80) {
      const followUpPatterns = [
        /^(show|display|format|present|list|summarize|explain|elaborate|clarify|translate|rewrite|repeat|shorten|expand|convert)\b/,
        /\b(as a table|in a table|als tabelle|tabellarisch|in tabellenform)\b/,
        /\b(more detail|more info|tell me more|kannst du|könntest du)\b/,
        /\b(the same|das gleiche|nochmal|noch einmal)\b/,
      ];
      return followUpPatterns.some(p => p.test(q));
    }
    return false;
  }

  /**
   * Check if the RAG service is available and ready
   * @returns {Promise<{status: string, index_ready: boolean, data_loaded: boolean}>}
   */
  async checkStatus() {
    try {
      const response = await axios.get(`${this.baseUrl}/status`);
      //make test call to the LLM service to check if it is available
      return response.data;
    } catch (error) {
      console.error('Error checking RAG service status:', error.message);
      return {
        server_up: false,
        data_loaded: false,
        index_ready: false,
        error: error.message
      };
    }
  }

  /**
   * Search for documents matching a query
   * @param {string} query - The search query
   * @param {Object} filters - Optional filters for search
   * @returns {Promise<Array>} - Array of search results
   */
  async search(query, filters = {}) {
    try {
      const response = await axios.post(`${this.baseUrl}/search`, {
        query,
        ...filters
      });
      return response.data;
    } catch (error) {
      console.error('Error searching documents:', error);
      throw error;
    }
  }

  /**
   * Ask a question about documents and get an AI-generated answer in the same language as the question
   * @param {string} question - The question to ask
   * @returns {Promise<{answer: string, sources: Array}>} - AI response and source documents
   */
  async askQuestion(question, chatHistory = [], storagePaths = []) {
    try {
      // Detect follow-up questions that refer to the previous answer
      const isFollowUp = chatHistory.length > 0 && this._isFollowUpQuestion(question);

      let enhancedContext = '';
      let sources = [];

      if (isFollowUp) {
        // For follow-ups (e.g. "show as a table"), skip RAGZ entirely.
        // The LLM already has the previous answer via chatHistory.
        console.log('[RAG] Follow-up detected, skipping document retrieval');
      } else {
        // 1. Get context from the RAG service
        const contextRequest = { 
          question,
          max_sources: this.maxSources
        };
        if (storagePaths && storagePaths.length > 0) {
          contextRequest.storage_paths = storagePaths;
        }
        const response = await axios.post(`${this.baseUrl}/context`, contextRequest);
        
        const contextData = response.data;
        enhancedContext = contextData.context;
        sources = contextData.sources || [];
        
        // 2. Fetch full content for each source document, with per-doc and total size limits
        const MAX_CHARS_PER_DOC = 50000;  // ~12.5K tokens per doc
        const MAX_TOTAL_CONTEXT = 500000; // ~125K tokens total context
        let totalChars = enhancedContext.length;
        
        if (sources.length > 0) {
          const fullDocContents = [];
          for (const source of sources) {
            if (totalChars >= MAX_TOTAL_CONTEXT) break;
            if (!source.doc_id) continue;
            try {
              let fullContent = await paperlessService.getDocumentContent(source.doc_id);
              if (fullContent.length > MAX_CHARS_PER_DOC) {
                fullContent = fullContent.substring(0, MAX_CHARS_PER_DOC) + '\n[... document truncated ...]';
              }
              const metaParts = [`Title: ${source.title || 'Document ' + source.doc_id}`];
              if (source.correspondent) metaParts.push(`Correspondent: ${source.correspondent}`);
              if (source.date) metaParts.push(`Date: ${source.date}`);
              if (source.tags) metaParts.push(`Tags: ${source.tags}`);
              if (source.storage_path) metaParts.push(`Storage Path: ${source.storage_path}`);
              const metaHeader = metaParts.join(' | ');
              const docBlock = `--- Document [${metaHeader}] ---\n${fullContent}`;
              fullDocContents.push(docBlock);
              totalChars += docBlock.length;
            } catch (error) {
              console.error(`Error fetching content for document ${source.doc_id}:`, error.message);
            }
          }
          if (fullDocContents.length > 0) {
            enhancedContext = enhancedContext + '\n\n' + fullDocContents.join('\n\n');
          }
        }
      }
      
      // 3. Use AI service to generate an answer based on the enhanced context
      const aiService = AIServiceFactory.getService();
      
      // Build conversation history context if available
      let historyContext = '';
      if (chatHistory && chatHistory.length > 0) {
        historyContext = '\n\nPrevious conversation:\n' + chatHistory.map(msg => 
          `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
        ).join('\n') + '\n\n';
      }
      
      // Create a language-agnostic prompt that works in any language
      const savedPrompt = await this.getSystemPrompt();
      const systemInstruction = savedPrompt || this.getDefaultPrompt();
      
      let prompt;
      if (isFollowUp) {
        // Follow-up: no document context, rely entirely on chat history
        prompt = `
        ${systemInstruction}

        The user is asking a follow-up question about your previous answer. Use the conversation history to respond.
        ${historyContext}
        Follow-up question: ${question}

        Important instructions:
        - Base your answer on the previous conversation — reformat, summarize, or elaborate as requested
        - Answer in the same language as the question was asked
        - Use markdown formatting for structure (headers, bullet points, bold, tables, etc.) when appropriate
        `;
      } else {
        prompt = `
        ${systemInstruction}

        Answer the following question precisely, based on the provided documents:
        ${historyContext}
        Question: ${question}

        Context from relevant documents:
        ${enhancedContext}

        Important instructions:
        - Each document is delimited by --- Document [...] --- and includes metadata (Title, Correspondent, Date, Tags, Storage Path) — use this metadata to accurately identify and distinguish documents
        - Use ONLY information from the provided documents
        - If the answer is not contained in the documents, respond: "This information is not contained in the documents." (in the same language as the question)
        - Avoid assumptions or speculation beyond the given context
        - Answer in the same language as the question was asked
        - Do not mention document numbers or source references, answer as if it were a natural conversation
        - Use markdown formatting for structure (headers, bullet points, bold, etc.) when appropriate
        `;
      }

      let answer;
      try {
        // If a specific RAG chat model is configured, temporarily override the model
        if (this.ragChatModel) {
          answer = await aiService.generateText(prompt, { model: this.ragChatModel });
        } else {
          answer = await aiService.generateText(prompt);
        }
      } catch (error) {
        console.error('Error generating answer with AI service:', error);
        answer = "An error occurred while generating an answer. Please try again later.";
      }
      
      return {
        answer,
        sources,
        paperlessPublicUrl: this.paperlessPublicUrl
      };
    } catch (error) {
      console.error('Error in askQuestion:', error);
      throw new Error("An error occurred while processing your question. Please try again later.");
    }
  }

  /**
   * Get available storage paths from the RAG service
   * @returns {Promise<Array>} - List of storage paths
   */
  async getStoragePaths() {
    try {
      const response = await axios.get(`${this.baseUrl}/storage-paths`);
      return response.data;
    } catch (error) {
      console.error('Error getting storage paths:', error.message);
      return [];
    }
  }

  /**
   * Start indexing documents in the RAG service
   * @param {boolean} force - Whether to force refresh from source
   * @returns {Promise<Object>} - Indexing status
   */
  async indexDocuments(force = false) {
    try {
      const response = await axios.post(`${this.baseUrl}/indexing/start`, { 
        force, 
        background: true 
      });
      return response.data;
    } catch (error) {
      console.error('Error indexing documents:', error);
      throw error;
    }
  }

  /**
   * Check if the RAG service needs document updates
   * @returns {Promise<{needs_update: boolean, message: string}>}
   */
  async checkForUpdates() {
    try {
      const response = await axios.post(`${this.baseUrl}/indexing/check`);
      return response.data;
    } catch (error) {
      console.error('Error checking for updates:', error);
      throw error;
    }
  }

  /**
   * Get current indexing status
   * @returns {Promise<Object>} - Current indexing status
   */
  async getIndexingStatus() {
    try {
      const response = await axios.get(`${this.baseUrl}/indexing/status`);
      return response.data;
    } catch (error) {
      console.error('Error getting indexing status:', error);
      throw error;
    }
  }

  /**
   * Initialize the RAG service
   * @param {boolean} force - Whether to force initialization
   * @returns {Promise<Object>} - Initialization status
   */
  async initialize(force = false) {
    try {
      const response = await axios.post(`${this.baseUrl}/initialize`, { force });
      return response.data;
    } catch (error) {
      console.error('Error initializing RAG service:', error);
      throw error;
    }
  }

  /**
   * Get AI status
   * @returns {Promise<{status: string}>}
   */
  async getAIStatus() {
    try {
      const aiService = AIServiceFactory.getService();
      const status = await aiService.checkStatus();
      return status;
    } catch (error) {
      console.error('Error checking AI service status:', error);
      throw error;
    }
  }
}


module.exports = new RagService();
