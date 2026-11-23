// Display scalar fields from partially readable saved data without invoking an object's coercion methods.
const scalar = (value) => ['string', 'number', 'boolean'].includes(typeof value);
const displayText = (value) => (scalar(value) ? String(value) : '');
function displayNumber(value) {
  const n = scalar(value) ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
}
module.exports = { displayText, displayNumber };
