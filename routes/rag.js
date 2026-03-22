// routes/rag.js
const express = require('express');
const router = express.Router();
const ragService = require('../services/ragService');
const chatHistoryService = require('../services/chatHistoryService');

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
    
    const results = await ragService.search(query, filters);
    res.json(results);
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
    const { question, sessionId, storagePaths } = req.body;
    
    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }
    
    // Get or create a session for chat history
    let session = null;
    let activeSessionId = sessionId;
    if (!activeSessionId) {
      session = await chatHistoryService.createSession();
      activeSessionId = session.id;
    } else {
      session = await chatHistoryService.getSession(activeSessionId);
    }
    
    // Build chat history from session for context
    let chatHistory = [];
    if (session && session.messages) {
      // Build chat history: keep the last assistant message in full (follow-ups need it),
      // truncate older assistant messages to save context space, keep user messages in full.
      const lastMessages = session.messages.slice(-10);
      const lastAssistantIdx = lastMessages.map(m => m.role).lastIndexOf('assistant');
      chatHistory = lastMessages.map((m, i) => ({
        role: m.role,
        content: (m.role === 'assistant' && i !== lastAssistantIdx)
          ? m.content.substring(0, 500)
          : m.content
      }));
    }
    
    // Save user message to history
    if (activeSessionId) {
      await chatHistoryService.addMessage(activeSessionId, 'user', question);
    }
    
    const result = await ragService.askQuestion(question, chatHistory, storagePaths || []);
    
    // Only save successful answers to history (not error fallback messages)
    const isError = result.answer.startsWith('An error occurred') || result.answer.startsWith('This information is not contained');
    if (activeSessionId && !isError) {
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
    const sessions = await chatHistoryService.listSessions();
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
    const session = await chatHistoryService.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
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
    const success = await chatHistoryService.deleteSession(req.params.id);
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
 * Start document indexing
 */
router.post('/index', async (req, res) => {
  try {
    const { force = false } = req.body;
    const result = await ragService.indexDocuments(force);
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
 * Get available storage paths for filtering
 */
router.get('/storage-paths', async (req, res) => {
  try {
    const paths = await ragService.getStoragePaths();
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
    // console.log('RAG Status:', status);
    // console.log('AI Status:', aiStatus);
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
