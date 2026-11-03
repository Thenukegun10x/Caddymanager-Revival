/**
 * Minimal RFC 6902 JSON Patch for Caddy configs.
 *
 * Only the six standard operations are supported. Every result is round-tripped
 * through JSON.stringify/parse and must remain a plain object: a patch that
 * produces invalid JSON, an array, or a null document is rejected before it can
 * reach the database or a Caddy server.
 */

const crypto = require('crypto');

class PatchError extends Error {
  constructor(message, { op, path } = {}) {
    super(message);
    this.name = 'PatchError';
    this.code = 'MCP_PATCH_INVALID';
    this.op = op;
    this.path = path;
  }
}

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function parsePointer(pointer) {
  if (pointer === '') return [];
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
    throw new PatchError(`invalid JSON pointer: ${JSON.stringify(pointer)}`, { path: pointer });
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => {
      if (/~(?:[^01]|$)/.test(segment)) {
        throw new PatchError(`invalid JSON pointer escape in segment: ${segment}`, { path: pointer });
      }
      const value = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      if (FORBIDDEN_SEGMENTS.has(value)) {
        throw new PatchError(`forbidden pointer segment: ${value}`, { path: pointer });
      }
      return value;
    });
}

function isIndex(value) {
  return /^(0|[1-9][0-9]*)$/.test(value);
}

function hasOwn(node, key) {
  return Object.prototype.hasOwnProperty.call(node, key);
}

function getParent(doc, segments, { create = false } = {}) {
  let node = doc;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i];
    if (node === null || typeof node !== 'object') {
      throw new PatchError(`path does not exist: ${segments.slice(0, i + 1).join('/')}`);
    }
    if (!hasOwn(node, key)) {
      if (!create) throw new PatchError(`path does not exist: ${segments.slice(0, i + 1).join('/')}`);
      node[key] = {};
    }
    node = node[key];
  }
  return node;
}

function getValue(doc, segments) {
  let node = doc;
  for (const key of segments) {
    if (node === null || typeof node !== 'object' || !hasOwn(node, key)) {
      throw new PatchError(`path does not exist: /${segments.join('/')}`);
    }
    node = node[key];
  }
  return node;
}

function addValue(doc, segments, value) {
  if (segments.length === 0) return value;
  const parent = getParent(doc, segments, { create: false });
  const key = segments[segments.length - 1];

  if (Array.isArray(parent)) {
    if (key === '-') {
      parent.push(value);
      return doc;
    }
    if (!isIndex(key)) throw new PatchError(`invalid array index: ${key}`);
    const index = Number(key);
    if (index > parent.length) throw new PatchError(`array index out of bounds: ${key}`);
    parent.splice(index, 0, value);
    return doc;
  }

  if (parent === null || typeof parent !== 'object') {
    throw new PatchError(`cannot add to non-container at /${segments.slice(0, -1).join('/')}`);
  }
  parent[key] = value;
  return doc;
}

function removeValue(doc, segments) {
  if (segments.length === 0) throw new PatchError('cannot remove the document root');
  const parent = getParent(doc, segments);
  const key = segments[segments.length - 1];

  if (Array.isArray(parent)) {
    if (!isIndex(key)) throw new PatchError(`invalid array index: ${key}`);
    const index = Number(key);
    if (index >= parent.length) throw new PatchError(`array index out of bounds: ${key}`);
    return parent.splice(index, 1)[0];
  }

  if (parent === null || typeof parent !== 'object' || !hasOwn(parent, key)) {
    throw new PatchError(`path does not exist: /${segments.join('/')}`);
  }
  const removed = parent[key];
  delete parent[key];
  return removed;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

/**
 * Apply RFC 6902 operations to a document. Does not mutate the input.
 * @param {Object} document
 * @param {Array} operations
 * @returns {Object} patched document
 */
function applyPatch(document, operations) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new PatchError('document must be a JSON object');
  }
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new PatchError('operations must be a non-empty array');
  }
  if (operations.length > 100) {
    throw new PatchError('too many operations (max 100)');
  }

  let doc = JSON.parse(JSON.stringify(document));

  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') {
      throw new PatchError('each operation must be an object');
    }
    const { op, path } = operation;
    const segments = parsePointer(path);

    switch (op) {
      case 'add':
        if (!Object.prototype.hasOwnProperty.call(operation, 'value')) {
          throw new PatchError('add requires a value', { op, path });
        }
        doc = addValue(doc, segments, operation.value);
        break;

      case 'remove':
        removeValue(doc, segments);
        break;

      case 'replace':
        if (!Object.prototype.hasOwnProperty.call(operation, 'value')) {
          throw new PatchError('replace requires a value', { op, path });
        }
        if (segments.length === 0) {
          doc = operation.value;
        } else {
          getValue(doc, segments);
          removeValue(doc, segments);
          addValue(doc, segments, operation.value);
        }
        break;

      case 'move': {
        if (typeof operation.from !== 'string') {
          throw new PatchError('move requires a from pointer', { op, path });
        }
        const fromSegments = parsePointer(operation.from);
        const value = removeValue(doc, fromSegments);
        doc = addValue(doc, segments, value);
        break;
      }

      case 'copy': {
        if (typeof operation.from !== 'string') {
          throw new PatchError('copy requires a from pointer', { op, path });
        }
        const fromSegments = parsePointer(operation.from);
        const value = JSON.parse(JSON.stringify(getValue(doc, fromSegments)));
        doc = addValue(doc, segments, value);
        break;
      }

      case 'test': {
        const actual = getValue(doc, segments);
        if (!Object.prototype.hasOwnProperty.call(operation, 'value') || !deepEqual(actual, operation.value)) {
          throw new PatchError(`test failed at ${path}`, { op, path });
        }
        break;
      }

      default:
        throw new PatchError(`unsupported operation: ${op}`, { op, path });
    }
  }

  return assertValidConfig(doc);
}

/**
 * Validate that a patched document is still a JSON object that survives a
 * serialization round-trip. This is the "patches only apply if JSON parses"
 * gate requested for the agent surface.
 */
function assertValidConfig(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new PatchError('patched document must be a JSON object');
  }
  let roundTripped;
  try {
    roundTripped = JSON.parse(JSON.stringify(document));
  } catch {
    throw new PatchError('patched document is not valid JSON');
  }
  if (roundTripped === null || typeof roundTripped !== 'object' || Array.isArray(roundTripped)) {
    throw new PatchError('patched document must be a JSON object');
  }
  return roundTripped;
}

/** Deterministic JSON serialization (object keys sorted recursively). */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    // fromEntries creates own data properties, including a literal
    // "__proto__" key, without invoking Object.prototype's setter.
    return Object.fromEntries(Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

module.exports = {
  PatchError,
  applyPatch,
  assertValidConfig,
  canonicalize,
  digest,
  parsePointer,
};
