# Nest webpack minimatch compatibility

`fork-ts-checker-webpack-plugin@9.1.0` calls the CommonJS minimatch export as a
function in its issue filters and watch ignore filters. minimatch 11 instead
exports an object. This adapter returns its `minimatch` function, including the
helpers attached by upstream; it contains no matching implementation.

The root override targets only this consumer. Other consumers use minimatch 11
directly. npm resolves the file override relative to the consuming package at
`node_modules/fork-ts-checker-webpack-plugin`, hence `../../tools/minimatch-compat`.
Keep this directory in both Docker dependency installation stages. Remove the
adapter when the plugin supports the modern export.

This private package is repository source, reviewed and shipped with the Git
commit, not a downloaded tarball. npm therefore records neither a registry URL
nor a tarball integrity hash for `tools/minimatch-compat`. The supply-chain guard
checks its exact local metadata separately; its external minimatch dependency
still requires the official registry URL and integrity hash.

Security fixes: glob >=14.0.2 (GHSA-3g3m-2fjr-6pw4), minimatch >=11.0.1
(GHSA-g3hv-75wg-m249). The override floors select subsequent patch releases.
