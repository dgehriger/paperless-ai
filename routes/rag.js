// routes/rag.js
//
// Page and API permissions are enforced centrally (authorizeRequest in
// middleware/cfAuth.js); this router enforces what depends on the data: who
// owns a conversation, and which documents a library-restricted user may see.
const express = require('express');
const router = express.Router();
const ragService = require('../services/ragService');
const chatHistoryService = require('../services/chatHistoryService');
const paperlessService = require('../services/paperlessService');
const userModel = require('../models/userModel');
const { AUTH_MODE } = require('../middleware/cfAuth');
const { getScope, assertDocumentAccess, documentNames, filterSources, AccessDeniedError } = require('../services/accessService');

/**
 * Get the current user's ID (or null in local mode)
 */
function getUserId(req) {
  if (AUTH_MODE === 'cf_access' && req.cfUser) return req.cfUser.id;
  return null;
}

/**
 * Load a session the caller may use, or send the error response and return null.
 *
 * Local mode is single-user, so every session is the user's. In cf_access mode
 * a session belongs to the user who created it; admins may open any session,
 * and nobody else may open one without an owner (those predate multi-user mode).
 */
async function loadAuthorizedSession(req, res, sessionId) {
  const session = typeof sessionId === 'string' && sessionId
    ? await chatHistoryService.getSession(sessionId)
    : null;
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  if (AUTH_MODE === 'cf_access') {
    const user = req.cfUser;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return null;
    }
    if (!user.is_admin && session.userId !== user.id) {
      res.status(403).json({ error: 'Not authorized to access this session' });
      return null;
    }
  }
  return session;
}

function normalizePaths(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim());
}

/**
 * Whether a storage-path selection can match anything the scope allows.
 * Only decidable when every library restricts storage paths; otherwise a
 * document on any path may still be in scope through its other fields.
 */
function selectionWithinScope(paths, scope) {
  if (!scope || paths.length === 0) return true;
  if (!scope.every(p => p.storage_paths)) return true;
  const allowed = new Set(scope.flatMap(p => p.storage_paths).map(p => p.toLowerCase()));
  return paths.some(p => allowed.has(p.toLowerCase()));
}

/**
 * Search documents
 */
