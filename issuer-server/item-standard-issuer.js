'use strict';

// Issuer-side use of the Item Standard (docs/item-standard-v0.1.md). Everything here applies only to a class
// whose catalog entry has an `itemSpec`, and to assets whose signed properties carry `atlas.item.standard`;
// every other class and asset goes through unchanged. issuer-php/lib/item-standard-issuer.php does the same.
//
// The issuer owns the standard's properties: category, slot, capability list, use count and spec digest are
// derived from the class's itemSpec and signed, and a caller cannot supply or change them. Values the
// instance chooses (stat rolls, capability parameters, colours) must lie inside the spec's ranges.
//
// A signed asset is always checked against the spec its own digest names, never against whatever the class
// declares today, so editing a class's spec later cannot widen assets issued earlier. Every spec that has
// been signed is kept by digest in the spec history for that reason.

const fs = require('fs');
const path = require('path');
const std = require('./item-standard');

const DIGEST_RE = /^[0-9a-f]{64}$/;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function has(o, k) { return isObject(o) && Object.prototype.hasOwnProperty.call(o, k); }

function specOf(entry) {
  return entry && isObject(entry.itemSpec) ? entry.itemSpec : null;
}
function hasMarker(properties) {
  return has(properties, 'atlas.item.standard');
}
// Keys the issuer derives from the spec (the rest of the standard's keys are instance values).
function isDerivedKey(key) {
  return key.startsWith('atlas.item.') || key === 'atlas.avatar.slot';
}

function mergeProperties(target, patch) {
  const result = { ...(target || {}) };
  for (const key of Object.keys(patch || {})) {
    if (patch[key] === null) delete result[key];
    else result[key] = patch[key];
  }
  return result;
}

function failure(status, code, errors, message) {
  return { ok: false, status, code, errors, message: message || code };
}
// An Error the generic handler turns into `{error, code, errors}` with the given status.
function toError(result) {
  const err = new Error(result.message);
  err.statusCode = result.status;
  err.code = result.code;
  err.errors = result.errors;
  err.itemStandard = true;
  return err;
}

// Keys a properties patch may not set. On a standard class: anything the issuer derives. On any other class:
// the standard's namespaces (`atlas.item.*`, `atlas.cap.*`), so an unrelated class cannot be made to look
// standard-conforming. A null (a deletion) is only refused for the derived keys.
function patchProblems(spec, patch) {
  const errors = [];
  if (!isObject(patch)) return errors;
  for (const key of Object.keys(patch).sort()) {
    if (spec) {
      if (isDerivedKey(key)) errors.push({ code: 'item-patch-reserved-key', key });
    } else if ((key.startsWith('atlas.item.') || key.startsWith('atlas.cap.')) && patch[key] !== null) {
      errors.push({ code: 'item-patch-reserved-key', key });
    }
  }
  return errors;
}

// Builds the property bag an issuer signs for a class with an itemSpec: the caller's properties minus any
// derived key, plus the derived properties, then validated as a whole. Classes without a spec are returned
// untouched. `opts`: model (the asset's model URL), issuerDomain.
function sealProperties(cls, entry, properties, opts) {
  const spec = specOf(entry);
  if (!spec) return { ok: true, standard: false, properties };
  const specResult = std.validateItemSpec(spec, {
    fungible: entry.fungible === true ? true : entry.fungible === false ? false : undefined,
    presentation: entry.presentation,
    classId: cls,
    issuerDomain: opts && opts.issuerDomain
  });
  if (!specResult.ok) return failure(500, 'item-spec-invalid', specResult.errors, 'this class declares an invalid itemSpec: ' + cls);
  const kept = {};
  for (const key of Object.keys(properties || {})) if (!isDerivedKey(key)) kept[key] = properties[key];
  const sealed = { ...kept, ...std.deriveItemProperties(spec) };
  const result = std.validateItemProperties(spec, sealed, { model: opts && opts.model });
  if (!result.ok) return failure(400, 'item-properties-invalid', result.errors, 'item properties do not satisfy the class itemSpec: ' + cls);
  return { ok: true, standard: true, properties: sealed, spec, digest: sealed['atlas.item.specDigest'] };
}

// The spec a signed asset is to be checked against: the class's current spec when its digest matches the
// signed one, otherwise the recorded spec with that digest. `spec` is null when the digest cannot be resolved.
function specForAsset(store, cls, entry, properties) {
  if (!hasMarker(properties)) return { standard: false };
  const digest = properties['atlas.item.specDigest'];
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) return { standard: true, spec: null, digest: null };
  const current = specOf(entry);
  if (current && std.itemSpecDigest(current) === digest) return { standard: true, spec: current, digest, current: true };
  return { standard: true, spec: store.lookup(cls, digest), digest, current: false };
}

