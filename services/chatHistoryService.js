// services/chatHistoryService.js
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const HISTORY_DIR = path.join(process.cwd(), 'data', 'chat_history');

class ChatHistoryService {
  constructor() {
    // Tail of the pending update chain per session. Every read-modify-write of
    // a session file runs after the previous one for that session settles, so
    // two concurrent appends (a user message and the assistant's answer, or two
    // tabs) cannot both read the old file and overwrite each other.
    this._queues = new Map();
    this._ensureDir();
  }

  async _ensureDir() {
    try {
      await fs.mkdir(HISTORY_DIR, { recursive: true });
    } catch {
      // directory already exists
    }
  }

  _safeId(sessionId) {
    // Sanitize sessionId to prevent path traversal
    return String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  }

  _sessionPath(sessionId) {
    return path.join(HISTORY_DIR, `${this._safeId(sessionId)}.json`);
  }

  /**
   * Run `task` after every earlier task queued for the same session.
   */
  _serialize(sessionId, task) {
    const key = this._safeId(sessionId);
    const previous = this._queues.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    this._queues.set(key, tail);
    tail.then(() => {
      if (this._queues.get(key) === tail) this._queues.delete(key);
    });
    return run;
  }

  /**
   * Replace a session file atomically: readers see the old file or the new
   * one, never a partially written one.
   */
  async _writeSession(session) {
    await this._ensureDir();
    const target = this._sessionPath(session.id);
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(session, null, 2), 'utf-8');
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async createSession(title, userId = null) {
    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      title: title || 'New Chat',
      userId: userId || null,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      messages: []
    };
    await this._serialize(sessionId, () => this._writeSession(session));
    return session;
  }

  async getSession(sessionId) {
    try {
      const data = await fs.readFile(this._sessionPath(sessionId), 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async addMessage(sessionId, role, content, sources = null) {
    return this._serialize(sessionId, async () => {
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

      await this._writeSession(session);
      return session;
    });
  }

  /**
   * List sessions, optionally filtered by userId.
   * If userId is null, returns all sessions (local mode, single user).
   * With a userId, only sessions owned by exactly that user are returned:
   * ownerless sessions (created in local mode) belong to nobody here.
   */
  async listSessions(userId = null) {
    await this._ensureDir();
    const files = await fs.readdir(HISTORY_DIR);
    const sessions = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = await fs.readFile(path.join(HISTORY_DIR, file), 'utf-8');
        const session = JSON.parse(data);
        if (userId && session.userId !== userId) continue;
        sessions.push({
          id: session.id,
          title: session.title,
          userId: session.userId || null,
          created: session.created,
          updated: session.updated,
          messageCount: session.messages.length
        });
      } catch {
        // skip corrupted files
      }
    }

    // Sort by most recently updated
    sessions.sort((a, b) => new Date(b.updated) - new Date(a.updated));
    return sessions;
  }

  async deleteSession(sessionId) {
    return this._serialize(sessionId, async () => {
      try {
        await fs.unlink(this._sessionPath(sessionId));
        return true;
      } catch {
        return false;
      }
    });
  }
}

module.exports = new ChatHistoryService();
