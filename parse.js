// Single-pass CommonMark 0.31.2 + GFM 0.29 renderer, byte-identical to marked 18.1.3
// (default options). Written from scratch; marked is only a whole-case fallback.
import { marked } from './vendor/marked/marked.esm.js';

export const stats = { bailCases: 0, bailChars: 0 };
class Bail extends Error {}

// ---------- char helpers (charCodeAt based, no regex on hot paths) ----------
const CC = (s, i) => s.charCodeAt(i);
const isSpace = c => c === 32 || c === 9;
const isDigit = c => c >= 48 && c <= 57;
const isAlpha = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAlnum = c => isAlpha(c) || isDigit(c);
const isPunct = c =>
  (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
const isWord = c => isAlnum(c) || c === 95; // [A-Za-z0-9_]
const isWhite = c => c === 32 || c === 9 || c === 10 || c === 13;

// ASCII percent-encode table for hrefs: 1 = safe (keep), 0 = encode.
// Safe: A-Z a-z 0-9 - . _ ~ : / ? # @ ! $ & ' ( ) * + , ; = %
const HREF_SAFE = new Uint8Array(128);
for (let i = 0; i < 128; i++) {
  const c = String.fromCharCode(i);
  HREF_SAFE[i] = /[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]/.test(c) ? 1 : 0;
}
const HEX = '0123456789ABCDEF';

// Percent-encode a URL, then HTML-escape it (entity-aware: &word; / &#n; / &#x..; kept).
export function encodeHref(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) {
      if (HREF_SAFE[c]) { out += s[i]; continue; }
      out += '%' + HEX[(c >> 4) & 15] + HEX[c & 15];
    } else {
      let j = i;
      while (j < s.length && s.charCodeAt(j) >= 128) j++;
      out += encodeURIComponent(s.slice(i, j));
      i = j - 1;
    }
  }
  return escAttr(out);
}

// HTML-escape for attributes / titles / alt: & (unless &word; / &#n; / &#x..;), < > " '
export function escAttr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      const e = entityAt(s, i);
      if (e) { out += e.raw; i += e.len - 1; continue; }
      out += '&amp;';
    } else if (c === 60) out += '&lt;';
    else if (c === 62) out += '&gt;';
    else if (c === 34) out += '&quot;';
    else if (c === 39) out += '&#39;';
    else out += s[i];
  }
  return out;
}

// Code-span / code-block escaping: & always escaped, < > " '
export function escCode(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) out += '&amp;';
    else if (c === 60) out += '&lt;';
    else if (c === 62) out += '&gt;';
    else if (c === 34) out += '&quot;';
    else if (c === 39) out += '&#39;';
    else out += s[i];
  }
  return out;
}

// Entity at s[i] (s[i] === '&'): numeric refs decode, named &word; passes through.
// Returns {len, raw} (raw = decoded char for numeric, raw entity text for named) or null.
export function entityAt(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? ((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)) : (c >= 48 && c <= 57)) j++;
      else break;
    }
    if (j === start || j >= n || s[j] !== ';') return null;
    if ((!hex && j - start > 7) || (hex && j - start > 6)) return null;
    let cp = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return { len: j - i + 1, raw: String.fromCodePoint(cp) };
  }
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === 95) j++;
    else break;
  }
  if (j === i + 1 || j >= n || s[j] !== ';') return null;
  return { len: j - i + 1, raw: s.slice(i, j + 1) };
}

// Split source into lines (no terminators). Handles \n, \r\n, \r.
export function splitLines(src) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 10) { lines.push(src.slice(start, i)); start = i + 1; }
    else if (c === 13) {
      lines.push(src.slice(start, i));
      start = (i + 1 < src.length && src.charCodeAt(i + 1) === 10) ? i + 2 : i + 1;
      i = start - 1;
    }
  }
  if (start < src.length) lines.push(src.slice(start));
  else if (src.length === 0) lines.push('');
  return lines;
}

// Measure leading indent of line from index `from`: returns {col, idx} with tabs = next multiple of 4.
export function measureIndent(line, from) {
  let col = 0, i = from;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col & 3); i++; }
    else break;
  }
  return { col, idx: i };
}

// Strip up to nCols of indent from line (from index `from`, which sits at column
// `startCol`). Leading whitespace is expanded to spaces by ORIGINAL columns
// first, so a tab after a straddling tab keeps its width (tabs are not
// re-measured after partial stripping).
export function stripIndent(line, from, nCols, startCol) {
  const base = startCol || 0;
  if (nCols <= 0) return line.slice(from);
  let ws = '', j = from, col = base;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c === 32) { ws += ' '; col++; j++; }
    else if (c === 9) { const w = 4 - (col & 3); ws += ' '.repeat(w); col += w; j++; }
    else break;
  }
  const target = base + nCols;
  if (col <= target) return line.slice(j);
  return ws.slice(ws.length - (col - target)) + line.slice(j);
}

// Trim ASCII spaces/tabs at both ends of a string.
export function trimSpace(s) {
  let a = 0, b = s.length;
  while (a < b && isSpace(s.charCodeAt(a))) a++;
  while (b > a && isSpace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

// Normalize a reference label: collapse internal whitespace to one space, trim, lowercase.
export function normLabel(s) {
  let out = '', lastSpace = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) { if (!lastSpace) { out += ' '; lastSpace = true; } }
    else {
      // full case folding: ß/ẞ fold to ss, final sigma ς folds to σ
      // (JS toLowerCase does neither)
      const low = s[i].toLowerCase();
      if (low === 'ß') out += 'ss';
      else if (low === 'ς') out += 'σ';
      else out += low;
      lastSpace = false;
    }
  }
  if (out.endsWith(' ')) out = out.slice(0, -1);
  return out;
}

