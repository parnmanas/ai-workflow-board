// fork-ts-checker-webpack-plugin 9 calls require('minimatch') as a function.
// Keep that API while delegating all matching to the patched implementation.
module.exports = require('minimatch').minimatch;
