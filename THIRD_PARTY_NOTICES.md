# Third-party notices

This package is distributed under the MIT license (see `LICENSE`). It embeds
one third-party work in its generated browser bundle.

## Apache ECharts 5.6.0

- Upstream: <https://github.com/apache/echarts>
- npm package: <https://www.npmjs.com/package/echarts>
- License: Apache License, Version 2.0 (full text in `licenses/echarts-LICENSE.txt`)
- Usage: the minified ECharts `dist/echarts.min.js` distribution is embedded
  verbatim inside `client.js`, inside the `const echarts = (function () { … })();`
  block, so the browser half needs no Harness client package and no bundler at
  install time.
- The embedded copy retains ECharts' own license header. `scripts/build.mjs`
  downloads the pinned distribution from jsDelivr/unpkg (fallback) and writes it
  into the bundle without modification.

No other third-party code is bundled. `client.js` requires only `react` from the
Harness browser module table.
