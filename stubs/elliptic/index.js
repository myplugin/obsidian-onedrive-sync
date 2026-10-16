function unsupported(name) {
  return () => {
    throw new Error(
      "elliptic stub: " +
        name +
        " — EC/EdDSA crypto not supported. " +
        "Install the real elliptic package and remove the npm override if needed."
    );
  };
}

module.exports = {
  version: "0.0.0-stub",
  utils: {
    assert: () => {},
    toArray: (msg) => (Array.isArray(msg) ? msg : []),
    toHex: () => "",
    htonl: () => 0,
    zero2: () => "",
    toBytes: () => [],
    getWords: () => [],
  },
  rand: { rand: unsupported("rand") },
  curve: {},
  curves: {},
  ec: unsupported("ec"),
  eddsa: unsupported("eddsa"),
};