// Resolve backslash escapes in a string (only before ASCII punctuation; \n is kept as \n).
export function unescape(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isPunct(s.charCodeAt(i + 1))) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// Parse a link reference definition starting at lines[i] (already stripped of container
// prefixes). Returns {n, label, dest, title} (n = lines consumed, 1 or 2) or null.
// Form: [label]: <dest> | dest [ "title" | 'title' | (title) ]  (title may be on next line)
export function tryRefDef(lines, i, refs) {
  const line = lines[i];
  const m0 = measureIndent(line, 0);
  if (m0.col > 3) return null;
  let p = m0.idx;
  if (p >= line.length || line.charCodeAt(p) !== 91) return null; // [
  // scan label: [ ... ] with escapes, no unescaped ] or [; may span lines
  // (no blank line inside). Backslashes are KEPT in the label: label
  // matching compares raw text (foo\! matches foo\!, not foo!)
  let q = p + 1, label = '';
  let labLi = i, labLine = line, closed = false;
  while (true) {
    while (q < labLine.length) {
      const c = labLine.charCodeAt(q);
      if (c === 92 && q + 1 < labLine.length && isPunct(labLine.charCodeAt(q + 1))) { label += labLine[q] + labLine[q + 1]; q += 2; continue; }
      if (c === 91) return null;
      if (c === 93) { closed = true; break; }
      label += labLine[q]; q++;
    }
    if (closed) break;
    if (labLi + 1 >= lines.length) return null;
    const nextLine = lines[labLi + 1];
    if (isBlank(nextLine)) return null;
    label += '\n';
    labLi++; labLine = nextLine; q = 0;
  }
  if (!closed) return null;
  if (label.length === 0 || label.length > 999) return null;
  q++;
  if (q >= labLine.length || labLine.charCodeAt(q) !== 58) return null; // :
  q++;
  // skip spaces/tabs, possibly to next line
  let li = labLi, line2 = labLine;
  const skipWs = () => {
    while (true) {
      while (q < line2.length && isSpace(line2.charCodeAt(q))) q++;
      if (q < line2.length) return true;
      if (li + 1 < lines.length && li === labLi) { li++; line2 = lines[li]; q = 0; continue; }
      return false;
    }
  };
  if (!skipWs()) return null;
  // destination: <...> or bare
  let dest = '';
  let hasDest = false;
  if (line2.charCodeAt(q) === 60) { // <
    const start = q + 1;
    let r = start;
    while (r < line2.length && line2.charCodeAt(r) !== 62 && line2.charCodeAt(r) !== 10) {
      if (line2.charCodeAt(r) === 92 && r + 1 < line2.length && isPunct(line2.charCodeAt(r + 1))) r += 2;
      else r++;
    }
    if (r >= line2.length || line2.charCodeAt(r) !== 62) return null;
    dest = unescape(line2.slice(start, r));
    hasDest = true;
    q = r + 1;
  } else {
    // bare destination: no spaces/control, balanced parens, escapes allowed
    let depth = 0, r = q;
    while (r < line2.length) {
      const c = line2.charCodeAt(r);
      if (c === 92 && r + 1 < line2.length && isPunct(line2.charCodeAt(r + 1))) { r += 2; continue; }
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 40) depth++;
      else if (c === 41) { if (depth === 0) break; depth--; }
      r++;
    }
    if (r === q) {
      // no destination; maybe a title alone counts as a definition (marked: `[a]: "t"` consumed)
      dest = '';
    } else {
      dest = unescape(line2.slice(q, r));
      hasDest = true;
      q = r;
    }
  }
  // optional title on same line or next line (no blank line between)
  let title = null;
  let saveQ = q, saveLi = li, saveLine = line2;
  const skipWs2 = () => {
    while (true) {
      while (q < line2.length && isSpace(line2.charCodeAt(q))) q++;
      if (q < line2.length) return true;
      if (li + 1 < lines.length && li === saveLi) { li++; line2 = lines[li]; q = 0; continue; }
      return false;
    }
  };
  const preTitleQ = q, preTitleLi = li;
  if (skipWs2() && (q !== preTitleQ || li !== preTitleLi)) {
    // a title must be separated from the destination by whitespace or a
    // line break; without separation it is not a title
    const c = line2.charCodeAt(q);
    let close = -1;
    if (c === 34 || c === 39) close = c;
    else if (c === 40) close = 41;
    if (close > 0) {
      // title may span lines (no blank line inside); an unescaped '('
      // inside a '(' title invalidates it
      let r = q + 1, t = '';
      let curLi = li, curLine = line2, found = false, badParen = false;
      while (true) {
        while (r < curLine.length) {
          const ch = curLine.charCodeAt(r);
          if (ch === 92 && r + 1 < curLine.length && isPunct(curLine.charCodeAt(r + 1))) { t += curLine[r + 1]; r += 2; continue; }
          if (close === 41 && ch === 40) { badParen = true; break; }
          if (ch === close) { found = true; break; }
          t += curLine[r]; r++;
        }
        if (found || badParen) break;
        if (curLi + 1 >= lines.length) break;
        const nextLine = lines[curLi + 1];
        if (isBlank(nextLine)) break;
        t += '\n';
        curLi++; curLine = nextLine; r = 0;
      }
      if (found && !badParen) {
        title = t;
        li = curLi; line2 = curLine; q = r + 1;
        // rest of the closing line must be blank
        let ok = true;
        while (q < line2.length) { if (!isSpace(line2.charCodeAt(q))) { ok = false; break; } q++; }
        if (!ok) { q = saveQ; li = saveLi; line2 = saveLine; title = null; }
      }
    }
  }
  if (title === null) {
    // no title: rest of the destination line must be blank
    q = saveQ; li = saveLi; line2 = saveLine;
    let ok = true;
    let r = q;
    while (r < line2.length) { if (!isSpace(line2.charCodeAt(r))) { ok = false; break; } r++; }
    if (!ok) return null;
  }
  if (!hasDest && title === null) return null;
  const key = normLabel(label);
  if (key.length === 0) return null;
  const n = li - i + 1;
  if (!refs.has(key)) refs.set(key, { dest, title });
  return { n, label: key, dest, title };
}

// ============================================================
// Chunk 2 — block parser (two-pass: block tree + ref defs)
// ============================================================

const BLOCK_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul'.split(' '));

export function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

// ATX heading: returns {level, text} or null. `m` is measureIndent(line).
export function atxInfo(line, m) {
  if (m.col > 3) return null;
  let i = m.idx, n = 0;
  while (i < line.length && line.charCodeAt(i) === 35 && n < 7) { i++; n++; }
  if (n === 0 || n > 6) return null;
  if (i < line.length) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return null; }
  let s = line.slice(i);
  // trim trailing spaces; a trailing run of #'s preceded by space/tab is a
  // closing sequence (even when it is the whole content, e.g. '### ###')
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  let t = b;
  while (t > 0 && s.charCodeAt(t - 1) === 35) t--;
  if (t < b && (t === 0 || s.charCodeAt(t - 1) === 32 || s.charCodeAt(t - 1) === 9)) {
    b = t;
    while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  }
  let a = 0;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  return { level: n, text: s.slice(a, b) };
}

// Thematic break?
export function isHr(line, m) {
  if (m.col > 3) return null;
  let i = m.idx, ch = 0, n = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (c === 42 || c === 45 || c === 95) {
      if (ch === 0) ch = c; else if (c !== ch) return false;
      n++; i++; continue;
    }
    return false;
  }
  return n >= 3;
}

// Setext underline: 1 for =, 2 for -, else 0. Only leading/trailing
// whitespace is allowed (no spaces between the = / - characters).
export function setextInfo(line) {
  const m = measureIndent(line, 0);
  if (m.col > 3) return 0;
  let i = m.idx;
  if (i >= line.length) return 0;
  const ch = line.charCodeAt(i);
  if (ch !== 61 && ch !== 45) return 0;
  let n = 0;
  while (i < line.length && line.charCodeAt(i) === ch) { n++; i++; }
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i !== line.length) return 0;
  return ch === 61 ? 1 : 2;
}

// Fenced code start: {char, len, info, indent} or null.
export function fenceInfo(line, m) {
  if (m.col > 3) return null;
  let i = m.idx;
  const c = line.charCodeAt(i);
  if (c !== 96 && c !== 126) return null;
  let n = 0;
  while (i < line.length && line.charCodeAt(i) === c) { i++; n++; }
  if (n < 3) return null;
  let s = line.slice(i);
  let a = 0; while (a < s.length && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  let b = s.length;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  const info = s.slice(a, b);
  if (c === 96 && info.indexOf('`') !== -1) return null;
  return { char: c, len: n, info, indent: m.col };
}

// HTML block start: {kind: 1..7, close: string|null, closeTag: string|null} or null.
// kind 1: pre/script/style/textarea (ends at close tag)
// kind 2: <!-- (ends at -->)
// kind 3: <? (ends at ?>)
// kind 4: <!letter (ends at first >)
// kind 5: <![CDATA[ (ends at ]]>)
// kind 6: known block tag line, or tag-alone line (ends at blank line)
export function htmlStart(line, m) {
  if (m.col > 3) return null;
  const rest = line.slice(m.idx);
  if (rest.charCodeAt(0) !== 60) return null;
  const s2 = rest.slice(1);
  if (s2.startsWith('!--')) return { kind: 2, close: '-->' };
  if (s2.startsWith('?')) return { kind: 3, close: '?>' };
  if (s2.startsWith('![CDATA[')) return { kind: 5, close: ']]>' };
  if (s2.length > 1 && s2.charCodeAt(0) === 33) {
    const c = s2.charCodeAt(1);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return { kind: 4, close: '>' };
  }
  // tag name
  let i = 0, closeTag = false;
  if (s2.charCodeAt(0) === 47) { closeTag = true; i = 1; }
  let j = i;
  while (j < s2.length) {
    const c = s2.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (j === i) return null;
  const name = s2.slice(i, j).toLowerCase();
  if (!closeTag && (name === 'pre' || name === 'script' || name === 'style' || name === 'textarea')) {
    // must be followed by space/tab/>/EOL
    const nx = s2.charCodeAt(j);
    if (j >= s2.length || nx === 32 || nx === 9 || nx === 62 || nx === 47) return { kind: 1, closeTag: name };
    return null;
  }
  if (BLOCK_TAGS.has(name)) return { kind: 6, close: null };
  // unknown tag: only a lone (valid) tag line is a block (kind 7: cannot
  // interrupt a paragraph)
  const te = scanTag(rest, 0);
  if (te > 0) {
    let k = te;
    while (k < rest.length && isWhite(rest.charCodeAt(k))) k++;
    if (k === rest.length) return { kind: 7, close: null };
  }
  return null;
}

// List marker: {ordered, num, delim, bullet, markerLen, contentIndent, empty} or null.
export function listMarker(line, m) {
  if (m.col > 3) return null;
  let i = m.idx;
  const c = line.charCodeAt(i);
  let ordered = false, num = 0, delim = '', bullet = '';
  if (c === 45 || c === 43 || c === 42) { bullet = line[i]; i++; }
  else if (c >= 48 && c <= 57) {
    let j = i, n = 0;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57 && j - i < 9) { n = n * 10 + (line.charCodeAt(j) - 48); j++; }
    if (j === i || j - i > 9) return null;
    const d = line.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    ordered = true; num = n; delim = line[j]; i = j + 1;
  } else return null;
  // after marker: need space/tab/EOL
  if (i >= line.length) return { ordered, num, delim, bullet, markerLen: i - m.idx, contentIndent: m.col + (i - m.idx) + 1, empty: true };
  const nc = line.charCodeAt(i);
  if (nc !== 32 && nc !== 9) return null;
  // measure columns from marker start
  let col = m.col + (i - m.idx), k = i, spaces = 0;
  while (k < line.length) {
    const cc = line.charCodeAt(k);
    if (cc === 32) { col++; k++; spaces++; }
    else if (cc === 9) { const w = 4 - (col & 3); col += w; k++; spaces += w; }
    else break;
  }
  if (k >= line.length) return { ordered, num, delim, bullet, markerLen: i - m.idx, contentIndent: m.col + (i - m.idx) + 1, empty: true };
  if (spaces > 4) return { ordered, num, delim, bullet, markerLen: i - m.idx, contentIndent: m.col + (i - m.idx) + 1, empty: false };
  return { ordered, num, delim, bullet, markerLen: i - m.idx, contentIndent: col, empty: false };
}

// Split a table line into cells (handles \| escapes). Leading/trailing pipes stripped.
export function splitCells(line) {
  let s = line, a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  if (a < b && s.charCodeAt(a) === 124) a++;
  if (b > a && s.charCodeAt(b - 1) === 124) {
    // trailing pipe is a separator only if not escaped
    let bs = 0, k = b - 2;
    while (k >= a && s.charCodeAt(k) === 92) { bs++; k--; }
    if (bs % 2 === 0) b--;
  }
  const cells = [];
  let cur = '', i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < b) {
      if (s.charCodeAt(i + 1) === 124) { cur += '|'; i += 2; continue; }
      cur += s[i] + s[i + 1]; i += 2; continue;
    }
    if (c === 124) { cells.push(trimSpace(cur)); cur = ''; i++; continue; }
    cur += s[i]; i++;
  }
  cells.push(trimSpace(cur));
  return cells;
}

