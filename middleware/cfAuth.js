// middleware/cfAuth.js
// Dual-mode authentication middleware: 'local' (legacy JWT) or 'cf_access' (Cloudflare tunnel)

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const userModel = require('../models/userModel');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const AUTH_MODE = (process.env.AUTH_MODE || 'local').toLowerCase();
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(e => e.length > 0);
const DEV_USER_EMAIL = process.env.DEV_USER_EMAIL || '';

// Cloudflare Access signs every request it forwards with a JWT in this header
// (and in the CF_Authorization cookie). The plain email header next to it is
// NOT authenticated: anyone who can reach the origin directly can set it. So
// identity comes only from a token whose signature, audience and issuer check
// out against the team's published keys.
const CF_ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
const CF_ACCESS_JWT_COOKIE = 'CF_Authorization';

function normalizeTeamDomain(value) {
  const trimmed = (value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const CF_ACCESS_TEAM_DOMAIN = normalizeTeamDomain(process.env.CF_ACCESS_TEAM_DOMAIN);
const CF_ACCESS_AUD = (process.env.CF_ACCESS_AUD || '').trim();
const CERTS_TTL_MS = 60 * 60 * 1000;

let signingKeys = new Map();
let signingKeysFetchedAt = 0;
let signingKeysPending = null;
let configWarningLogged = false;

function cfAccessConfigured() {
  if (CF_ACCESS_TEAM_DOMAIN && CF_ACCESS_AUD) return true;
  if (!configWarningLogged) {
    configWarningLogged = true;
    console.error('[AUTH] AUTH_MODE=cf_access requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD; refusing every request until both are set.');
  }
  return false;
}

async function fetchSigningKeys() {
  const res = await fetch(`${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Cloudflare Access certs request failed: HTTP ${res.status}`);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    if (!jwk.kid) continue;
    keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
  }
  if (keys.size === 0) throw new Error('Cloudflare Access published no signing keys');
  signingKeys = keys;
  signingKeysFetchedAt = Date.now();
}

/**
 * The public key for a token's kid. Keys are cached for an hour and refreshed
 * early when an unknown kid appears, which is what a key rotation looks like.
 */
async function getSigningKey(kid) {
  const stale = Date.now() - signingKeysFetchedAt > CERTS_TTL_MS;
  if (stale || !signingKeys.has(kid)) {
    if (!signingKeysPending) {
      signingKeysPending = fetchSigningKeys().finally(() => { signingKeysPending = null; });
    }
    await signingKeysPending;
  }
  const key = signingKeys.get(kid);
  if (!key) throw new Error(`Unknown Cloudflare Access signing key: ${kid}`);
  return key;
}

/**
 * Verify a Cloudflare Access token and return its identity, or null.
 * A user token carries `email`; a service token carries `common_name` (its
 * client ID) instead, which is mapped to a pseudo-address so an admin can
 * approve it like any other account.
 */
async function verifyCfAccessToken(token) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) return null;
  const key = await getSigningKey(decoded.header.kid);
  const payload = jwt.verify(token, key, {
    algorithms: ['RS256'],
    audience: CF_ACCESS_AUD,
    issuer: CF_ACCESS_TEAM_DOMAIN,
  });
  if (payload.email) return String(payload.email);
  if (payload.common_name) return `${String(payload.common_name)}@service-token.cloudflareaccess`;
  return null;
}

/**
 * Get the authenticated user email from a verified CF Access token (or dev bypass)
 */
async function getCfAccessEmail(req) {
  // Development bypass: only ever honoured when explicitly in development.
  if (process.env.NODE_ENV === 'development' && DEV_USER_EMAIL) {
    return DEV_USER_EMAIL;
  }

  if (!cfAccessConfigured()) return null;

  const token = req.headers[CF_ACCESS_JWT_HEADER] || (req.cookies && req.cookies[CF_ACCESS_JWT_COOKIE]);
  if (!token) return null;

  try {
    return await verifyCfAccessToken(token);
  } catch (error) {
    console.warn('[AUTH] Rejected Cloudflare Access token:', error.message);
    return null;
  }
}

/**
 * Resolve the current user in CF Access mode. Resolves to the user object or null.
 */
async function getCfUser(req) {
  const email = await getCfAccessEmail(req);
  if (!email) return null;
  return userModel.findOrCreateUser(email, ADMIN_EMAILS);
}

