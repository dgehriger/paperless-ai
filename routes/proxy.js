// routes/proxy.js
// Proxy routes for paperless document thumbnails, previews, and downloads.
// These allow users who don't have direct paperless access to view documents.
const express = require('express');
const router = express.Router();
const paperlessService = require('../services/paperlessService');

/**
 * GET /api/documents/:id/thumb
 * Proxy thumbnail image from paperless
 */
router.get('/:id/thumb', async (req, res) => {
  try {
    const docId = parseInt(req.params.id, 10);
    if (isNaN(docId)) return res.status(400).json({ error: 'Invalid document ID' });

    const thumb = await paperlessService.getThumbnailImage(docId);
    if (!thumb) return res.status(404).json({ error: 'Thumbnail not found' });

    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(thumb);
  } catch (error) {
    console.error(`Error proxying thumbnail for ${req.params.id}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch thumbnail' });
  }
});

/**
 * GET /api/documents/:id/preview
 * Proxy the document PDF for in-app viewing
 */
router.get('/:id/preview', async (req, res) => {
  try {
    const docId = parseInt(req.params.id, 10);
    if (isNaN(docId)) return res.status(400).json({ error: 'Invalid document ID' });

    paperlessService.initialize();
    const response = await paperlessService.client.get(`/documents/${docId}/preview/`, {
      responseType: 'arraybuffer',
    });

    if (!response.data || response.data.byteLength === 0) {
      return res.status(404).json({ error: 'Document preview not available' });
    }

    const contentType = response.headers['content-type'] || 'application/pdf';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(Buffer.from(response.data));
  } catch (error) {
    console.error(`Error proxying preview for ${req.params.id}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch document preview' });
  }
});

/**
 * GET /api/documents/:id/download
 * Proxy the original document for download
 */
router.get('/:id/download', async (req, res) => {
  try {
    const docId = parseInt(req.params.id, 10);
    if (isNaN(docId)) return res.status(400).json({ error: 'Invalid document ID' });

    paperlessService.initialize();

    // Get document metadata for filename
    const doc = await paperlessService.getDocument(docId);
    const filename = doc?.title ? `${doc.title}.pdf` : `document-${docId}.pdf`;

    const response = await paperlessService.client.get(`/documents/${docId}/download/`, {
      responseType: 'arraybuffer',
    });

    if (!response.data || response.data.byteLength === 0) {
      return res.status(404).json({ error: 'Document not available for download' });
    }

    const contentType = response.headers['content-type'] || 'application/pdf';
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(Buffer.from(response.data));
  } catch (error) {
    console.error(`Error proxying download for ${req.params.id}:`, error.message);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

/**
 * GET /api/documents/:id/metadata
 * Get document metadata (title, date, correspondent, tags)
 */
router.get('/:id/metadata', async (req, res) => {
  try {
    const docId = parseInt(req.params.id, 10);
    if (isNaN(docId)) return res.status(400).json({ error: 'Invalid document ID' });

    const doc = await paperlessService.getDocument(docId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

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
    res.status(500).json({ error: 'Failed to fetch document metadata' });
  }
});

module.exports = router;