// Table delimiter row: returns {align: [null|'l'|'r'|'c', ...]} or null.
export function tableDelim(line) {
  if (measureIndent(line, 0).col > 3) return null;
  const cells = splitCells(line);
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    let a = cell, l = false, r = false;
    if (a.charCodeAt(0) === 58) { l = true; a = a.slice(1); }
    if (a.length > 0 && a.charCodeAt(a.length - 1) === 58) { r = true; a = a.slice(0, -1); }
    if (a.length === 0) return null;
    for (let i = 0; i < a.length; i++) if (a.charCodeAt(i) !== 45) return null;
    align.push(l && r ? 'c' : l ? 'l' : r ? 'r' : null);
  }
  return { align };
}

// A line that is a pure '---' setext underline (ambiguous with 1-col table delimiter).
export function isPureSetextDash(line) {
  const m = measureIndent(line, 0);
  if (m.col > 3) return false;
  let i = m.idx, n = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (c === 45) { n++; i++; continue; }
    return false;
  }
  return n >= 1;
}

// Does `line` start a leaf block that interrupts a paragraph? (ATX, fence, HR,
// HTML 1-6, blockquote, interrupting list marker, table.) `next` is the following
// line (or null) for the table lookahead.
export function interruptsParagraph(line, next, inItem) {
  const m = measureIndent(line, 0);
  if (m.col > 3) return false;
  const idx = m.idx, c = line.charCodeAt(idx);
  if (c === 35 && atxInfo(line, m)) return true;
  if (c === 96 || c === 126) { if (fenceInfo(line, m)) return true; }
  if ((c === 42 || c === 45 || c === 95) && isHr(line, m)) return true;
  if (c === 60) { const h = htmlStart(line, m); if (h && h.kind !== 7) return true; }
  if (c === 62) return true;
  if (c === 45 || c === 43 || c === 42 || (c >= 48 && c <= 57)) {
    const lm = listMarker(line, m);
    if (lm && !lm.empty) {
      if (!lm.ordered) return true;
      // inside a list item a sub-list interrupts the item's paragraph
      // regardless of its start number; elsewhere an ordered list needs 1
      if (lm.num === 1 || inItem) return true;
    }
  }
  if (next !== null && next !== undefined && tableDelim(next) && !isPureSetextDash(next)) return true;
  return false;
}

// ---------- container state machine ----------
// Tracks whether a paragraph is open inside a container's stripped lines, so
// lazy continuation lines can be recognised. `st` = {para, fence, html}.
// `nextLine` is the following stripped line (for table lookahead) or null.
export function trackState(line, nextLine, st) {
  if (isBlank(line)) { st.para = false; st.fence = null; st.html = null; return; }
  if (st.fence) {
    const m = measureIndent(line, 0);
    if (m.col <= 3) {
      let i = m.idx, n = 0;
      while (i < line.length && line.charCodeAt(i) === st.fence.char) { i++; n++; }
      if (n >= st.fence.len) {
        let ok = true;
        for (; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) { ok = false; break; } }
        if (ok) { st.fence = null; st.para = false; }
      }
    }
    return;
  }
  if (st.html) {
    const close = st.html;
    if (line.toLowerCase().indexOf(close) !== -1) st.html = null;
    return;
  }
  const m = measureIndent(line, 0);
  if (m.col > 3) return; // indented code: not a paragraph, leaves st.para as-is
  const idx = m.idx, c = line.charCodeAt(idx);
  // setext underline converts open paragraph to heading
  if (st.para && (c === 61 || c === 45) && setextInfo(line)) { st.para = false; return; }
  if (c === 35 && atxInfo(line, m)) { st.para = false; return; }
  if ((c === 42 || c === 45 || c === 95) && isHr(line, m)) { st.para = false; return; }
  if (c === 96 || c === 126) {
    const f = fenceInfo(line, m);
    if (f) { st.fence = f; st.para = false; return; }
  }
  if (c === 60) {
    const h = htmlStart(line, m);
    if (h) {
      if (h.kind === 1) {
        const closeTag = '</' + h.closeTag;
        if (line.toLowerCase().indexOf(closeTag) === -1) st.html = closeTag;
      } else if (h.close) {
        if (line.indexOf(h.close) === -1) st.html = h.close;
      }
      st.para = false; return;
    }
  }
  if (c === 45 || c === 43 || c === 42 || (c >= 48 && c <= 57)) {
    const lm = listMarker(line, m);
    if (lm) { st.para = !lm.empty; return; }
  }
  if (nextLine !== null && nextLine !== undefined && tableDelim(nextLine) && !isPureSetextDash(nextLine)) { st.para = false; return; }
  st.para = true;
}

// ---------- block parsers ----------

export function parseFence(lines, i, end, f) {
  const content = [];
  let j = i + 1;
  while (j < end) {
    const line = lines[j];
    const m = measureIndent(line, 0);
    if (m.col <= 3) {
      let k = m.idx, n = 0;
      while (k < line.length && line.charCodeAt(k) === f.char) { k++; n++; }
      if (n >= f.len) {
        let ok = true;
        for (; k < line.length; k++) { const c = line.charCodeAt(k); if (c !== 32 && c !== 9) { ok = false; break; } }
        if (ok) { j++; break; }
      }
    }
    content.push(stripLeadChars(line, f.indent));
    j++;
  }
  // exactly one trailing blank line is dropped from fenced code content
  if (content.length && content[content.length - 1] === '') content.pop();
  const lang = unescape(f.info.split(/\s+/)[0] || '');
  return { node: { t: 'code', lang, text: content.length ? content.join('\n') + '\n' : '' }, next: j };
}

export function parseIndented(lines, i, end) {
  const content = [];
  let j = i, last = i;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) {
      // include only if a later indented line follows
      let k = j + 1, found = false;
      while (k < end) {
        if (isBlank(lines[k])) { k++; continue; }
        if (measureIndent(lines[k], 0).col >= 4) found = true;
        break;
      }
      if (!found) break;
      content.push(stripCodeIndent(line));
      j++;
      continue;
    }
    const m = measureIndent(line, 0);
    if (m.col < 4) break;
    content.push(stripCodeIndent(line));
    last = j + 1;
    j++;
  }
  // drop trailing blanks
  while (content.length && content[content.length - 1] === '') content.pop();
  return { node: { t: 'code', lang: '', text: content.length ? content.join('\n') + '\n' : '' }, next: last };
}

