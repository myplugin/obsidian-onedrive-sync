// Stub for elliptic — eliminates GHSA-848j-6mx2-7j84 from the dependency tree.
//
// The onedrive-vault-sync plugin authenticates against Azure AD / OneDrive,
// which uses RS256 (RSA) for JWT signing — never ECDSA/EdDSA. elliptic is
// pulled in transitively via crypto-browserify → browserify-sign + create-ecdh,
// but no elliptic function is ever called at runtime for RSA algorithms.
//
// This stub exports the API surface so `require('elliptic')` + property access
// during module initialization does not throw. The ec/eddsa constructors throw
// if actually called — which signals a real EC crypto need (install the real
// elliptic package and remove the npm override in that case).
"use strict";

function unsupported(name) {
  return function () {
    throw new Error(
      "elliptic stub: " + name + " — EC/EdDSA crypto not supported. " +
      "Install the real elliptic package and remove the npm override if needed."
    );
  };
}

module.exports = {
  version: "0.0.0-stub",
  utils: {
    assert: function () {},
    toArray: function (msg) { return Array.isArray(msg) ? msg : []; },
    toHex: function () { return ""; },
    htonl: function () { return 0; },
    zero2: function () { return ""; },
    toBytes: function () { return []; },
    getWords: function () { return []; },
  },
  rand: { rand: unsupported("rand") },
  curve: {},
  curves: {},
  ec: unsupported("ec"),
  eddsa: unsupported("eddsa"),
};
