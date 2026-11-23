// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the output tree
// makefun-site 1.0.0's build returns, byte for byte. Written from scratch from the
// reference's README and behaviour; no code copied from the reference implementation.
// Speed comes from: bulk (regex-segment) inline rendering instead of per-character
// escaping, an ASCII fast path for slugs, manual front-matter/markdown lexing without
// per-line regexes, memoised slugs/dates, and array-accumulated template rendering.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Per-run caches (fresh for every run(): nothing is cached from one case to the next).
let slugMemo = null;
let dateMemo = null;

// ---------------------------------------------------------------- text helpers

const ESC_ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `s` with & < > " ' escaped. One pass; returns `s` itself when nothing needs escaping. */
function escapeHtml(s) {
  // A manual exec loop: on the short strings this is mostly called with (code lines,
  // template values, link targets) it beats String.replace, whose callback costs
  // more than the loop when there is little or nothing to escape.
  ESC_RE.lastIndex = 0;
  let m = ESC_RE.exec(s);
  if (m === null) return s;
  let out = '';
  let last = 0;
  do {
    out += s.slice(last, m.index) + ESC_ENT[m[0]];
    last = m.index + 1;
  } while ((m = ESC_RE.exec(s)) !== null);
  out += s.slice(last);
  return out;
}

const NON_ASCII = /[^\x00-\x7F]/;

/** The slug of `text` (see the reference README, "Text"). ASCII fast path. */
function slugify(text) {
  const hit = slugMemo.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (!NON_ASCII.test(text)) {
    out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    out = out.slice(0, 64).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let s = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = s.length > 0;
        continue;
      }
      if (gap) s += '-';
      gap = false;
      s += keep;
    }
    out = s.slice(0, 64).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  }
  slugMemo.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  let hit = dateMemo.get(date);
  if (hit === undefined) {
    const y = date.slice(0, 4);
    const m = Number(date.slice(5, 7));
    const d = Number(date.slice(8, 10));
    hit = `${d} ${MONTHS[m - 1]} ${y}`;
    dateMemo.set(date, hit);
  }
  return hit;
}

/** Whether the UTF-16 code unit `c` is JS whitespace (\s). */
function isWS(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

const WS128 = new Uint8Array(128);
for (const c of [32, 9, 10, 11, 12, 13]) WS128[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      // ASCII: one table lookup instead of six comparisons per character.
      if (WS128[c]) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    } else if (isWS(c)) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    // starts with '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // starts with '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) tags[i] = tags[i].trim();
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (t === '' || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Parse one `key: value` front-matter line, or null when it is not one. */
function keyValueOf(line) {
  // /^([a-z_]+):(?: (.*))?$/
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 97 && c <= 122) || c === 95) i++;
    else break;
  }
  if (i === 0 || i >= n || line.charCodeAt(i) !== 58) return null; // no key, or no ':'
  if (i + 1 === n) return { key: line.slice(0, i), raw: '' };
  if (line.charCodeAt(i + 1) !== 32) return null;
  return { key: line.slice(0, i), raw: line.slice(i + 2) };
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason
 * it is refused. `text` has "\n" line ends. The body is sliced, never split and rejoined.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing '---' line, scanning line by line.
  let closeLine = -1;
  let closeEnd = -1;
  let pos = nl0 === -1 ? text.length : nl0 + 1;
  let lineNo = 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeLine = lineNo;
      closeEnd = end;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = nl0 === -1 ? text.length : nl0 + 1;
  for (let i = 1; i < closeLine; i++) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(p, end);
    if (isBlank(line) || line.charCodeAt(0) === 35) {
      p = end + 1;
      continue;
    } // blank, or a '#' comment
    const kv = keyValueOf(line);
    if (kv === null) return { error: `line ${i + 1} is not "key: value"` };
    // raw with trailing spaces and tabs dropped
    let raw = kv.raw;
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e !== raw.length) raw = raw.slice(0, e);
    const key = kv.key;
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    p = end + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const LANG_CHARS = new Set(['_', '+', '-']);