export function parseHtml(lines, i, end, h, eofNL) {
  const text = [];
  let j = i;
  if (h.kind >= 1 && h.kind <= 5) {
    const close = h.kind === 1 ? '</' + h.closeTag : h.close;
    while (j < end) {
      text.push(lines[j]);
      const low = lines[j].toLowerCase();
      if (h.kind === 4) {
        if (lines[j].indexOf('>') !== -1) { j++; break; }
      } else if (low.indexOf(close) !== -1) { j++; break; }
      j++;
    }
  } else {
    while (j < end && !isBlank(lines[j])) { text.push(lines[j]); j++; }
  }
  const atEof = j >= end;
  let t = text.join('\n');
  if (h.kind >= 1 && h.kind <= 5) {
    // trailing newline kept only if the next line is non-blank (another block
    // follows immediately) or at EOF when the source ends with a newline
    if ((j < end && !isBlank(lines[j])) || (j >= end && eofNL)) t += '\n';
  } else if (atEof && eofNL) {
    t += '\n';
  }
  return { node: { t: 'html', text: t }, next: j };
}

export function parseTable(lines, i, end, d) {
  const head = splitCells(lines[i]);
  const rows = [];
  let j = i + 2;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) break;
    if (interruptsParagraph(line, j + 1 < end ? lines[j + 1] : null)) break;
    rows.push(splitCells(line));
    j++;
  }
  return { node: { t: 'table', head, align: d.align, rows }, next: j };
}

export function parseParagraph(lines, i, end, refs, inItem) {
  const text = [lines[i]];
  let j = i;
  while (j + 1 < end) {
    const next = lines[j + 1];
    if (isBlank(next)) break;
    const si = setextInfo(next);
    if (si) {
      const level = si;
      return { node: { t: 'h', level, text: trimParaText(text.join('\n')) }, next: j + 2 };
    }
    const after = j + 2 < end ? lines[j + 2] : null;
    if (interruptsParagraph(next, after, inItem)) break;
    text.push(next);
    j++;
  }
  return { node: { t: 'p', text: text.join('\n') }, next: j + 1 };
}

// ---------- containers ----------

// Strip one blockquote marker ('>' + 1 column) from line; null if no marker.
export function stripQuoteMarker(line) {
  const m = measureIndent(line, 0);
  if (m.col > 3) return null;
  if (line.charCodeAt(m.idx) !== 62) return null;
  return stripIndent(line, m.idx + 1, 1, m.col + 1);
}

export function collectQuote(lines, i, end, refs) {
  const stripped = [];
  const st = { para: false, fence: null, html: null };
  let j = i;
  while (j < end) {
    const line = lines[j];
    const content = stripQuoteMarker(line);
    if (content !== null) {
      // peek next stripped line for table lookahead
      let nextStripped = null;
      if (j + 1 < end) nextStripped = stripQuoteMarker(lines[j + 1]);
      // a whitespace-only (non-empty) content line inside a paragraph is
      // paragraph text (e.g. ">  " contributes a space), not a blank line
      if (content.length > 0 && isBlank(content) && st.para && stripped.length > 0) {
        stripped[stripped.length - 1] += '\n' + content;
      } else {
        stripped.push(content);
      }
      trackState(content, nextStripped, st);
      j++;
      continue;
    }
    if (st.para && !isBlank(line)) {
      const ns0 = j + 1 < end ? lines[j + 1] : null;
      const mq = measureIndent(line, 0);
      if (listMarker(line, mq) || interruptsParagraph(line, ns0)) break;
      // lazy setext underline: prepend 4 spaces so it stays paragraph text;
      // lazy line indented >= 4: strip 4 columns
      let content = line;
      if (setextInfo(line)) content = '    ' + line;
      else if (mq.col >= 4) content = stripIndent(line, 0, 4);
      // lazy continuation is paragraph text: append to the paragraph's last
      // line instead of starting a new line (a stripped '- bar' must not
      // be re-parsed as a list marker)
      if (stripped.length > 0) stripped[stripped.length - 1] += '\n' + content;
      else stripped.push(content);
      let nextStripped = null;
      if (j + 1 < end) nextStripped = stripQuoteMarker(lines[j + 1]);
      trackState(content, nextStripped, st);
      j++;
      continue;
    }
    break;
  }
  const nodes = parseBlocks(stripped, 0, stripped.length, refs);
  return { nodes, next: j };
}

// Collect one list item's lines (starting at marker line `i`, marker `lm`).
// Returns {lines, next, blankBetween, blankInside} where blankBetween is true
// if a blank line separated this item from the previous one.
export function collectItem(lines, i, end, lm, listIndent) {
  const itemLines = [];
  // first line: strip the marker, then spaces up to contentIndent
  const m0 = measureIndent(lines[i], 0);
  itemLines.push(stripIndent(lines[i], m0.idx + lm.markerLen, lm.contentIndent - (m0.col + lm.markerLen), m0.col + lm.markerLen));
  const st = { para: false, fence: null, html: null };
  let nextStripped = null;
  if (i + 1 < end) nextStripped = lines[i + 1];
  trackState(itemLines[0], nextStripped, st);
  let j = i + 1;
  let blankInside = false, blankSeen = false, sawContentAfterBlank = false;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) {
      // an empty item ends at a blank line (content after it is not part
      // of the item); a non-empty item keeps going
      if (itemLines.every((l) => l === '')) break;
      blankSeen = true;
      st.para = false;
      itemLines.push('');
      j++;
      continue;
    }
    const m = measureIndent(line, 0);
    // new item of same list at same indent? only when it is below this
    // item's content indent: a marker at or past contentIndent is nested
    // content of this item, not a sibling (even if it equals listIndent)
    if (m.col === listIndent && m.col < lm.contentIndent) {
      if (isHr(line, m)) break;
      const nm = listMarker(line, m);
      if (nm && nm.ordered === lm.ordered && nm.delim === lm.delim && nm.bullet === lm.bullet) {
        break;
      }
    }
    if (m.col >= lm.contentIndent) {
      const content = stripIndent(line, 0, lm.contentIndent);
      if (blankSeen) { blankInside = true; sawContentAfterBlank = true; }
      blankSeen = false;
      itemLines.push(content);
      let ns = null;
      if (j + 1 < end) ns = lines[j + 1];
      trackState(content, ns, st);
      j++;
      continue;
    }
    if (st.para) {
      // lazy continuation: but not a line that starts a new block or a
      // setext underline (those end the item instead)
      const ns0 = j + 1 < end ? lines[j + 1] : null;
      if (listMarker(line, m) || interruptsParagraph(line, ns0)) break;
      if (blankSeen) { blankInside = true; sawContentAfterBlank = true; }
      blankSeen = false;
      // lazy setext underline: prepend 4 spaces so it stays paragraph text;
      // lazy line indented >= 4: strip 4 columns
      let content = line;
      if (setextInfo(line)) content = '    ' + line;
      else if (m.col >= 4) content = stripIndent(line, 0, 4);
      // lazy continuation is paragraph text: append to the paragraph's last
      // line instead of starting a new line
      if (itemLines.length > 0) itemLines[itemLines.length - 1] += '\n' + content;
      else itemLines.push(content);
      let ns = null;
      if (j + 1 < end) ns = lines[j + 1];
      trackState(content, ns, st);
      j++;
      continue;
    }
    break;
  }
  // drop trailing blank lines from item content (but report them via next so
  // the caller can tell the list is loose); never rewind past the first line
  let popped = 0;
  while (itemLines.length && itemLines[itemLines.length - 1] === '') { itemLines.pop(); popped++; }
  return { lines: itemLines, next: itemLines.length ? j - popped : j, blankInside };
}