/**
 * Core auth middleware for API routes (returns 401 JSON).
 * In local mode: checks JWT/API key (original behavior).
 * In cf_access mode: checks the CF Access token, requires approved user.
 */
async function authenticateJWT(req, res, next) {
  if (AUTH_MODE === 'cf_access') {
    const user = await getCfUser(req);
    if (!user) {
      return res.status(401).json({ message: 'Cloudflare Access authentication required' });
    }
    if (!user.is_approved && !user.is_admin) {
      return res.status(403).json({ message: 'Account pending admin approval' });
    }
    req.cfUser = user;
    req.user = { id: user.id, email: user.email, cfAccess: true };
    return next();
  }

  // Legacy local auth
  const token = req.cookies.jwt || req.headers.authorization?.split(' ')[1];
  const apiKey = req.headers['x-api-key'];

  if (apiKey && apiKey === process.env.API_KEY) {
    req.user = { apiKey: true };
    return next();
  }

  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
}

/**
 * Page auth middleware (redirects to login).
 * In cf_access mode, redirects to pending page if not approved.
 */
async function isAuthenticated(req, res, next) {
  if (AUTH_MODE === 'cf_access') {
    const user = await getCfUser(req);
    if (!user) {
      return res.status(401).send('Cloudflare Access authentication required. Ensure you are accessing this app through the CF tunnel.');
    }
    if (!user.is_approved && !user.is_admin) {
      return res.redirect('/pending-approval');
    }
    req.cfUser = user;
    req.user = { id: user.id, email: user.email, cfAccess: true };
    return next();
  }

  // Legacy local auth
  const token = req.cookies.jwt || req.headers.authorization?.split(' ')[1];
  const apiKey = req.headers['x-api-key'];

  if (apiKey && apiKey === process.env.API_KEY) {
    req.user = { apiKey: true };
    return next();
  }

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.clearCookie('jwt');
    return res.redirect('/login');
  }
}

function wantsJson(req) {
  return req.path.startsWith('/api/') || req.xhr || !req.accepts('html');
}

function denyAccess(req, res, message) {
  if (wantsJson(req)) {
    return res.status(403).json({ message });
  }
  return res.status(403).render('error', { title: 'Access Denied', message });
}

/**
 * Whether a user holds any of the given permissions. Admins hold all of them,
 * and local mode is a single-user system with full access.
 */
function hasPermission(user, ...permissions) {
  if (AUTH_MODE !== 'cf_access') return true;
  if (!user) return false;
  if (user.is_admin) return true;
  const userPerms = user.permissions || [];
  return permissions.some(p => userPerms.includes(p));
}

/**
 * Require a specific permission. Must be called after isAuthenticated/authenticateJWT.
 * In local mode, all permissions are granted (single-user system).
 */
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (AUTH_MODE !== 'cf_access') return next(); // local mode = full access
    if (!req.cfUser) return res.status(401).json({ message: 'Not authenticated' });
    if (!hasPermission(req.cfUser, ...permissions)) {
      return denyAccess(req, res, 'You do not have permission to access this feature.');
    }
    next();
  };
}

/**
 * Require admin role.
 */
function requireAdmin(req, res, next) {
  if (AUTH_MODE !== 'cf_access') return next(); // local mode = full access

  const user = req.cfUser;
  if (!user || !user.is_admin) {
    return denyAccess(req, res, 'Admin access required.');
  }
  next();
}

