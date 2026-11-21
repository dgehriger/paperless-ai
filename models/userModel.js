// models/userModel.js
// User management for multi-user mode (CF Access authentication)
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'documents.db'));
db.pragma('journal_mode = WAL');

// ============================================================================
// Table creation
// ============================================================================

db.prepare(`
  CREATE TABLE IF NOT EXISTS cf_users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    is_approved INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    permissions TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login TEXT
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS libraries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    filters TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS user_libraries (
    user_id TEXT NOT NULL REFERENCES cf_users(id) ON DELETE CASCADE,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, library_id)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS share_tokens (
    token TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
  )
`).run();

// ============================================================================
// Prepared statements
// ============================================================================

const findUserByEmail = db.prepare('SELECT * FROM cf_users WHERE email = ?');
const findUserById = db.prepare('SELECT * FROM cf_users WHERE id = ?');
const listAllUsers = db.prepare('SELECT * FROM cf_users ORDER BY created_at DESC');

const insertUser = db.prepare(`
  INSERT INTO cf_users (id, email, name, is_approved, is_admin, permissions)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updateUserApproval = db.prepare(`
  UPDATE cf_users SET is_approved = ?, updated_at = datetime('now') WHERE id = ?
`);

const updateUserPermissions = db.prepare(`
  UPDATE cf_users SET permissions = ?, updated_at = datetime('now') WHERE id = ?
`);

const updateUserAdmin = db.prepare(`
  UPDATE cf_users SET is_admin = ?, updated_at = datetime('now') WHERE id = ?
`);

const updateUserLogin = db.prepare(`
  UPDATE cf_users SET last_login = datetime('now'), updated_at = datetime('now') WHERE id = ?
`);

const deleteUserStmt = db.prepare('DELETE FROM cf_users WHERE id = ?');

// Libraries
const findLibraryById = db.prepare('SELECT * FROM libraries WHERE id = ?');
const listAllLibraries = db.prepare('SELECT * FROM libraries ORDER BY name');
const insertLibrary = db.prepare(`
  INSERT INTO libraries (id, name, description, filters) VALUES (?, ?, ?, ?)
`);
const updateLibrary = db.prepare(`
  UPDATE libraries SET name = ?, description = ?, filters = ?, updated_at = datetime('now') WHERE id = ?
`);
const deleteLibraryStmt = db.prepare('DELETE FROM libraries WHERE id = ?');

// User-Library mappings
const getUserLibraries = db.prepare(`
  SELECT l.* FROM libraries l
  JOIN user_libraries ul ON ul.library_id = l.id
  WHERE ul.user_id = ?
`);
const setUserLibraries = db.transaction((userId, libraryIds) => {
  db.prepare('DELETE FROM user_libraries WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO user_libraries (user_id, library_id) VALUES (?, ?)');
  for (const libId of libraryIds) {
    ins.run(userId, libId);
  }
});

// Share tokens
const insertShareToken = db.prepare(`
  INSERT INTO share_tokens (token, session_id, created_by, expires_at) VALUES (?, ?, ?, ?)
`);
// expires_at is an ISO-8601 timestamp ("2026-01-02T03:04:05.000Z") while
// datetime('now') renders "2026-01-02 03:04:05". Compared as strings, 'T'
// sorts after ' ', so a token expired earlier today still looked valid until
// midnight. julianday() parses both forms, so compare the instants instead.
const findShareToken = db.prepare(`
  SELECT * FROM share_tokens
  WHERE token = ? AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
`);
const deleteShareToken = db.prepare('DELETE FROM share_tokens WHERE token = ?');
const deleteExpiredTokens = db.prepare(`
  DELETE FROM share_tokens WHERE expires_at IS NOT NULL AND julianday(expires_at) <= julianday('now')
`);
const listUserLibraryIds = db.prepare('SELECT user_id, library_id FROM user_libraries');
const listLibraryUsers = db.prepare(`
  SELECT u.id, u.email FROM cf_users u
  JOIN user_libraries ul ON ul.user_id = u.id
  WHERE ul.library_id = ?
  ORDER BY u.email
`);

// ============================================================================
// Default permissions list
// ============================================================================
const ALL_PERMISSIONS = [
  'rag_chat',        // Can use RAG chat
  'document_chat',   // Can use per-document chat
  'dashboard',       // Can view the dashboard
  'history',         // Can view own chat history
  'settings',        // Can access system settings
  'rag_settings',    // Can access RAG settings
  'manual',          // Can access manual processing
  'playground',      // Can access the playground
];

// ============================================================================
// Module exports
// ============================================================================

module.exports = {
  ALL_PERMISSIONS,

  /**
   * Find or create a user from a CF Access email.
   * Returns the user record. New users are NOT approved by default.
   */
  findOrCreateUser(email, adminEmails = []) {
    const normalizedEmail = email.toLowerCase().trim();
    let user = findUserByEmail.get(normalizedEmail);

    if (user) {
      // Check auto-admin promotion
      if (!user.is_admin && adminEmails.includes(normalizedEmail)) {
        updateUserAdmin.run(1, user.id);
        user.is_admin = 1;
      }
      updateUserLogin.run(user.id);
      user.permissions = JSON.parse(user.permissions || '[]');
      return user;
    }

    // New user
    const id = crypto.randomUUID();
    const isAdmin = adminEmails.includes(normalizedEmail) ? 1 : 0;
    const isApproved = isAdmin ? 1 : 0; // Admins are auto-approved
    const defaultPerms = isAdmin ? JSON.stringify(ALL_PERMISSIONS) : JSON.stringify(['rag_chat', 'history']);
    const name = normalizedEmail.split('@')[0];

    insertUser.run(id, normalizedEmail, name, isApproved, isAdmin, defaultPerms);
    user = findUserById.get(id);
    user.permissions = JSON.parse(user.permissions || '[]');
    return user;
  },

  /**
   * Pre-register a user before their first login.
   * Creates a user record that will be matched by findOrCreateUser on first CF Access login.
   */
  preRegisterUser(email, { permissions = ['rag_chat', 'history'], isAdmin = false, isApproved = true } = {}) {
    const normalizedEmail = email.toLowerCase().trim();
    const id = crypto.randomUUID();
    const name = normalizedEmail.split('@')[0];
    insertUser.run(id, normalizedEmail, name, isApproved ? 1 : 0, isAdmin ? 1 : 0, JSON.stringify(permissions));
    const user = findUserById.get(id);
    user.permissions = JSON.parse(user.permissions || '[]');
    return user;
  },

  getUserById(id) {
    const user = findUserById.get(id);
    if (user) user.permissions = JSON.parse(user.permissions || '[]');
    return user;
  },

  getUserByEmail(email) {
    const user = findUserByEmail.get(email.toLowerCase().trim());
    if (user) user.permissions = JSON.parse(user.permissions || '[]');
    return user;
  },

  listUsers() {
    const libraryIds = new Map();
    for (const row of listUserLibraryIds.all()) {
      if (!libraryIds.has(row.user_id)) libraryIds.set(row.user_id, []);
      libraryIds.get(row.user_id).push(row.library_id);
    }
    return listAllUsers.all().map(u => ({
      ...u,
      permissions: JSON.parse(u.permissions || '[]'),
      libraryIds: libraryIds.get(u.id) || [],
    }));
  },

  approveUser(userId, approved = true) {
    updateUserApproval.run(approved ? 1 : 0, userId);
    return this.getUserById(userId);
  },

  setUserPermissions(userId, permissions) {
    updateUserPermissions.run(JSON.stringify(permissions), userId);
    return this.getUserById(userId);
  },

  setUserAdmin(userId, isAdmin) {
    updateUserAdmin.run(isAdmin ? 1 : 0, userId);
    return this.getUserById(userId);
  },

  deleteUser(userId) {
    deleteUserStmt.run(userId);
  },

  // ========================================================================
  // Libraries
  // ========================================================================

  createLibrary(name, description, filters) {
    const id = crypto.randomUUID();
    insertLibrary.run(id, name, description || '', JSON.stringify(filters || {}));
    return this.getLibrary(id);
  },

  getLibrary(id) {
    const lib = findLibraryById.get(id);
    if (lib) lib.filters = JSON.parse(lib.filters || '{}');
    return lib;
  },

  listLibraries() {
    return listAllLibraries.all().map(l => ({
      ...l,
      filters: JSON.parse(l.filters || '{}'),
    }));
  },

  updateLibrary(id, name, description, filters) {
    updateLibrary.run(name, description || '', JSON.stringify(filters || {}), id);
    return this.getLibrary(id);
  },

  deleteLibrary(id) {
    deleteLibraryStmt.run(id);
  },

  /**
   * Users assigned to a library. A user's last library cannot simply vanish:
   * no library means unrestricted, so deleting it would widen their access.
   */
  getLibraryUsers(id) {
    return listLibraryUsers.all(id);
  },

  // User-Library mapping
  getUserLibraries(userId) {
    return getUserLibraries.all(userId).map(l => ({
      ...l,
      filters: JSON.parse(l.filters || '{}'),
    }));
  },

  setUserLibraries(userId, libraryIds) {
    setUserLibraries(userId, libraryIds);
  },

  /**
   * The document scope a user's libraries grant, as a list of predicates.
   *
   * Each library is one predicate: a document matches it when it satisfies
   * EVERY field the library sets (a field matches when the document's value is
   * any of the listed names; for tags, when the document carries any listed
   * tag). A document is in scope when it matches ANY of the user's libraries.
   *
   * Returns null when the user is unrestricted: no libraries assigned, or at
   * least one assigned library that sets no field at all ("all documents").
   */
  getLibraryScope(userId) {
    const libs = this.getUserLibraries(userId);
    if (libs.length === 0) return null;
    const scope = [];
    for (const lib of libs) {
      const f = lib.filters || {};
      const predicate = {};
      for (const key of ['storage_paths', 'tags', 'correspondents', 'document_types']) {
        const values = Array.isArray(f[key]) ? f[key].map(v => String(v).trim()).filter(v => v) : [];
        if (values.length > 0) predicate[key] = [...new Set(values)];
      }
      if (Object.keys(predicate).length === 0) return null;
      scope.push(predicate);
    }
    return scope;
  },

  /**
   * Build storage path + tag filters from the user's assigned libraries.
   * Returns { storagePaths: string[], tags: string[], correspondents: string[], documentTypes: string[] }
   */
  getLibraryFilters(userId) {
    const libs = this.getUserLibraries(userId);
    const result = { storagePaths: [], tags: [], correspondents: [], documentTypes: [] };
    for (const lib of libs) {
      const f = lib.filters || {};
      if (f.storage_paths) result.storagePaths.push(...f.storage_paths);
      if (f.tags) result.tags.push(...f.tags);
      if (f.correspondents) result.correspondents.push(...f.correspondents);
      if (f.document_types) result.documentTypes.push(...f.document_types);
    }
    // Deduplicate
    result.storagePaths = [...new Set(result.storagePaths)];
    result.tags = [...new Set(result.tags)];
    result.correspondents = [...new Set(result.correspondents)];
    result.documentTypes = [...new Set(result.documentTypes)];
    return result;
  },

  // ========================================================================
  // Share tokens
  // ========================================================================

  createShareToken(sessionId, userId, expiresInHours = 72) {
    deleteExpiredTokens.run();
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString();
    insertShareToken.run(token, sessionId, userId, expiresAt);
    return { token, expiresAt };
  },

  getShareToken(token) {
    deleteExpiredTokens.run();
    return findShareToken.get(token);
  },

  deleteShareToken(token) {
    deleteShareToken.run(token);
  },
};