export function collectList(lines, i, end, refs) {
  const first = measureIndent(lines[i], 0);
  const lm0 = listMarker(lines[i], first);
  const listIndent = first.col;
  const items = [];
  let loose = false;
  let j = i;
  let firstItem = true;
  let prevEndHadBlank = false;
  while (j < end) {
    const m = measureIndent(lines[j], 0);
    if (isHr(lines[j], m)) break;
    const lm = listMarker(lines[j], m);
    // sibling items may be indented up to 3 columns past the list indent,
    // and may also be less indented than the first item (a first item at
    // indent 2 followed by items at indent 0 is still one list)
    if (!lm || m.col > listIndent + 3 || lm.ordered !== lm0.ordered || lm.delim !== lm0.delim || lm.bullet !== lm0.bullet) break;
    // blank line between previous item and this one?
    if (!firstItem) {
      let k = j - 1;
      // scan back over blank lines that belong to previous item collection
      // (collectItem already dropped them; detect via lines between)
      // We detect separation by checking whether the previous item's next
      // was < j (i.e. blank lines were skipped between items).
      // Simpler: blank lines between items are detected here by looking at
      // the gap between the previous item's last content line and this line.
      // collectItem returns next = first non-consumed line; if it stopped at
      // a blank line, next points at that blank line. We handle below.
    }
    const r = collectItem(lines, j, end, lm, listIndent);
    // blank lines between items: collectItem stops at a blank line that
    // precedes a new item marker; count them. If the next non-blank line
    // is a sibling item, advance past the blanks; otherwise leave j at
    // the first blank line so the outer parser sees the blank (it may
    // separate two top-level blocks inside the enclosing item)
    let k = r.next;
    let hadBlank = false;
    while (k < end && isBlank(lines[k])) { hadBlank = true; k++; }
    let nextIsSibling = false;
    if (hadBlank && k < end) {
      const m2 = measureIndent(lines[k], 0);
      const lm2 = listMarker(lines[k], m2);
      if (lm2 && m2.col <= listIndent + 3 && lm2.ordered === lm0.ordered && lm2.delim === lm0.delim && lm2.bullet === lm0.bullet) {
        loose = true;
        nextIsSibling = true;
      }
    }
    items.push(r.lines);
    firstItem = false;
    j = nextIsSibling ? k : (hadBlank ? r.next : k);
    if (j >= end) break;
    const m3 = measureIndent(lines[j], 0);
    const lm3 = listMarker(lines[j], m3);
    if (!lm3 || m3.col > listIndent + 3 || lm3.ordered !== lm0.ordered || lm3.delim !== lm0.delim || lm3.bullet !== lm0.bullet) break;
  }
  // parse each item, extracting task checkboxes
  const parsed = items.map((itemLines) => {
    let task = null;
    const lines2 = itemLines.slice();
    if (lines2.length && lines2[0] !== '') {
      const s = lines2[0];
      if (s.charCodeAt(0) === 91 && s.charCodeAt(1) === 32 && s.charCodeAt(2) === 93) task = ' ';
      else if (s.charCodeAt(0) === 91 && (s.charCodeAt(1) === 120 || s.charCodeAt(1) === 88) && s.charCodeAt(2) === 93) task = 'x';
      if (task !== null) {
        const rest = s.slice(3);
        if (rest.length === 0) lines2[0] = '';
        else if (rest.charCodeAt(0) === 32 || rest.charCodeAt(0) === 9) lines2[0] = rest.slice(1);
        else task = null;
      }
    }
    const itemOut = {};
    const children = parseBlocks(lines2, 0, lines2.length, refs, undefined, itemOut, true);
    if (itemOut.blankSep) loose = true;
    return { children, task };
  });
  // blank line separating two top-level blocks inside any item makes the list loose
  // (blank lines nested inside a sub-list/quote do not count)
  return { node: { t: 'list', ordered: lm0.ordered, start: lm0.ordered ? lm0.num : null, loose, items: parsed }, next: j };
}

// ---------- main block parser ----------

export function parseBlocks(lines, start, end, refs, eofNL, out, inItem) {
  const nodes = [];
  let i = start;
  let sawBlankAfterNode = false;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) { if (nodes.length > 0) sawBlankAfterNode = true; i++; continue; }
    const rd = tryRefDef(lines, i, refs);
    if (rd) {
      // a reference definition is a block for looseness: a blank line
      // before it separates two top-level blocks even though it renders nothing
      if (sawBlankAfterNode && out) out.blankSep = true;
      sawBlankAfterNode = false;
      i += rd.n; continue;
    }
    // a real block follows a blank line that came after a previous block:
    // the blank line separates two top-level blocks (ref defs don't count)
    if (sawBlankAfterNode && out) out.blankSep = true;
    sawBlankAfterNode = false;
    const m = measureIndent(line, 0);
    const idx = m.idx;
    const c = line.charCodeAt(idx);
    const atx = atxInfo(line, m);
    if (atx) { nodes.push({ t: 'h', level: atx.level, text: atx.text }); i++; continue; }
    if (isHr(line, m)) { nodes.push({ t: 'hr' }); i++; continue; }
    if (c === 96 || c === 126) {
      const f = fenceInfo(line, m);
      if (f) { const r = parseFence(lines, i, end, f); nodes.push(r.node); i = r.next; continue; }
    }
    if (m.col >= 4) { const r = parseIndented(lines, i, end); nodes.push(r.node); i = r.next; continue; }
    if (c === 60) {
      const h = htmlStart(line, m);
      if (h) { const r = parseHtml(lines, i, end, h, eofNL); nodes.push(r.node); i = r.next; continue; }
    }
    if (c === 62) {
      const r = collectQuote(lines, i, end, refs);
      nodes.push({ t: 'quote', children: r.nodes }); i = r.next; continue;
    }
    const lm = listMarker(line, m);
    if (lm) { const r = collectList(lines, i, end, refs); nodes.push(r.node); i = r.next; continue; }
    if (i + 1 < end) {
      const d = tableDelim(lines[i + 1]);
      if (d && !isPureSetextDash(lines[i + 1]) && d.align.length === splitCells(lines[i]).length) { const r = parseTable(lines, i, end, d); nodes.push(r.node); i = r.next; continue; }
    }
    const r = parseParagraph(lines, i, end, refs, inItem);
    if (r.node) nodes.push(r.node);
    i = r.next;
  }
  return nodes;
}

// ============================================================
// Chunk 3 — block renderer
// ============================================================

const ALIGN_WORD = { l: 'left', r: 'right', c: 'center' };

export function renderBlocks(nodes, refs, out) {
  for (const n of nodes) {
    switch (n.t) {
      case 'p':
        out.push('<p>', renderInline(n.text, refs), '</p>\n');
        break;
      case 'h':
        out.push('<h', n.level, '>', renderInline(n.text, refs), '</h', n.level, '>\n');
        break;
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'code':
        out.push('<pre><code');
        if (n.lang) { out.push(' class="language-', escAttr(n.lang), '"'); }
        out.push('>', escCode(n.text), '</code></pre>\n');
        break;
      case 'html':
        out.push(n.text);
        break;
      case 'quote':
        out.push('<blockquote>\n');
        renderBlocks(n.children, refs, out);
        out.push('</blockquote>\n');
        break;
      case 'list':
        renderList(n, refs, out);
        break;
      case 'table':
        renderTable(n, refs, out);
        break;
    }
  }
}

export function renderList(n, refs, out) {
  out.push(n.ordered ? '<ol' : '<ul');
  if (n.ordered && n.start !== 1) out.push(' start="', String(n.start), '"');
  out.push('>\n');
  for (const item of n.items) {
    out.push('<li>');
    renderItem(item, n.loose, refs, out);
    out.push('</li>\n');
  }
  out.push(n.ordered ? '</ol>\n' : '</ul>\n');
}

// Render one list item's children. In a tight list, paragraphs render as
// bare inline content. The task checkbox (if any) prefixes the first block's
// inline content (inside <p> when loose, directly when tight).
export function renderItem(item, loose, refs, out) {
  const kids = item.children;
  const cb = item.task === null ? '' :
    (item.task === 'x' ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ');
  if (kids.length === 0) {
    if (cb) out.push(cb.slice(0, -1));
    return;
  }
  for (let k = 0; k < kids.length; k++) {
    const child = kids[k];
    const prefix = k === 0 ? cb : '';
    if (child.t === 'p') {
      if (loose) {
        out.push('<p>', prefix, renderInline(child.text, refs), '</p>\n');
      } else {
        out.push(prefix, renderInline(child.text, refs));
      }
    } else {
      if (prefix) out.push(prefix);
      renderBlocks([child], refs, out);
    }
  }
}

export function renderTable(n, refs, out) {
  out.push('<table>\n<thead>\n<tr>\n');
  for (let i = 0; i < n.head.length; i++) {
    const a = n.align[i];
    out.push('<th', a ? ' align="' + ALIGN_WORD[a] + '"' : '', '>', renderInline(n.head[i], refs), '</th>\n');
  }
  out.push('</tr>\n</thead>\n');
  if (n.rows.length > 0) {
    out.push('<tbody>');
    for (const row of n.rows) {
      out.push('<tr>\n');
      for (let i = 0; i < n.head.length; i++) {
        const a = n.align[i];
        const cell = i < row.length ? row[i] : '';
        out.push('<td', a ? ' align="' + ALIGN_WORD[a] + '"' : '', '>', renderInline(cell, refs), '</td>\n');
      }
      out.push('</tr>\n');
    }
    out.push('</tbody>');
  }
  out.push('</table>\n');
}

// ============================================================
// Chunk 4 — inline layer (renderInline + helpers)
// ============================================================

function isPunctCh(c) {
  if (c < 0) return false;
  if (c < 128) return isPunct(c);
  return /^[\p{P}\p{S}]$/u.test(String.fromCodePoint(c));
}
function isSpaceCh(c) {
  return c === -1 || c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
    c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}
function leftFlank(b, a) { return !isSpaceCh(a) && (!isPunctCh(a) || isSpaceCh(b) || isPunctCh(b)); }
function rightFlank(b, a) { return !isSpaceCh(b) && (!isPunctCh(b) || isSpaceCh(a) || isPunctCh(a)); }

// Escape plain text: & (entity-aware; numeric refs decode then re-escape), < > " '
function escText(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const e = entityAt(s, i);
      if (e) { out += s[i + 1] === '#' ? escCode(e.raw) : e.raw; i += e.len - 1; continue; }
      out += '&amp;';
    } else if (c === 60) out += '&lt;';
    else if (c === 62) out += '&gt;';
    else if (c === 34) out += '&quot;';
    else if (c === 39) out += '&#39;';
    else out += s[i];
  }
  return out;
}

