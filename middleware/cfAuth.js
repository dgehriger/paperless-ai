// middleware/cfAuth.js
// Dual-mode authentication middleware: 'local' (legacy JWT) or 'cf_access' (Cloudflare tunnel)

const jwt = require('jsonwebtoken');
const userModel = require('../models/userModel');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const AUTH_MODE = (process.env.AUTH_MODE || 'local').toLowerCase();
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(e => e.length > 0);
const DEV_USER_EMAIL = process.env.DEV_USER_EMAIL || '';

const CF_ACCESS_EMAIL_HEADER = 'cf-access-authenticated-user-email';

/**
 * Get the authenticated user email from CF Access headers (or dev bypass)
 */
function getCfAccessEmail(req) {
  const cfEmail = req.headers[CF_ACCESS_EMAIL_HEADER];
  if (cfEmail) return cfEmail;

  // Development bypass
  if (process.env.NODE_ENV !== 'production' && DEV_USER_EMAIL) {
    return DEV_USER_EMAIL;
  }

  return null;
}

/**
 * Resolve the current user in CF Access mode. Returns user object or null.
 */
function getCfUser(req) {
  const email = getCfAccessEmail(req);
  if (!email) return null;
  return userModel.findOrCreateUser(email, ADMIN_EMAILS);
}

/**
 * Core auth middleware for API routes (returns 401 JSON).
 * In local mode: checks JWT/API key (original behavior).
 * In cf_access mode: checks CF header, requires approved user.
 */
function authenticateJWT(req, res, next) {
  if (AUTH_MODE === 'cf_access') {
    const user = getCfUser(req);
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
  } catch (error) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
}

/**
 * Page auth middleware (redirects to login). 
 * In cf_access mode, redirects to pending page if not approved.
 */
function isAuthenticated(req, res, next) {
  if (AUTH_MODE === 'cf_access') {
    const user = getCfUser(req);
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
  } catch (error) {
    res.clearCookie('jwt');
    return res.redirect('/login');
  }
}

/**
 * Require a specific permission. Must be called after isAuthenticated/authenticateJWT.
 * In local mode, all permissions are granted (single-user system).
 */
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (AUTH_MODE !== 'cf_access') return next(); // local mode = full access

    const user = req.cfUser;
    if (!user) return res.status(401).json({ message: 'Not authenticated' });
    if (user.is_admin) return next(); // admins have all permissions

    const userPerms = user.permissions || [];
    const hasAny = permissions.some(p => userPerms.includes(p));
    if (!hasAny) {
      // For page requests, redirect. For API, return 403.
      if (req.accepts('html')) {
        return res.status(403).render('error', {
          title: 'Access Denied',
          message: 'You do not have permission to access this feature.',
        });
      }
      return res.status(403).json({ message: 'Insufficient permissions' });
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
    if (req.accepts('html')) {
      return res.status(403).render('error', {
        title: 'Access Denied',
        message: 'Admin access required.',
      });
    }
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
}

module.exports = {
  AUTH_MODE,
  ADMIN_EMAILS,
  authenticateJWT,
  isAuthenticated,
  requirePermission,
  requireAdmin,
  getCfUser,
};