// ============================================================================
// Route permissions (cf_access mode)
// ============================================================================
//
// Approval only says who may sign in. What an approved user may then reach is
// decided here, once, for every page and API the app serves, so a feature
// cannot become reachable by being added without a check of its own. Entries
// are matched in order on a path prefix (or an exact path); the first match
// wins. A path that matches nothing is denied to non-admins.
//
// `null` permissions means "any approved user".
const ROUTE_PERMISSIONS = [
  { prefix: '/api/me', permissions: null },
  { prefix: '/logout', permissions: null },
  { prefix: '/pending-approval', permissions: null },
  { exact: '/', permissions: null },

  { prefix: '/admin', admin: true },
  { prefix: '/api/admin', admin: true },
  // Writes the configuration and restarts the app: never public here.
  { prefix: '/setup', admin: true },

  // RAG chat and its supporting endpoints
  { prefix: '/rag/settings', permissions: ['rag_settings'] },
  { prefix: '/api/rag/system-prompt', permissions: ['rag_settings'] },
  { prefix: '/api/rag/default-prompt', permissions: ['rag_settings'] },
  { prefix: '/api/rag/index', permissions: ['rag_settings'] },
  { prefix: '/api/rag/initialize', permissions: ['rag_settings'] },
  { prefix: '/api/rag/history', permissions: ['history'] },
  { prefix: '/api/rag/status', permissions: ['rag_chat', 'rag_settings'] },
  { prefix: '/api/rag/', permissions: ['rag_chat'] },
  { exact: '/rag', permissions: ['rag_chat'] },
  { prefix: '/api/documents/', permissions: ['rag_chat', 'history', 'document_chat'] },

  // Per-document chat
  { prefix: '/chat', permissions: ['document_chat'] },
  { prefix: '/thumb/', permissions: ['document_chat', 'dashboard', 'manual', 'playground'] },

  // Dashboard and processing overview
  { prefix: '/dashboard', permissions: ['dashboard'] },
  { prefix: '/api/correspondentscount', permissions: ['dashboard', 'manual'] },
  { prefix: '/api/tagscount', permissions: ['dashboard', 'manual'] },
  { prefix: '/api/correspondents', permissions: ['dashboard', 'manual'] },
  { prefix: '/api/tags', permissions: ['dashboard', 'manual'] },
  { prefix: '/api/processing-status', permissions: ['dashboard'] },

  // Manual processing and the playground
  { prefix: '/manual/playground', permissions: ['playground'] },
  { prefix: '/manual/preview', permissions: ['manual', 'playground'] },
  { prefix: '/playground', permissions: ['playground'] },
  { prefix: '/manual', permissions: ['manual'] },

  // System settings and everything that changes or exposes configuration
  { prefix: '/settings', permissions: ['settings'] },
  { prefix: '/history', permissions: ['settings'] },
  { prefix: '/api/history', permissions: ['settings'] },
  { prefix: '/api/reset-all-documents', permissions: ['settings'] },
  { prefix: '/api/reset-documents', permissions: ['settings'] },
  { prefix: '/api/scan/now', permissions: ['settings'] },
  { prefix: '/api/key-regenerate', permissions: ['settings'] },
  { prefix: '/api/webhook/', permissions: ['settings'] },
  { prefix: '/api/rag-test', permissions: ['settings'] },
  { prefix: '/sampleData', permissions: ['settings'] },
  { prefix: '/debug', permissions: ['settings'] },
];

// Express matches routes case-insensitively, so this table must too: with a
// case-sensitive match, /api/rag/INDEX reached the indexing route through the
// broader /api/rag/ rule. Rules are lower-case; the path is lowered to match.
function matchRoute(req) {
  const p = String(req.path || '').toLowerCase();
  return ROUTE_PERMISSIONS.find(rule => {
    if (rule.exact !== undefined) return p === rule.exact || p === `${rule.exact}/`;
    return p.startsWith(rule.prefix);
  });
}

/**
 * Authorize an authenticated cf_access request against ROUTE_PERMISSIONS.
 * Local mode and admins pass unconditionally.
 */
function authorizeRequest(req, res, next) {
  if (AUTH_MODE !== 'cf_access') return next();
  const user = req.cfUser;
  if (!user) return res.status(401).json({ message: 'Not authenticated' });
  if (user.is_admin) return next();

  const rule = matchRoute(req);
  if (!rule) return denyAccess(req, res, 'You do not have permission to access this feature.');
  if (rule.admin) return denyAccess(req, res, 'Admin access required.');
  if (rule.permissions && !hasPermission(user, ...rule.permissions)) {
    return denyAccess(req, res, 'You do not have permission to access this feature.');
  }
  return next();
}

/**
 * Where an authenticated user lands: the dashboard if they may see it,
 * otherwise the first feature they hold, or null when they hold none.
 */
function landingPath(user) {
  if (hasPermission(user, 'dashboard')) return '/dashboard';
  if (hasPermission(user, 'rag_chat')) return '/rag';
  if (hasPermission(user, 'document_chat')) return '/chat';
  if (hasPermission(user, 'manual')) return '/manual';
  if (hasPermission(user, 'playground')) return '/playground';
  if (hasPermission(user, 'rag_settings')) return '/rag/settings';
  if (hasPermission(user, 'settings')) return '/settings';
  return null;
}

module.exports = {
  AUTH_MODE,
  ADMIN_EMAILS,
  authenticateJWT,
  isAuthenticated,
  requirePermission,
  requireAdmin,
  authorizeRequest,
  hasPermission,
  landingPath,
  getCfUser,
};