function isEmailLocalChar(c) {
  return isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
    c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 ||
    c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}

// Scan a domain starting at i: labels [A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?
// separated by '.', at least one dot. Returns end index or -1.
function scanDomain(s, i) {
  const n = s.length;
  let k = i, dots = 0;
  if (k >= n || !isAlnum(s.charCodeAt(k))) return -1;
  while (k < n) {
    k++;
    while (k < n && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 45)) k++;
    if (s.charCodeAt(k - 1) === 45) return -1;
    if (k < n && s.charCodeAt(k) === 46 && k + 1 < n && isAlnum(s.charCodeAt(k + 1))) { dots++; k++; continue; }
    break;
  }
  return dots >= 1 ? k : -1;
}

// Scan an email starting at i (local part from i). Returns end index or -1.
function scanEmailAt(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && isEmailLocalChar(s.charCodeAt(j))) j++;
  if (j === i || j >= n || s.charCodeAt(j) !== 64) return -1;
  const d = scanDomain(s, j + 1);
  if (d < 0) return -1;
  if (d < n && (s.charCodeAt(d) === 45 || s.charCodeAt(d) === 95)) return -1;
  return d;
}

// Is the whole string s a valid email (for <...> autolinks)?
function isEmailStr(s) {
  const at = s.indexOf('@');
  if (at <= 0) return false;
  for (let k = 0; k < at; k++) if (!isEmailLocalChar(s.charCodeAt(k))) return false;
  const d = scanDomain(s, at + 1);
  return d === s.length;
}

// HTML tag scanner. s[i] === '<'. Returns end index (exclusive) or -1.
function scanTag(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return -1;
  const c = s.charCodeAt(j);
  if (c === 33) { // !
    if (s.startsWith('!-->', j)) return j + 4;
    if (s.startsWith('!--->', j)) return j + 5;
    if (s.startsWith('!--', j)) {
      const e = s.indexOf('-->', j + 3);
      return e >= 0 ? e + 3 : -1;
    }
    if (s.startsWith('[CDATA[', j + 1)) {
      const e = s.indexOf(']]>', j + 8);
      return e >= 0 ? e + 3 : -1;
    }
    if (j + 1 < n && isAlpha(s.charCodeAt(j + 1))) {
      const e = s.indexOf('>', j + 1);
      return e >= 0 ? e + 1 : -1;
    }
    return -1;
  }
  if (c === 63) { // ?
    const e = s.indexOf('?>', j + 1);
    return e >= 0 ? e + 2 : -1;
  }
  let closing = false;
  if (c === 47) { closing = true; j++; if (j >= n || !isAlpha(s.charCodeAt(j))) return -1; }
  else if (!isAlpha(c)) return -1;
  while (j < n) { const d = s.charCodeAt(j); if (isAlnum(d) || d === 45) j++; else break; }
  if (closing) {
    while (j < n && isWhite(s.charCodeAt(j))) j++;
    if (j < n && s.charCodeAt(j) === 62) return j + 1;
    return -1;
  }
  while (true) {
    const ws0 = j;
    while (j < n && isWhite(s.charCodeAt(j))) j++;
    if (j >= n) return -1;
    const d = s.charCodeAt(j);
    if (d === 62) return j + 1;
    if (d === 47) { if (j + 1 < n && s.charCodeAt(j + 1) === 62) return j + 2; return -1; }
    if (j === ws0) return -1;
    if (!(isAlpha(d) || d === 95 || d === 58)) return -1;
    while (j < n) { const e2 = s.charCodeAt(j); if (isAlnum(e2) || e2 === 95 || e2 === 58 || e2 === 46 || e2 === 45) j++; else break; }
    const afterName = j;
    while (j < n && isWhite(s.charCodeAt(j))) j++;
    if (j < n && s.charCodeAt(j) === 61) {
      j++;
      while (j < n && isWhite(s.charCodeAt(j))) j++;
      if (j >= n) return -1;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        while (j < n && s.charCodeAt(j) !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        if (isWhite(q) || q === 62) return -1;
        while (j < n) {
          const e2 = s.charCodeAt(j);
          if (isWhite(e2) || e2 === 62) break;
          // unquoted attribute values may not contain " ' = < or backtick
          if (e2 === 34 || e2 === 39 || e2 === 61 || e2 === 60 || e2 === 96) return -1;
          j++;
        }
      }
    } else {
      // boolean attribute (no '='): rewind past the whitespace so the
      // next attribute still sees it as its required preceding whitespace
      j = afterName;
    }
  }
}

// <...> autolink (scheme >= 2 chars, or email) or raw HTML tag.
// Returns {html, end} or null.
function scanAngle(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 62) break;
    if (c === 60 || c === 32 || c === 9 || c === 10 || c === 13) { j = -1; break; }
    j++;
  }
  if (j > i + 1 && j < n && s.charCodeAt(j) === 62) {
    const inner = s.slice(i + 1, j);
    // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}:
    let k = 0;
    if (isAlpha(inner.charCodeAt(0))) {
      k = 1;
      let cnt = 0;
      while (k < inner.length && cnt < 31) {
        const d = inner.charCodeAt(k);
        if (isAlnum(d) || d === 43 || d === 46 || d === 45) { k++; cnt++; } else break;
      }
      if (cnt >= 1 && k < inner.length && inner.charCodeAt(k) === 58) {
        return { html: '<a href="' + encodeHref(inner) + '">' + escAttr(inner) + '</a>', end: j + 1 };
      }
    }
    if (isEmailStr(inner)) {
      return { html: '<a href="mailto:' + encodeHref(inner) + '">' + escAttr(inner) + '</a>', end: j + 1 };
    }
  }
  const te = scanTag(s, i);
  if (te > 0) return { html: s.slice(i, te), end: te };
  return null;
}

// Strip HTML tags from s (for image alt text).
function stripTags(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '<') {
      const e = scanTag(s, i);
      if (e > 0) {
        const tag = s.slice(i, e);
        if (tag.slice(1, 4).toLowerCase() === 'img') {
          const ai = tag.indexOf('alt="');
          if (ai >= 0) {
            const ae = tag.indexOf('"', ai + 5);
            if (ae > ai) out += tag.slice(ai + 5, ae);
          }
        }
        i = e; continue;
      }
    }
    out += s[i]; i++;
  }
  return out;
}

// Scan a link label starting at s[i] === '['. Returns {end, text, nestedLink}
// or null. nestedLink = the label contains a complete inner (non-image) link.
function findLabelEnd(s, i) {
  const n = s.length;
  let depth = 1;
  let j = i + 1;
  let nestedLink = false;
  const imgStack = [false];
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 60) { // < : skip a whole tag/autolink (a ] inside it is not a label end)
      const a = scanAngle(s, j);
      if (a) { j = a.end; continue; }
      j++;
      continue;
    }
    if (c === 96) {
      let r = j;
      while (r < n && s.charCodeAt(r) === 96) r++;
      const len = r - j;
      let k = r, found = -1;
      while (k < n) {
        if (s.charCodeAt(k) === 96) {
          let r2 = k;
          while (r2 < n && s.charCodeAt(r2) === 96) r2++;
          if (r2 - k === len) { found = r2; break; }
          k = r2;
        } else k++;
      }
      if (found < 0) { j = r; continue; }
      j = found; continue;
    }
    if (c === 91) {
      imgStack.push(j > 0 && s.charCodeAt(j - 1) === 33);
      depth++;
      j++;
      continue;
    }
    if (c === 93) {
      depth--;
      const wasImg = imgStack.pop();
      if (depth === 0) return { end: j, text: s.slice(i + 1, j), nestedLink };
      if (!wasImg) {
        const nx = j + 1 < n ? s.charCodeAt(j + 1) : -1;
        if (nx === 40 || nx === 91) nestedLink = true;
      }
      j++;
      continue;
    }
    j++;
  }
  return null;
}

