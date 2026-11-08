/* Plain-text display fallback for common model-generated fraction notation.
 * This does not evaluate mathematics and never produces HTML. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.formatTutorMath = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function grouped(value) {
    var s = value.trim();
    return /^[+-]?(?:\d+(?:\.\d+)?|[a-zA-Z])$/.test(s) ? s : '(' + s + ')';
  }
  return function formatTutorMath(value) {
    var text = String(value == null ? '' : value);
    // Strip dollar delimiters only around recognizable fraction markup;
    // ordinary currency such as "$5 and $6" stays untouched.
    function fractionDelimited(match, body) {
      return /\\(?:d|t)?frac\s*\{[^{}]{1,120}\}\s*\{[^{}]{1,120}\}/.test(body) ? body : match;
    }
    text = text.replace(/\$\$([^$\n]+)\$\$/g, fractionDelimited).replace(/\$([^$\n]+)\$/g, fractionDelimited);
    // Convert innermost simple fractions first, bounded for malformed input.
    for (var i = 0; i < 5; i++) {
      var next = text.replace(/\\(?:d|t)?frac\s*\{([^{}]{1,120})\}\s*\{([^{}]{1,120})\}/g,
        function (_, numerator, denominator) { return '(' + grouped(numerator) + '/' + grouped(denominator) + ')'; });
      if (next === text) break;
      text = next;
    }
    return text.replace(/\\\(([\s\S]*?)\\\)/g, '$1').replace(/\\\[([\s\S]*?)\\\]/g, '$1');
  };
});
