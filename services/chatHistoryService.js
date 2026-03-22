// services/chatHistoryService.js
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const HISTORY_DIR = path.join(process.cwd(), 'data', 'chat_history');

class ChatHistoryService {
  constructor() {
    this._ensureDir();
  }

  async _ensureDir() {
    try {
      await fs.mkdir(HISTORY_DIR, { recursive: true });
    } catch (err) {
      // directory already exists
    }
  }

  _sessionPath(sessionId) {
    // Sanitize sessionId to prevent path traversal
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(HISTORY_DIR, `${safe}.json`);
  }

  async createSession(title) {
    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      title: title || 'New Chat',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      messages: []
    };
    await this._ensureDir();
    await fs.writeFile(this._sessionPath(sessionId), JSON.stringify(session, null, 2), 'utf-8');
    return session;
  }

  async getSession(sessionId) {
    try {
      const data = await fs.readFile(this._sessionPath(sessionId), 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      return null;
    }
  }

  async addMessage(sessionId, role, content, sources = null) {
    const session = await this.getSession(sessionId);
    if (!session) return null;

    session.messages.push({
      role,
      content,
      sources: sources || undefined,
      timestamp: new Date().toISOString()
    });
    session.updated = new Date().toISOString();

    // Update title from first user message if still default
    if (session.title === 'New Chat' && role === 'user') {
      session.title = content.substring(0, 80) + (content.length > 80 ? '...' : '');
    }

    await fs.writeFile(this._sessionPath(sessionId), JSON.stringify(session, null, 2), 'utf-8');
    return session;
  }

  async listSessions() {
    await this._ensureDir();
    const files = await fs.readdir(HISTORY_DIR);
    const sessions = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = await fs.readFile(path.join(HISTORY_DIR, file), 'utf-8');
        const session = JSON.parse(data);
        sessions.push({
          id: session.id,
          title: session.title,
          created: session.created,
          updated: session.updated,
          messageCount: session.messages.length
        });
      } catch (err) {
        // skip corrupted files
      }
    }

    // Sort by most recently updated
    sessions.sort((a, b) => new Date(b.updated) - new Date(a.updated));
    return sessions;
  }

  async deleteSession(sessionId) {
    try {
      await fs.unlink(this._sessionPath(sessionId));
      return true;
    } catch (err) {
      return false;
    }
  }
}

module.exports = new ChatHistoryService();