// Parse (dest title) starting at s[i] === '('. Returns {dest, title, end} or null.
function parseInlineDest(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n && isWhite(s.charCodeAt(j))) j++;
  let dest = '';
  if (j < n && s.charCodeAt(j) === 60) {
    j++;
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === 62) break;
      if (c === 60 || c === 10 || c === 13) return null;
      j++;
    }
    if (j >= n) return null;
    dest = s.slice(start, j);
    j++;
  } else {
    const start = j;
    let depth = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === 40) depth++;
      else if (c === 41) { if (depth === 0) break; depth--; }
      else if (isWhite(c)) break;
      j++;
    }
    dest = s.slice(start, j);
  }
  while (j < n && isWhite(s.charCodeAt(j))) j++;
  let title = null;
  if (j < n && (s.charCodeAt(j) === 34 || s.charCodeAt(j) === 39)) {
    const q = s.charCodeAt(j);
    j++;
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === q) break;
      j++;
    }
    if (j >= n) return null;
    title = s.slice(start, j);
    j++;
  } else if (j < n && s.charCodeAt(j) === 40) {
    j++;
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === 40) return null;
      if (c === 41) break;
      j++;
    }
    if (j >= n) return null;
    title = s.slice(start, j);
    j++;
  }
  while (j < n && isWhite(s.charCodeAt(j))) j++;
  if (j >= n || s.charCodeAt(j) !== 41) return null;
  return { dest: unescape(dest), title: title === null ? null : unescape(title), end: j + 1 };
}

// Try to parse a link (isImage=false, s[i]==='[') or image (isImage=true,
// s[i]==='!' and s[i+1]==='['). Returns {html, end} or null.
function tryLinkAt(s, i, refs, isImage) {
  const lb = isImage ? i + 1 : i;
  const lab = findLabelEnd(s, lb);
  if (!lab) return null;
  if (!isImage && lab.nestedLink) return null;
  const n = s.length;
  let j = lab.end + 1;
  let dest = null, title = null;
  if (j < n && s.charCodeAt(j) === 40) {
    const d = parseInlineDest(s, j);
    if (d) {
      dest = d.dest; title = d.title; j = d.end;
    } else {
      // invalid inline destination: fall back to a shortcut reference
      // link, leaving the "(...)" as literal text
      const ref = refs.get(normLabel(lab.text));
      if (!ref) return null;
      dest = ref.dest; title = ref.title; j = lab.end + 1;
    }
  } else if (j < n && s.charCodeAt(j) === 91) {
    const lab2 = findLabelEnd(s, j);
    if (!lab2) return null;
    let label2 = lab2.text;
    if (label2 === '') label2 = lab.text;
    const ref = refs.get(normLabel(label2));
    if (!ref) return null;
    dest = ref.dest; title = ref.title; j = lab2.end + 1;
  } else {
    const ref = refs.get(normLabel(lab.text));
    if (!ref) return null;
    dest = ref.dest; title = ref.title;
  }
  const href = encodeHref(dest);
  const t = title === null ? '' : ' title="' + escAttr(title) + '"';
  if (isImage) {
    const alt = stripTags(renderInline(lab.text, refs, true));
    return { html: '<img src="' + href + '" alt="' + alt + '"' + t + '>', end: j };
  }
  return { html: '<a href="' + href + '"' + t + '>' + renderInline(lab.text, refs, true) + '</a>', end: j };
}

// Trim trailing punctuation off a bare-autolink URL (GFM extension rules).
function trimUrlEnd(u) {
  let end = u.length;
  while (end > 0) {
    const ch = u[end - 1];
    if (ch === '?' || ch === '!' || ch === '.' || ch === ',' || ch === ':' || ch === '*' || ch === '_' || ch === '~') { end--; continue; }
    if (ch === ';') {
      let k = end - 2;
      while (k >= 0 && (isAlnum(u.charCodeAt(k)) || u.charCodeAt(k) === 95)) k--;
      if (k >= 0 && u.charCodeAt(k) === 38 && k <= end - 3) { end = k; continue; }
      end--; continue;
    }
    if (ch === ')') {
      let o = 0, c = 0;
      for (let k = 0; k < end; k++) { if (u[k] === '(') o++; else if (u[k] === ')') c++; }
      if (c > o) { end--; continue; }
      break;
    }
    break;
  }
  return u.slice(0, end);
}

// Case-insensitive match of `word` at s[i] (word contains no uppercase logic).
function matchCI(s, i, word) {
  for (let k = 0; k < word.length; k++) {
    if (i + k >= s.length) return false;
    let a = s.charCodeAt(i + k);
    if (a >= 65 && a <= 90) a += 32;
    if (a !== word.charCodeAt(k)) return false;
  }
  return true;
}

// Bare autolink at position i (www. / http(s):// / ftp:// / mailto: / email).
// Returns {html, end} or null.
function scanBareAutolink(s, i) {
  const n = s.length;
  const prev = i > 0 ? s.charCodeAt(i - 1) : -1;
  if (s.charCodeAt(i) === 119 && s.startsWith('www.', i) && !isWord(prev)) {
    let j = i;
    while (j < n) { const c = s.charCodeAt(j); if (isWhite(c) || c === 60) break; j++; }
    const u = trimUrlEnd(s.slice(i, j));
    if (u.length > 4) {
      return { html: '<a href="http://' + encodeHref(u) + '">' + escAttr(u) + '</a>', end: i + u.length };
    }
    return null;
  }
  const c0 = s.charCodeAt(i);
  let schemeLen = 0, isMailto = false, isXmpp = false;
  if ((c0 === 104 || c0 === 72) && matchCI(s, i, 'http://')) schemeLen = 7;
  else if ((c0 === 104 || c0 === 72) && matchCI(s, i, 'https://')) schemeLen = 8;
  else if ((c0 === 102 || c0 === 70) && matchCI(s, i, 'ftp://')) schemeLen = 6;
  else if (c0 === 109 && s.startsWith('mailto:', i)) { schemeLen = 7; isMailto = true; }
  else if (c0 === 120 && s.startsWith('xmpp:', i)) { schemeLen = 5; isXmpp = true; }
  if (schemeLen > 0 && !isWord(prev)) {
    if (isMailto) {
      const e = scanEmailAt(s, i + schemeLen);
      if (e < 0) return null;
      const email = s.slice(i + schemeLen, e);
      return { html: '<a href="mailto:' + encodeHref(email) + '">' + escAttr(s.slice(i, e)) + '</a>', end: e };
    }
    if (isXmpp) {
      const e = scanEmailAt(s, i + schemeLen);
      if (e < 0) return null;
      let end = e;
      if (end < n && s.charCodeAt(end) === 47) {
        let k = end + 1;
        while (k < n) {
          const c = s.charCodeAt(k);
          if (isAlnum(c) || c === 64 || c === 46) k++; else break;
        }
        if (k > end + 1) {
          end = k;
          while (end > e && (s.charCodeAt(end - 1) === 46 || s.charCodeAt(end - 1) === 63 || s.charCodeAt(end - 1) === 33 || s.charCodeAt(end - 1) === 44 || s.charCodeAt(end - 1) === 58 || s.charCodeAt(end - 1) === 59)) end--;
        }
      }
      const full = s.slice(i, end);
      return { html: '<a href="' + encodeHref(full) + '">' + escAttr(full) + '</a>', end };
    }
    let j = i + schemeLen;
    while (j < n) { const c = s.charCodeAt(j); if (isWhite(c) || c === 60) break; j++; }
    const u = trimUrlEnd(s.slice(i, j));
    if (u.length > schemeLen) {
      return { html: '<a href="' + encodeHref(u) + '">' + escAttr(u) + '</a>', end: i + u.length };
    }
    return null;
  }
  if (isEmailLocalChar(c0) && !isEmailLocalChar(prev)) {
    const e = scanEmailAt(s, i);
    if (e > i) {
      const email = s.slice(i, e);
      return { html: '<a href="mailto:' + encodeHref(email) + '">' + escAttr(email) + '</a>', end: e };
    }
  }
  return null;
}

