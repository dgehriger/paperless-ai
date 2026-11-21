// services/thumbnailCache.js
// Where document thumbnails are cached. Deliberately outside public/: anything
// there is served by express.static before authentication, so a cached
// thumbnail must only ever be reachable through an authorized route
// (/thumb/:documentId, /api/documents/:id/thumb).
const path = require('path');

const THUMBNAIL_CACHE_DIR = path.join(process.cwd(), 'data', 'thumbnails');

/**
 * The cache file for a document's thumbnail, or null when there is no
 * Paperless document ID (text-only analysis passes none). Only numeric IDs
 * map to a file, so a caller-supplied value cannot name another path.
 */
function thumbnailPath(documentId) {
  const id = String(documentId ?? '');
  if (!/^\d+$/.test(id)) return null;
  return path.join(THUMBNAIL_CACHE_DIR, `${id}.png`);
}

module.exports = { THUMBNAIL_CACHE_DIR, thumbnailPath };
