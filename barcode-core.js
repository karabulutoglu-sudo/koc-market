(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KocBarcode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalize(value) {
    if (value == null) return '';
    return String(value).trim().replace(/[\u200B-\u200F\uFEFF\s]/g, '');
  }

  function isTerminator(key) {
    return key === 'Enter' || key === 'Tab';
  }

  function isAppendableKey(key) {
    return typeof key === 'string' && key.length === 1 && /[\w\d*xX×]/.test(key);
  }

  return { normalize, isTerminator, isAppendableKey };
});
