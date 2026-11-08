'use strict';
function sameDesktopState(a, b) {
  return !!a && !!b && a.text === b.text && a.savedText === b.savedText && a.filename === b.filename && a.dirty === b.dirty && !!a.composing === !!b.composing;
}
module.exports = { sameDesktopState };
