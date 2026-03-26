// routes/admin.js
// Admin routes for user management, library management, and system admin
const express = require('express');
const router = express.Router();
const userModel = require('../models/userModel');
const { requireAdmin, AUTH_MODE } = require('../middleware/cfAuth');

// All admin routes require admin role
router.use(requireAdmin);

// ============================================================================
// Users
// ============================================================================

/**
 * List all users
 */
router.get('/users', (req, res) => {
  const users = userModel.listUsers();
  const libraries = userModel.listLibraries();
  res.json({ users, allPermissions: userModel.ALL_PERMISSIONS, libraries });
});

/**
 * Approve / revoke a user
 */
router.put('/users/:id/approve', (req, res) => {
  const { approved } = req.body;
  const user = userModel.approveUser(req.params.id, approved !== false);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

/**
 * Update user permissions
 */
router.put('/users/:id/permissions', (req, res) => {
  const { permissions } = req.body;
  if (!Array.isArray(permissions)) {
    return res.status(400).json({ error: 'permissions must be an array' });
  }
  // Validate permission names
  const valid = permissions.filter(p => userModel.ALL_PERMISSIONS.includes(p));
  const user = userModel.setUserPermissions(req.params.id, valid);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

/**
 * Update user admin status
 */
router.put('/users/:id/admin', (req, res) => {
  const { isAdmin } = req.body;
  const user = userModel.setUserAdmin(req.params.id, !!isAdmin);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

/**
 * Set user library assignments
 */
router.put('/users/:id/libraries', (req, res) => {
  const { libraryIds } = req.body;
  if (!Array.isArray(libraryIds)) {
    return res.status(400).json({ error: 'libraryIds must be an array' });
  }
  userModel.setUserLibraries(req.params.id, libraryIds);
  const libs = userModel.getUserLibraries(req.params.id);
  res.json({ libraries: libs });
});

/**
 * Pre-register a new user (before their first CF Access login)
 */
router.post('/users', (req, res) => {
  const { email, permissions, libraryIds, isAdmin } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }
  const normalizedEmail = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  // Check for duplicates
  const existing = userModel.getUserByEmail(normalizedEmail);
  if (existing) {
    return res.status(409).json({ error: 'A user with this email already exists' });
  }

  const user = userModel.preRegisterUser(normalizedEmail, {
    permissions: Array.isArray(permissions) ? permissions.filter(p => userModel.ALL_PERMISSIONS.includes(p)) : ['rag_chat', 'history'],
    isAdmin: !!isAdmin,
    isApproved: true,   // pre-registered users are approved by default
  });

  // Assign libraries if provided
  if (Array.isArray(libraryIds) && libraryIds.length > 0) {
    userModel.setUserLibraries(user.id, libraryIds);
  }

  res.json(user);
});

/**
 * Delete a user
 */
router.delete('/users/:id', (req, res) => {
  userModel.deleteUser(req.params.id);
  res.json({ success: true });
});

// ============================================================================
// Libraries
// ============================================================================

/**
 * List all libraries
 */
router.get('/libraries', (req, res) => {
  res.json(userModel.listLibraries());
});

/**
 * Create a library
 */
router.post('/libraries', (req, res) => {
  const { name, description, filters } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const lib = userModel.createLibrary(name, description, filters || {});
  res.json(lib);
});

/**
 * Update a library
 */
router.put('/libraries/:id', (req, res) => {
  const { name, description, filters } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const lib = userModel.updateLibrary(req.params.id, name, description, filters || {});
  if (!lib) return res.status(404).json({ error: 'Library not found' });
  res.json(lib);
});

/**
 * Delete a library
 */
router.delete('/libraries/:id', (req, res) => {
  userModel.deleteLibrary(req.params.id);
  res.json({ success: true });
});

module.exports = router;
