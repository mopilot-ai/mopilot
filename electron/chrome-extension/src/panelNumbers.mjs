// ACP form numbers keep their decimal meaning before text becomes a JavaScript number, shared by both answering surfaces.
function identity(raw) {
  const sign = raw.startsWith('-') ? '-' : '';
  const [coefficient, exponent = '0'] = raw.replace(/^-/, '').toLowerCase().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  const significant = digits.replace(/0+$/, '');
  return `${sign}${significant}e${BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - significant.length)}`;
}
export function parseAcpNumber(value) {
  const raw = String(value);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) throw new Error('Enter a valid number.');
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || identity(raw) !== identity(String(numeric))) throw new Error('Enter a number without losing precision.');
  return numeric;
}