// Code span starting at s[i] === '`'. Returns {html, end} or null.
function scanCodeSpan(s, i) {
  const n = s.length;
  let r = i;
  while (r < n && s.charCodeAt(r) === 96) r++;
  const len = r - i;
  let k = r;
  while (k < n) {
    if (s.charCodeAt(k) === 96) {
      let r2 = k;
      while (r2 < n && s.charCodeAt(r2) === 96) r2++;
      if (r2 - k === len) {
        let content = s.slice(r, k).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        return { html: '<code>' + escCode(content) + '</code>', end: r2 };
      }
      k = r2;
    } else k++;
  }
  return null;
}

// Resolve emphasis/delimiter runs in a parts array (strings + delim objects).
// Delimiter-stack algorithm with the rule of 3s.
function resolveEmphasis(parts) {
  for (let k = 0; k < parts.length; k++) {
    const cl = parts[k];
    if (typeof cl !== 'object' || !cl.c || cl.n === 0) continue;
    for (let j = k - 1; j >= 0; j--) {
      const op = parts[j];
      if (typeof op !== 'object' || !op.o || op.n === 0) continue;
      if (op.ch !== cl.ch) continue;
      const bothCapable = (op.o && op.c) || (cl.o && cl.c);
      if (bothCapable && (op.orig + cl.orig) % 3 === 0 && !(op.orig % 3 === 0 && cl.orig % 3 === 0)) continue;
      const n = (op.n >= 2 && cl.n >= 2) ? 2 : 1;
      const tag = cl.ch === '~' ? 'del' : (n === 2 ? 'strong' : 'em');
      let inner = '';
      for (let m = j + 1; m < k; m++) {
        const p = parts[m];
        inner += typeof p === 'object' ? p.ch.repeat(p.n) : p;
      }
      const wrapped = '<' + tag + '>' + inner + '</' + tag + '>';
      op.n -= n; cl.n -= n;
      const repl = [];
      if (op.n > 0) repl.push(op);
      repl.push(wrapped);
      if (cl.n > 0) repl.push(cl);
      parts.splice(j, k - j + 1, ...repl);
      k = j + repl.length - 2;
      break;
    }
  }
  let out = '';
  for (const p of parts) out += typeof p === 'object' ? p.ch.repeat(p.n) : p;
  return out;
}

export function renderInline(text, refs, inLink) {
  const n = text.length;
  let hasSpecial = false;
  if (!inLink && (text.indexOf('www.') >= 0 || text.indexOf('://') >= 0 || text.indexOf('@') >= 0 || text.indexOf('![') >= 0)) hasSpecial = true;
  else if (text.indexOf('![') >= 0) hasSpecial = true;
  else {
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 60 || c === 38 || c === 126 || c === 10) { hasSpecial = true; break; }
    }
  }
  if (!hasSpecial) return escText(text);
  const parts = [];
  let run = '';
  const flushRun = () => { if (run) { parts.push(escText(run)); run = ''; } };
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92) {
      const nx = i + 1 < n ? text.charCodeAt(i + 1) : -1;
      if (nx === 10) {
        flushRun();
        parts.push('<br>');
        i += 2;
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        continue;
      }
      if (nx >= 0 && isPunct(nx)) {
        if (nx === 38) { flushRun(); parts.push('&amp;'); }
        else run += text[i + 1];
        i += 2; continue;
      }
      run += '\\'; i++; continue;
    }
    if (c === 96) {
      const cs = scanCodeSpan(text, i);
      if (cs) { flushRun(); parts.push(cs.html); i = cs.end; continue; }
      let r = i;
      while (r < n && text.charCodeAt(r) === 96) r++;
      run += text.slice(i, r); i = r; continue;
    }
    if (c === 38) {
      const e = entityAt(text, i);
      if (e) { flushRun(); parts.push(text[i + 1] === '#' ? escCode(e.raw) : e.raw); i += e.len; continue; }
      run += '&'; i++; continue;
    }
    if (c === 60) {
      const a = scanAngle(text, i);
      if (a) { flushRun(); parts.push(a.html); i = a.end; continue; }
      run += '<'; i++; continue;
    }
    if (c === 33 && i + 1 < n && text.charCodeAt(i + 1) === 91) {
      const link = tryLinkAt(text, i, refs, true);
      if (link) { flushRun(); parts.push(link.html); i = link.end; continue; }
      run += '!'; i++; continue;
    }
    if (c === 91) {
      const link = tryLinkAt(text, i, refs, false);
      if (link) { flushRun(); parts.push(link.html); i = link.end; continue; }
      run += '['; i++; continue;
    }
    if (c === 42 || c === 95 || c === 126) {
      let r = i;
      while (r < n && text.charCodeAt(r) === c) r++;
      const len = r - i;
      if (c === 126 && len >= 3) { run += text.slice(i, r); i = r; continue; }
      const b = cpBefore(text, i);
      const a = r < n ? text.codePointAt(r) : -1;
      const lf = leftFlank(b, a), rf = rightFlank(b, a);
      let canOpen, canClose;
      if (c === 95) { canOpen = lf && (!rf || isPunctCh(b)); canClose = rf && (!lf || isPunctCh(a)); }
      else { canOpen = lf; canClose = rf; }
      flushRun();
      parts.push({ ch: String.fromCharCode(c), n: len, orig: len, o: canOpen, c: canClose });
      i = r; continue;
    }
    if (c === 10) {
      let sp = 0;
      let k = run.length - 1;
      while (k >= 0 && run.charCodeAt(k) === 32) { sp++; k--; }
      if (sp >= 2) {
        run = run.slice(0, run.length - sp);
        flushRun();
        parts.push('<br>');
        i++;
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        continue;
      }
      run += '\n'; i++; continue;
    }
    if ((isAlnum(c) || isEmailLocalChar(c)) && !inLink) {
      const al = scanBareAutolink(text, i);
      if (al) { flushRun(); parts.push(al.html); i = al.end; continue; }
    }
    run += text[i]; i++;
  }
  flushRun();
  return resolveEmphasis(parts);
}

// Entry point: render markdown to HTML. Falls back to vendored marked on Bail.
export function parse(md) {
  try {
    const lines = splitLines(md);
    const refs = new Map();
    const eofNL = md.length > 0 && (md.charCodeAt(md.length - 1) === 10 || md.charCodeAt(md.length - 1) === 13);
    const nodes = parseBlocks(lines, 0, lines.length, refs, eofNL);
    const out = [];
    renderBlocks(nodes, refs, out);
    return out.join('');
  } catch (e) {
    if (e instanceof Bail) {
      stats.bailCases++;
      stats.bailChars += md.length;
      return marked.parse(md);
    }
    throw e;
  }
}

// Trim leading spaces/tabs of the first line and trailing spaces/tabs of
// the last line of a paragraph / setext heading text.
function trimParaText(s) {
  let a = 0;
  while (a < s.length && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  let b = s.length;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

// Code point ending just before index i (handles a surrogate pair).
function cpBefore(s, i) {
  if (i <= 0) return -1;
  const c = s.charCodeAt(i - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && i >= 2) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xD800 && h <= 0xDBFF) return s.codePointAt(i - 2);
  }
  return c;
}

// Remove up to n leading space/tab characters from a line, counting a tab
// as one character. This is marked's fenced-code compensation (its Dt):
// it removes min(leading whitespace length, opening fence's indent length)
// characters, so a tab inside the stripped region is removed whole and a
// tab after it is kept whole, never expanded to spaces.
export function stripLeadChars(line, n) {
  if (n <= 0) return line;
  let j = 0;
  while (j < n && j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) break;
    j++;
  }
  return line.slice(j);
}

// Remove one indented-code indent: 0-3 spaces plus a tab, or 1-4 spaces
// (marked's codeRemoveIndent /^(?: {0,3}\t| {1,4})/gm). A tab after the
// indent is kept as a literal tab, never expanded to spaces.
export function stripCodeIndent(line) {
  let j = 0;
  while (j < 3 && j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < line.length && line.charCodeAt(j) === 9) return line.slice(j + 1);
  j = 0;
  while (j < 4 && j < line.length && line.charCodeAt(j) === 32) j++;
  return line.slice(j);
}