/** Whether `c` (a one-char string) is a fence language character. */
function isLangChar(c) {
  const k = c.charCodeAt(0);
  return (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || (k >= 48 && k <= 57) || c === '_' || c === '+' || c === '-';
}

/** A fence-open line's language, or null (not a fence open). */
function fenceOpenOf(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line[i])) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` is a fence-close line (three backticks, spaces/tabs after). */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null. */
function headingOf(line) {
  let n = 0;
  while (n < 6 && line.charCodeAt(n) === 35) n++;
  if (n === 0) return null;
  if (n === 6 && line.charCodeAt(6) === 35) return null; // 7 or more '#'
  // need at least one space or tab after the #'s
  let i = n;
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let e = line.length;
  while (e > i && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === i) return null;
  return { depth: n, text: line.slice(i, e) };
}

/** Whether `line` is a thematic break. No allocation: char checks only. */
function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * Whether `line` ends a paragraph: blank, fence, heading or thematic break.
 * One combined scan instead of four separate function calls per line, with exactly
 * the same decisions as isBlank / fenceOpenOf / headingOf / isHr make.
 */
function endsParagraph(line) {
  const n = line.length;
  if (n === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) {
    // Blank (all spaces/tabs) ends a paragraph; any other leading-space line does not.
    for (let i = 1; i < n; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
    // Fence open: language characters, then spaces/tabs only.
    let i = 3;
    while (i < n && isLangChar(line[i])) i++;
    while (i < n) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
      i++;
    }
    return true;
  }
  if (c0 === 35) {
    // Heading: 1-6 #'s (not 7+), a space/tab, then non-blank text.
    let k = 0;
    while (k < 6 && line.charCodeAt(k) === 35) k++;
    if (k === 0) return false;
    if (k === 6 && line.charCodeAt(6) === 35) return false;
    if (k >= n) return false;
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
    let i = k;
    while (i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
    let e = n;
    while (e > i && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
    return e !== i;
  }
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** A paragraph line as rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is a list continuation: 2+ spaces then a non-whitespace char. */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !isWS(line.charCodeAt(j));
}

/** A bullet list line's item text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered list line's { start, text }, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < 9 && i < line.length) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null; // '.' then ' '
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** `src`'s block tokens, in order. */
function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    // Dispatch on the first character: most lines are plain paragraph lines, and
    // each block kind has a distinct opener, so one check replaces the chain of
    // per-line classifier calls the straightforward version makes.
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1 || c0 === 32 || c0 === 9) {
      // Blank lines (all spaces/tabs, or empty) are skipped; any other
      // leading-space line is a paragraph line.
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpenOf(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        tokens.push({ type: 'code', lang, lines: body });
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        tokens.push({ type: 'hr' });
        i++;
        continue;
      }
      // Otherwise it may still be a bullet item; fall through to the list check.
    } else if (c0 === 62) {
      // blockquote: lines opening on '>'
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        body.push(l);
      }
      const out = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') out.push(t);
      }
      tokens.push({ type: 'blockquote', lines: out });
      continue;
    }
    const b = c0 === 45 || c0 === 42 ? bulletOf(line) : null;
    const o = b === null && c0 >= 48 && c0 <= 57 ? orderedOf(line) : null;
    if (b !== null || o !== null) {
      const isOrdered = o !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(l);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start: isOrdered ? o.start : 1, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

// --- inline rendering -------------------------------------------------------

// The characters inline scanning stops at: backslash, backtick, *, [ and the HTML specials.
const INLINE_RE = /[\\`*\[]|[&<>"']/g;

/** The number of consecutive backslashes immediately before index `j` in `s`. */
function backslashesBefore(s, j) {
  let k = 0;
  while (j - 1 - k >= 0 && s.charCodeAt(j - 1 - k) === 92) k++;
  return k;
}

/** The first index from `from` (below `to`) where `s` holds `**` outside a backslash escape, or -1. */
function findUnescapedStrong(s, from, to) {
  let j = s.indexOf('**', from);
  while (j !== -1 && j + 1 < to) {
    if (backslashesBefore(s, j) % 2 === 0) return j;
    j = s.indexOf('**', j + 1);
  }
  return -1;
}

/** The first index from `from` (below `to`) where `s` holds `]` outside a backslash escape, or -1. */
function findUnescapedBracket(s, from, to) {
  let j = s.indexOf(']', from);
  while (j !== -1 && j < to) {
    if (backslashesBefore(s, j) % 2 === 0) return j;
    j = s.indexOf(']', j + 1);
  }
  return -1;
}

/** The first single * from `from` (below `to`, one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, to) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < to) {
    if (backslashesBefore(s, j) % 2 === 1) {
      // an escaped star: skipped on its own, the next star starts a fresh run
      j = s.indexOf('*', j + 1);
      continue;
    }
    // the run of stars starting at j, counted inside the range: pairs are consumed
    // left to right, so an odd run leaves its last star single and an even run leaves none
    let k = j;
    while (k + 1 < to && s.charCodeAt(k + 1) === 42) k++;
    if ((k - j + 1) % 2 === 1) return k;
    j = s.indexOf('*', k + 1);
  }
  return -1;
}

/**
 * `s` rendered inline over [from, to); `env.link(target)` is a link's href.
 * Range-based: strong/em/link contents are rendered in place, never sliced out
 * and re-scanned as new strings, so nested markup costs no extra allocation.
 */
function inline(s, env, from = 0, to = s.length) {
  INLINE_RE.lastIndex = from;
  let m = INLINE_RE.exec(s);
  if (m === null || m.index >= to) return from === 0 && to === s.length ? s : s.slice(from, to);
  const out = [];
  let seg = from; // start of the current unflushed plain segment
  let scan = from; // where the special-character scan continues
  while (true) {
    const j = m.index;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < to && ESCAPABLE.has(s[j + 1])) {
        if (j > seg) out.push(s.slice(seg, j));
        out.push(s[j + 1]);
        seg = j + 2;
        scan = j + 2;
      } else {
        scan = j + 1; // a lone backslash is itself; it stays in the segment
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < to && k > j + 1) {
        if (j > seg) out.push(s.slice(seg, j));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        seg = k + 1;
        scan = k + 1;
      } else {
        scan = j + 1; // no closer: the backtick is itself
      }
    } else if (c === '*') {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescapedStrong(s, j + 2, to);
        if (k !== -1 && k > j + 2) {
          if (j > seg) out.push(s.slice(seg, j));
          out.push('<strong>', inline(s, env, j + 2, k), '</strong>');
          seg = k + 2;
          scan = k + 2;
        } else {
          scan = j + 2; // no closer: '**' is itself
        }
      } else {
        const k = findSingleStar(s, j + 1, to);
        if (k !== -1 && k > j + 1) {
          if (j > seg) out.push(s.slice(seg, j));
          out.push('<em>', inline(s, env, j + 1, k), '</em>');
          seg = k + 1;
          scan = k + 1;
        } else {
          scan = j + 1; // no closer: '*' is itself
        }
      }
    } else if (c === '[') {
      const k = findUnescapedBracket(s, j + 1, to);
      const hasParen = k !== -1 && s.charCodeAt(k + 1) === 40;
      const close = hasParen ? s.indexOf(')', k + 2) : -1;
      const target = close === -1 || close >= to ? '' : s.slice(k + 2, close);
      if (target !== '' && !/\s/.test(target)) {
        if (j > seg) out.push(s.slice(seg, j));
        out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s, env, j + 1, k), '</a>');
        seg = close + 1;
        scan = close + 1;
      } else {
        scan = j + 1; // not a link: '[' is itself
      }
    } else {
      // an HTML special: & < > " '
      if (j > seg) out.push(s.slice(seg, j));
      out.push(ESC_ENT[c]);
      seg = j + 1;
      scan = j + 1;
    }
    INLINE_RE.lastIndex = scan;
    m = INLINE_RE.exec(s);
    if (m === null || m.index >= to) break;
  }
  if (seg < to) out.push(s.slice(seg, to));
  return out.join('');
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        const parts = [];
        for (let k = 0; k < t.lines.length; k++) {
          parts.push(escapeHtml(t.lines[k]));
          parts.push('\n');
        }
        blocks.push(`<pre><code${cls}>${parts.join('')}</code></pre>`);
        break;
      }
      case 'hr':
        blocks.push('<hr>');
        break;
      case 'blockquote':
        blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`);
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        let items = '';
        for (let k = 0; k < t.items.length; k++) items += `<li>${inline(t.items[k], env)}</li>\n`;
        blocks.push(`${open}\n${items}</${tag}>`);
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        break;
      }
    }
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` from `a` to `b` is spaces and tabs only. */
function onlySpaceTab(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = onlySpaceTab(src, lineStart, open) && onlySpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** `lookup` specialised by path length, for the compiled templates. */
function lk1(sc, a) {
  while (sc !== null && !Object.hasOwn(sc.vars, a)) sc = sc.parent;
  return sc === null ? undefined : sc.vars[a];
}
function lk2(sc, a, b) {
  while (sc !== null && !Object.hasOwn(sc.vars, a)) sc = sc.parent;
  if (sc === null) return undefined;
  const v = sc.vars[a];
  return v !== null && typeof v === 'object' && Object.hasOwn(v, b) ? v[b] : undefined;
}
function lk3(sc, a, b, c) {
  while (sc !== null && !Object.hasOwn(sc.vars, a)) sc = sc.parent;
  if (sc === null) return undefined;
  let v = sc.vars[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  v = v[b];
  return v !== null && typeof v === 'object' && Object.hasOwn(v, c) ? v[c] : undefined;
}
function lkN(sc, path) {
  return lookup(sc, path);
}

// --- compiled templates -----------------------------------------------------
// Each parsed template is compiled once per case into a function
// (sc, depth, out) that pushes its output into `out`. The generated code mirrors
// renderNodes node for node, so the two agree exactly; if compiling fails for any
// reason the interpreter below is used instead.

/** The lookup expression for `path` from scope variable `scVar`. */
function lkExpr(path, scVar, longPaths) {
  if (path.length === 1) return `lk1(${scVar},${JSON.stringify(path[0])})`;
  if (path.length === 2) return `lk2(${scVar},${JSON.stringify(path[0])},${JSON.stringify(path[1])})`;
  if (path.length === 3) return `lk3(${scVar},${JSON.stringify(path[0])},${JSON.stringify(path[1])},${JSON.stringify(path[2])})`;
  const key = JSON.stringify(path);
  let id = longPaths.get(key);
  if (id === undefined) {
    id = `_p${longPaths.size}`;
    longPaths.set(key, id);
  }
  return `lkN(${scVar},${id})`;
}

/** JavaScript source for `nodes` rendered in scope variable `scVar`. */
function genNodes(nodes, scVar, st) {
  let src = '';
  for (const n of nodes) {
    if (n.kind === 'text') {
      src += `out.push(${JSON.stringify(n.text)});`;
    } else if (n.kind === 'var') {
      src += `out.push(esc(txt(${lkExpr(n.path, scVar, st.longPaths)})));`;
    } else if (n.kind === 'raw') {
      src += `out.push(txt(${lkExpr(n.path, scVar, st.longPaths)}));`;
    } else if (n.kind === 'if') {
      src += `if (${n.not ? '!' : ''}truthy(${lkExpr(n.path, scVar, st.longPaths)})){${genNodes(n.then, scVar, st)}}`;
      if (n.else !== null) src += `else{${genNodes(n.else, scVar, st)}}`;
    } else if (n.kind === 'for') {
      const u = st.uid++;
      const xs = `_x${u}`;
      const lp = `_l${u}`;
      const k = `_k${u}`;
      const sc2 = `_s${u}`;
      // One scope object per for-loop, reused across iterations: the loop variable
      // is reassigned each round and `loop` is set after it, exactly as the
      // per-iteration object literal `{ [name]: item, loop }` resolves (loop wins
      // when the loop variable itself is named "loop").
      src += `{const ${xs}=${lkExpr(n.path, scVar, st.longPaths)};if(Array.isArray(${xs})){const ${lp}={index:0,first:false,last:false,length:${xs}.length};const ${sc2}={vars:{},parent:${scVar}};for(let ${k}=0;${k}<${xs}.length;${k}++){${lp}.index=${k}+1;${lp}.first=${k}===0;${lp}.last=${k}===${xs}.length-1;${sc2}.vars[${JSON.stringify(n.name)}]=${xs}[${k}];${sc2}.vars.loop=${lp};${genNodes(n.body, sc2, st)}}}}`;
    } else if (n.kind === 'include') {
      // A template that did not parse (or does not exist) renders nothing, and the
      // set of templates is fixed for the case, so this is resolved at compile time.
      const fnId = st.idOf.get(n.name);
      if (fnId !== undefined) src += `if(depth<${INCLUDE_DEPTH})${fnId}(${scVar},depth+1,out);`;
    }
  }
  return src;
}

/**
 * `parsed` (a Map of name to nodes) compiled to a plain object of name to function,
 * or null when compiling is unavailable. All of a case's templates are compiled as
 * inner functions of one outer function, so they share the lookup helpers by closure
 * and includes are direct calls: each function is (sc, depth, out).
 */
function compileTemplates(parsed) {
  try {
    const names = [...parsed.keys()];
    const idOf = new Map(names.map((n, i) => [n, `_t${i}`]));
    let body = '"use strict";';
    for (const [name, nodes] of parsed) {
      const st = { uid: 0, longPaths: new Map(), idOf };
      let pre = '';
      const fnBody = genNodes(nodes, 'sc', st);
      for (const [key, id] of st.longPaths) pre += `const ${id}=${key};`;
      body += `function ${idOf.get(name)}(sc,depth,out){${pre}${fnBody}}`;
    }
    body += 'return {';
    body += names.map((n) => `${JSON.stringify(n)}:${idOf.get(n)}`).join(',');
    body += '};';
    const outer = new Function('lk1', 'lk2', 'lk3', 'lkN', 'truthy', 'txt', 'esc', body);
    return outer(lk1, lk2, lk3, lkN, truthy, textOf, escapeHtml);
  } catch {
    return null;
  }
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const INCLUDE_DEPTH = 8;

/** `nodes` rendered into `out` in `scope` ({ vars, parent }). `ctx` holds the parsed templates and the include depth. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const loop = { index: 0, first: false, last: false, length: xs.length };
        // One scope object per for-loop, reused across iterations (see genNodes).
        const child = { vars: {}, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          child.vars[n.name] = xs[k];
          child.vars.loop = loop;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** One site's output tree: path -> text. */
function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content;
      sources.push({ path: f.path, text: content.indexOf('\r') === -1 ? content : content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, links resolved.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, pages, layouts.
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(kept.map((s) => [s, cardOf(s)]));
  const pageOf = (s) => {
    const card = cards.get(s);
    return {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc, // already { level, id, html } per heading: no copy needed
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // `site`, `tags` and `recent` are the same for every render of this case, so they
  // live in one shared parent scope instead of being spread into each render's vars.
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const compiled = compileTemplates(templates);
  const ctx = { templates };
  const output = {};
  // One scope object and one output array reused for every render of this case:
  // rendering is synchronous, so nothing observes them between renders.
  const scope = { vars: null, parent: baseScope };
  const out = [];
  const render = (name, vars) => {
    scope.vars = vars;
    out.length = 0;
    if (compiled !== null) {
      const fn = compiled[name];
      if (fn === undefined) return null;
      fn(scope, 0, out);
    } else {
      const nodes = templates.get(name);
      if (nodes === undefined) return null;
      renderNodes(nodes, scope, ctx, 0, out);
    }
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  slugMemo = new Map();
  dateMemo = new Map();
  try {
    return build(input);
  } finally {
    slugMemo = null;
    dateMemo = null;
  }
}
