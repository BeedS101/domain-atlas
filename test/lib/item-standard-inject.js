// Node preload for test/item-standard-issuer.js: adds the fixture classes to issuer-server/server.js's catalog
// as the file is compiled, so the running server is the real one with extra test classes. ITEMSTD_VARIANT picks
// the fixture variant.
const Module = require('module');
const path = require('path');
const fixture = require('./item-standard-fixture');

const target = path.resolve(__dirname, '..', '..', 'issuer-server', 'server.js');
const variant = process.env.ITEMSTD_VARIANT === '2' ? 2 : 1;
const original = Module.prototype._compile;

Module.prototype._compile = function (content, filename) {
  if (path.resolve(filename) === target) {
    const anchor = "Object.assign(ASSET_CATALOG, require('./elements-catalog')(DOMAIN));";
    const restricted = "const RESTRICTED_ISSUANCE_CLASSES = new Set(['atlas.demo.studio.collectible']);";
    if (!content.includes(anchor) || !content.includes(restricted)) throw new Error('server.js no longer has the lines the item standard test injects at');
    content = content.replace(anchor, anchor + '\nObject.assign(ASSET_CATALOG, ' + fixture.nodeSnippet(variant) + ');');
    content = content.replace(restricted, "const RESTRICTED_ISSUANCE_CLASSES = new Set(['atlas.demo.studio.collectible', " +
      fixture.restrictedClasses().map((c) => JSON.stringify(c)).join(', ') + ']);');
  }
  return original.call(this, content, filename);
};
