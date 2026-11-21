// routes/proxy.js
// Proxy routes for paperless document thumbnails, previews, and downloads.
// These allow users who don't have direct paperless access to view documents.
//
// The proxy reads with the application's own Paperless credentials, which can
// see every document, so each route checks the caller's library scope before
// it returns anything about the requested ID. The responses are private:
// a shared cache must never serve one user's document bytes to another.
const express = require('express');
const router = express.Router();
const paperlessService = require('../services/paperlessService');
const { assertDocumentAccess, AccessDeniedError } = require('../services/accessService');

const PRIVATE_CACHE = 'private, no-store';

function parseDocId(req, res) {
  const docId = parseInt(req.params.id, 10);
  if (isNaN(docId)) {
    res.status(400).json({ error: 'Invalid document ID' });
    return null;
  }
  return docId;
}

function sendError(res, error, fallback) {
  if (error instanceof AccessDeniedError) {
    return res.status(403).json({ error: error.message });
  }
  if (error.response && error.response.status === 404) {
    return res.status(404).json({ error: 'Document not found' });
  }
  return res.status(500).json({ error: fallback });
}

/**
 * GET /api/documents/:id/thumb
 * Proxy thumbnail image from paperless
 */
router.get('/:id/thumb', async (req, res) => {
  try {
    const docId = parseDocId(req, res);
    if (docId === null) return;
    await assertDocumentAccess(req, docId);

    const thumb = await paperlessService.getThumbnailImage(docId);
    if (!thumb) return res.status(404).json({ error: 'Thumbnail not found' });

    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', PRIVATE_CACHE);
    res.send(thumb);
  } catch (error) {
    console.error(`Error proxying thumbnail for ${req.params.id}:`, error.message);
    sendError(res, error, 'Failed to fetch thumbnail');
  }
});

/**
 * GET /api/documents/:id/preview
 * Proxy the document PDF for in-app viewing
 */
router.get('/:id/preview', async (req, res) => {
  try {
    const docId = parseDocId(req, res);
    if (docId === null) return;
    await assertDocumentAccess(req, docId);

    paperlessService.initialize();
    const response = await paperlessService.client.get(`/documents/${docId}/preview/`, {
      responseType: 'arraybuffer',
    });

    if (!response.data || response.data.byteLength === 0) {
      return res.status(404).json({ error: 'Document preview not available' });
    }

    const contentType = response.headers['content-type'] || 'application/pdf';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', PRIVATE_CACHE);
    res.send(Buffer.from(response.data));
  } catch (error) {
    console.error(`Error proxying preview for ${req.params.id}:`, error.message);
    sendError(res, error, 'Failed to fetch document preview');
  }
});

/**
 * GET /api/documents/:id/download
 * Proxy the original document for download
 */
router.get('/:id/download', async (req, res) => {
  try {
    const docId = parseDocId(req, res);
    if (docId === null) return;

    paperlessService.initialize();

    // Get document metadata for filename (and for the access check)
    const doc = await paperlessService.getDocument(docId);
    await assertDocumentAccess(req, doc);
    const filename = doc?.title ? `${doc.title}.pdf` : `document-${docId}.pdf`;

    const response = await paperlessService.client.get(`/documents/${docId}/download/`, {
      responseType: 'arraybuffer',
    });

    if (!response.data || response.data.byteLength === 0) {
      return res.status(404).json({ error: 'Document not available for download' });
    }

    const contentType = response.headers['content-type'] || 'application/pdf';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', PRIVATE_CACHE);
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(Buffer.from(response.data));
  } catch (error) {
    console.error(`Error proxying download for ${req.params.id}:`, error.message);
    sendError(res, error, 'Failed to download document');
  }
});

/**
 * GET /api/documents/:id/metadata
 * Get document metadata (title, date, correspondent, tags)
 */
router.get('/:id/metadata', async (req, res) => {
  try {
    const docId = parseDocId(req, res);
    if (docId === null) return;

    const doc = await paperlessService.getDocument(docId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    await assertDocumentAccess(req, doc);

    res.set('Cache-Control', PRIVATE_CACHE);
    res.json({
      id: doc.id,
      title: doc.title,
      created: doc.created,
      correspondent: doc.correspondent,
      tags: doc.tags,
      document_type: doc.document_type,
      storage_path: doc.storage_path,
    });
  } catch (error) {
    console.error(`Error fetching metadata for ${req.params.id}:`, error.message);
    sendError(res, error, 'Failed to fetch document metadata');
  }
});

module.exports = router;