router.post('/search', async (req, res) => {
  try {
    const { query, from_date, to_date, correspondent } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const filters = {};
    if (from_date) filters.from_date = from_date;
    if (to_date) filters.to_date = to_date;
    if (correspondent) filters.correspondent = correspondent;
    const scope = getScope(req);
    if (scope) filters.libraries = scope;

    const results = await ragService.search(query, filters);
    // The index can lag behind Paperless; re-check against current metadata.
    res.json(scope ? await filterSources(req, results) : results);
  } catch (error) {
    console.error('Error in /api/rag/search:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Ask a question about documents
 */
router.post('/ask', async (req, res) => {
  try {
    const { question, sessionId } = req.body;

    // Checked before any session is created or changed: history stores the
    // question as text, and a number or object saved there breaks later turns.
    if (typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'Question must be a non-empty string' });
    }
    if (sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId must be a string' });
    }

    const userId = getUserId(req);
    const storagePaths = normalizePaths(req.body.storagePaths);
    const scope = getScope(req);

    // A selection outside the user's libraries is refused outright. Passing it
    // on would at best return nothing, and an empty selection must never be
    // mistaken for "no filter".
    if (!selectionWithinScope(storagePaths, scope)) {
      return res.status(403).json({ error: 'None of the selected storage paths is in your libraries' });
    }

    // Get or create a session for chat history
    let session = null;
    let activeSessionId = sessionId;
    if (!activeSessionId) {
      session = await chatHistoryService.createSession(undefined, userId);
      activeSessionId = session.id;
    } else {
      session = await loadAuthorizedSession(req, res, activeSessionId);
      if (!session) return;
    }

    // Build chat history from session for context.
    // Use a character budget (100K) filled from most-recent messages backward so
    // the latest exchanges always have full fidelity and older ones are truncated
    // only when the budget is exhausted.
    let chatHistory = [];
    if (session && session.messages) {
      const HISTORY_BUDGET = 100_000; // characters
      const lastMessages = session.messages.slice(-10);
      let remaining = HISTORY_BUDGET;

      // Walk backward so recent messages get priority
      for (let i = lastMessages.length - 1; i >= 0; i--) {
        const m = lastMessages[i];
        let content = m.content;
        if (remaining <= 0) {
          content = content.substring(0, 200) + '…';
        } else if (content.length > remaining) {
          content = content.substring(0, remaining) + '…';
        }
        remaining -= content.length;
        chatHistory.unshift({ role: m.role, content });
      }
    }

    // Save user message to history
    await chatHistoryService.addMessage(activeSessionId, 'user', question);

    const authorizeSources = scope ? (sources) => filterSources(req, sources) : null;
    const result = await ragService.askQuestion(question, chatHistory, storagePaths, scope, authorizeSources);

    // Only save successful answers to history (not error fallback messages)
    const isError = result.answer.startsWith('An error occurred') || result.answer.startsWith('This information is not contained');
    if (!isError) {
      await chatHistoryService.addMessage(activeSessionId, 'assistant', result.answer, result.sources);
    }

    res.json({ ...result, sessionId: activeSessionId });
  } catch (error) {
    console.error('Error in /api/rag/ask:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * List chat history sessions
 */
router.get('/history', async (req, res) => {
  try {
    const userId = getUserId(req);
    const sessions = await chatHistoryService.listSessions(userId);
    res.json(sessions);
  } catch (error) {
    console.error('Error in /api/rag/history:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Get a specific chat session
 */
router.get('/history/:id', async (req, res) => {
  try {
    const session = await loadAuthorizedSession(req, res, req.params.id);
    if (!session) return;
    res.json(session);
  } catch (error) {
    console.error('Error in /api/rag/history/:id:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Delete a chat session
 */
router.delete('/history/:id', async (req, res) => {
  try {
    const session = await loadAuthorizedSession(req, res, req.params.id);
    if (!session) return;
    const success = await chatHistoryService.deleteSession(session.id);
    if (!success) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error in DELETE /api/rag/history/:id:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Create a share link for a chat session
 */
router.post('/history/:id/share', async (req, res) => {
  try {
    const session = await loadAuthorizedSession(req, res, req.params.id);
    if (!session) return;
    const userId = getUserId(req);
    const { token, expiresAt } = userModel.createShareToken(session.id, userId || 'local');
    res.json({ shareUrl: `/shared/${token}`, expiresAt });
  } catch (error) {
    console.error('Error creating share link:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Get the full text of one document the caller may see
 */
router.get('/documents/:id', async (req, res) => {
  try {
    const docId = parseInt(req.params.id, 10);
    if (isNaN(docId)) return res.status(400).json({ error: 'Invalid document ID' });
    const doc = await paperlessService.getDocument(docId);
    await assertDocumentAccess(req, doc);
    const names = await documentNames(doc);
    res.set('Cache-Control', 'private, no-store');
    res.json({
      id: doc.id,
      title: doc.title,
      created: doc.created,
      correspondent: names.correspondent,
      document_type: names.document_type,
      storage_path: names.storage_path,
      tags: names.tags,
      content: doc.content || '',
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return res.status(403).json({ error: error.message });
    }
    if (error.response && error.response.status === 404) {
      return res.status(404).json({ error: 'Document not found' });
    }
    console.error('Error in /api/rag/documents/:id:', error.message);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

/**
 * Start document indexing.
 * Without `force`, this indexes what is new in Paperless since the last run;
 * with it, it rebuilds both indexes from scratch.
 */
router.post('/index', async (req, res) => {
  try {
    const { force = false } = req.body;
    const result = await ragService.indexDocuments(!!force);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/rag/index:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Get indexing status
 */
router.get('/index/status', async (req, res) => {
  try {
    const status = await ragService.getIndexingStatus();
    res.json(status);
  } catch (error) {
    console.error('Error in /api/rag/index/status:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Check if updates are needed
 */
router.get('/index/check', async (req, res) => {
  try {
    const result = await ragService.checkForUpdates();
    res.json(result);
  } catch (error) {
    console.error('Error in /api/rag/index/check:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Get the built-in default system prompt
 */
router.get('/default-prompt', (req, res) => {
  res.json({ prompt: ragService.getDefaultPrompt() });
});

/**
 * Get RAG system prompt
 */
router.get('/system-prompt', async (req, res) => {
  try {
    const prompt = await ragService.getSystemPrompt();
    res.json({ prompt });
  } catch (error) {
    console.error('Error getting system prompt:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Update RAG system prompt
 */
router.put('/system-prompt', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt must be a string' });
    }
    await ragService.setSystemPrompt(prompt);
    res.json({ success: true });
  } catch (error) {
    console.error('Error setting system prompt:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Get available storage paths for filtering, limited to the caller's libraries
 */
router.get('/storage-paths', async (req, res) => {
  try {
    const paths = await ragService.getStoragePaths(getScope(req));
    res.json(paths);
  } catch (error) {
    console.error('Error in /api/rag/storage-paths:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Get RAG service status
 */
router.get('/status', async (req, res) => {
  try {
    const status = await ragService.checkStatus();
    const aiStatus = await ragService.getAIStatus();
    // Combine RAG and AI status
    status.ai_status = aiStatus.status;
    status.ai_model = aiStatus.model;
    res.json(status);
  } catch (error) {
    console.error('Error in /api/rag/status:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Initialize RAG service
 */
router.post('/initialize', async (req, res) => {
  try {
    const { force = false } = req.body;
    const result = await ragService.initialize(force);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/rag/initialize:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

module.exports = router;
