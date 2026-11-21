// services/accessService.js
// Document-level authorization for library-restricted users (cf_access mode).
//
// A library restricts what a user may see by Paperless names: storage paths,
// tags, correspondents and document types. Retrieval enforces the scope inside
// the RAG service (see main.py, LibraryFilter); everything that hands out one
// document by its numeric ID -- previews, downloads, thumbnails, metadata,
// document chat -- checks it here, against Paperless's own view of the
// document, because the ID is caller-supplied and the Paperless credentials
// behind the proxy can read every document.

const paperlessService = require('./paperlessService');
const userModel = require('../models/userModel');
const { AUTH_MODE } = require('../middleware/cfAuth');

const NAME_MAP_TTL_MS = 5 * 60 * 1000;
const NAME_ENDPOINTS = {
  tags: '/tags/',
  correspondents: '/correspondents/',
  document_types: '/document_types/',
  storage_paths: '/storage_paths/',
};

let nameMaps = null;
let nameMapsFetchedAt = 0;
let nameMapsPending = null;

class AccessDeniedError extends Error {
  constructor(message = 'You do not have access to this document') {
    super(message);
    this.name = 'AccessDeniedError';
    this.status = 403;
  }
}

async function fetchAllNames(endpoint) {
  const map = new Map();
  let url = `${endpoint}?page_size=1000`;
  while (url) {
    const response = await paperlessService.client.get(url);
    for (const item of response.data.results || []) {
      map.set(item.id, item.name);
    }
    const next = response.data.next;
    if (!next) break;
    // `next` is absolute; the client's baseURL already carries the /api prefix.
    const parsed = new URL(next);
    url = parsed.pathname.replace(/^.*?\/api(?=\/)/, '') + parsed.search;
  }
  return map;
}

async function refreshNameMaps() {
  paperlessService.initialize();
  const entries = await Promise.all(
    Object.entries(NAME_ENDPOINTS).map(async ([key, endpoint]) => [key, await fetchAllNames(endpoint)])
  );
  nameMaps = Object.fromEntries(entries);
  nameMapsFetchedAt = Date.now();
}

/**
 * id -> name maps for tags, correspondents, document types and storage paths.
 * Refreshed every five minutes, and on demand when an ID is not in the map.
 */
async function getNameMaps(force = false) {
  if (force || !nameMaps || Date.now() - nameMapsFetchedAt > NAME_MAP_TTL_MS) {
    if (!nameMapsPending) {
      nameMapsPending = refreshNameMaps().finally(() => { nameMapsPending = null; });
    }
    await nameMapsPending;
  }
  return nameMaps;
}

function hasUnknownIds(doc, maps) {
  if (doc.storage_path && !maps.storage_paths.has(doc.storage_path)) return true;
  if (doc.correspondent && !maps.correspondents.has(doc.correspondent)) return true;
  if (doc.document_type && !maps.document_types.has(doc.document_type)) return true;
  return (doc.tags || []).some(t => !maps.tags.has(t));
}

/**
 * The names a library filter is written in, for one Paperless document.
 */
async function documentNames(doc) {
  let maps = await getNameMaps();
  if (hasUnknownIds(doc, maps)) maps = await getNameMaps(true);
  return {
    storage_path: doc.storage_path ? maps.storage_paths.get(doc.storage_path) || '' : '',
    correspondent: doc.correspondent ? maps.correspondents.get(doc.correspondent) || '' : '',
    document_type: doc.document_type ? maps.document_types.get(doc.document_type) || '' : '',
    tags: (doc.tags || []).map(t => maps.tags.get(t)).filter(Boolean),
  };
}

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Whether a document (described by names) satisfies a library scope.
 * Must agree with LibraryFilter.matches() in main.py.
 */
function matchesScope(names, scope) {
  if (!scope) return true;
  const tags = new Set((names.tags || []).map(norm));
  return scope.some(predicate => {
    if (predicate.storage_paths && !predicate.storage_paths.map(norm).includes(norm(names.storage_path))) return false;
    if (predicate.correspondents && !predicate.correspondents.map(norm).includes(norm(names.correspondent))) return false;
    if (predicate.document_types && !predicate.document_types.map(norm).includes(norm(names.document_type))) return false;
    if (predicate.tags && !predicate.tags.some(t => tags.has(norm(t)))) return false;
    return true;
  });
}

/**
 * The library scope of the request's user, or null when unrestricted
 * (local mode, admins, and users whose libraries grant everything).
 */
function getScope(req) {
  if (AUTH_MODE !== 'cf_access') return null;
  const user = req.cfUser;
  if (!user || user.is_admin) return null;
  return userModel.getLibraryScope(user.id);
}

/**
 * Throw AccessDeniedError unless the request's user may see this document.
 * Accepts a Paperless document object or an ID; returns the document when it
 * had to be fetched, so callers need not fetch it twice.
 */
async function assertDocumentAccess(req, docOrId) {
  const scope = getScope(req);
  if (!scope) return typeof docOrId === 'object' ? docOrId : null;
  const doc = typeof docOrId === 'object' ? docOrId : await paperlessService.getDocument(docOrId);
  if (!doc) throw new AccessDeniedError();
  const names = await documentNames(doc);
  if (!matchesScope(names, scope)) throw new AccessDeniedError();
  return doc;
}

/**
 * The subset of Paperless documents the request's user may see.
 */
async function filterDocuments(req, docs) {
  const scope = getScope(req);
  if (!scope) return docs;
  const visible = [];
  for (const doc of docs) {
    if (matchesScope(await documentNames(doc), scope)) visible.push(doc);
  }
  return visible;
}

module.exports = {
  AccessDeniedError,
  getScope,
  matchesScope,
  assertDocumentAccess,
  filterDocuments,
  documentNames,
};