// Checks a properties patch against an already-issued asset, for reissue and class-patch application. A
// standard asset is validated against its own signed spec; the result must still satisfy it. Other assets only
// have the standard's namespaces protected.
function checkPatchedAsset(store, asset, entry, patch) {
  const properties = (asset && asset.properties) || {};
  const info = specForAsset(store, asset.class, entry, properties);
  if (!info.standard) {
    const problems = patchProblems(null, patch);
    if (problems.length) return failure(400, 'item-patch-reserved-key', problems, 'properties in the Item Standard namespaces cannot be set on this asset');
    return { ok: true, standard: false };
  }
  if (!info.spec) {
    return failure(409, 'item-spec-unavailable', [{ code: 'item-spec-unavailable', key: 'atlas.item.specDigest' }],
      'the item spec this asset was issued under is not available, so it cannot be changed');
  }
  const problems = patchProblems(info.spec, patch);
  if (problems.length) return failure(400, 'item-patch-reserved-key', problems, 'these properties are derived from the item spec and cannot be set');
  const merged = mergeProperties(properties, patch);
  const result = std.validateItemProperties(info.spec, merged, { model: asset.model });
  if (!result.ok) return failure(400, 'item-properties-invalid', result.errors, 'the patched properties do not satisfy the asset item spec');
  return { ok: true, standard: true, properties: merged, digest: info.digest };
}

// Checks a class-wide properties patch (the stored patch with the new keys applied) against the class's
// current spec, as it would apply to a fresh item. Each holder's own signed spec is checked again when the
// patch reaches their credential.
function checkClassPatch(cls, entry, storedProperties, newProperties, opts) {
  const spec = specOf(entry);
  const problems = patchProblems(spec, newProperties);
  if (problems.length) return failure(400, 'item-patch-reserved-key', problems, 'properties in the Item Standard namespaces cannot be set by a class patch');
  if (!spec) return { ok: true, standard: false };
  const base = sealProperties(cls, entry, entry.properties || {}, opts);
  if (!base.ok) return base;
  const combined = { ...(storedProperties || {}), ...(newProperties || {}) };
  const result = std.validateItemProperties(spec, mergeProperties(base.properties, combined), { model: opts && opts.model });
  if (!result.ok) return failure(400, 'item-properties-invalid', result.errors, 'the patch does not satisfy the class itemSpec');
  return { ok: true, standard: true };
}

// A presented balance of this issuer's standard class that was issued under a spec the class no longer
// declares: re-minting it (split, consolidate, convert) would sign today's spec onto older value. Returns the
// refusal text, or null.
function supersededSpecProblem(entry, properties) {
  const current = specOf(entry);
  if (!current || !hasMarker(properties)) return null;
  if (properties['atlas.item.specDigest'] === std.itemSpecDigest(current)) return null;
  return 'this balance was issued under an earlier item spec for its class; it cannot be re-minted until the issuer reissues it';
}

// What GET /atlas/asset/class adds for a standard class.
function describeSpec(entry) {
  const spec = specOf(entry);
  if (!spec) return null;
  return { itemStandard: std.STANDARD_VERSION, itemSpec: spec, itemSpecDigest: std.itemSpecDigest(spec) };
}

// Spec history: a JSON file holding every spec this issuer has signed, per class and digest. Entries are only
// ever added.
function createSpecStore(file) {
  function read() {
    if (!fs.existsSync(file)) return { specs: {} };
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { doc = null; }
    // An unreadable history is never replaced with an empty one.
    if (!isObject(doc) || !isObject(doc.specs)) {
      const err = new Error('the item spec history is unreadable; refusing to issue standard items until it is restored');
      err.statusCode = 503;
      throw err;
    }
    return doc;
  }
  return {
    record(cls, spec) {
      const digest = std.itemSpecDigest(spec);
      const doc = read();
      if (isObject(doc.specs[cls]) && doc.specs[cls][digest]) return digest;
      doc.specs[cls] = { ...(doc.specs[cls] || {}), [digest]: { itemSpec: spec, recordedAt: new Date().toISOString() } };
      const tmp = file + '.' + process.pid + '.tmp';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
      fs.renameSync(tmp, file);
      return digest;
    },
    lookup(cls, digest) {
      if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) return null;
      const doc = read();
      const hit = isObject(doc.specs[cls]) ? doc.specs[cls][digest] : null;
      if (!hit || !isObject(hit.itemSpec)) return null;
      return std.itemSpecDigest(hit.itemSpec) === digest ? hit.itemSpec : null;
    }
  };
}

module.exports = {
  DIGEST_RE, specOf, hasMarker, isDerivedKey, patchProblems, sealProperties, specForAsset, checkPatchedAsset,
  checkClassPatch, supersededSpecProblem, describeSpec, createSpecStore, toError, mergeProperties
};
