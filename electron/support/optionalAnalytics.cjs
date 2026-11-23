// Load the physically optional private service; a missing module or broken extension leaves OSS behavior inert.
function optionalAnalytics(name, fallback, load = require) {
  try {
    return load(`../private/analytics/${name}.cjs`);
  } catch {
    return fallback;
  }
}
module.exports = { optionalAnalytics };
