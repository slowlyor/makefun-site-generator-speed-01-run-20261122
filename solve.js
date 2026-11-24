// A faster drop-in for makefun-site 1.0.0: the same static sites, byte for byte, in less CPU time.
//
// run(input) returns, for one case's input { site, templates, files }, exactly the output tree
// makefun-site 1.0.0's build returns: a JSON object of every path it writes and that file's text.
// The build is done in one pass per case: sources are sorted once, front matter is parsed with a
// hand scanner, Markdown is lexed and rendered in a single walk with no token objects, templates
// are parsed once per case set (cached by name + source text) and rendered by a tree walker that
// reuses the case-level scope, and per-page work that repeats (slug tables, word counts) is kept
// to the minimum the output needs. Deterministic, stdlib only, no I/O, no clock, no randomness.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** One replacer for every escapeHtml call, instead of a fresh closure per replace. */
const escapeReplacer = (c) => ESCAPES[c];

/** `text` with & < > " and ' escaped; the common no-escapable case returns the input untouched. */
function escapeHtml(text) {
  if (!/[&<>"']/.test(text)) return text;
  return text.replace(/[&<>"']/g, escapeReplacer);
}

/** The slug of `text`, memoised: titles and tag names repeat across a case's sources. */
const slugCache = new Map();
const NON_ASCII = /[^\x00-\x7F]/;
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  // NFKD never changes a pure-ASCII string and there are no marks to strip in one, so skip the
  // normalise + mark-strip scans for it; the index loop below is also cheaper than for...of.
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  if (rel.indexOf('/') === -1) {
    // One segment: no split needed — a plain name joins, "." and "" stay, ".." pops once.
    if (rel === '' || rel === '.') return dir;
    if (rel === '..') {
      if (dir === '') return null;
      const k = dir.lastIndexOf('/');
      return k === -1 ? '' : dir.slice(0, k);
    }
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** The words of a body: its runs of characters other than whitespace (the JS \s set, exactly). */
const EXOTIC_WS = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\v\f]/;
function wordsOfExact(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws =
      c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xa0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
      c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}
function wordsOf(text) {
  // Generated bodies hold no exotic whitespace; the one native scan proves it, and the tight loop
  // then only tests the four ASCII whitespace characters. Anything exotic falls back to the exact loop.
  if (EXOTIC_WS.test(text)) return wordsOfExact(text);
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const KEY_SET = new Set(KEYS);

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isNameChar(c) {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) if (!isNameChar(raw.charCodeAt(i))) return { error: 'key "layout": not a template name' };
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  if (text === '---') return { error: 'the front matter is not closed' };
  if (!text.startsWith('---\n')) return { error: 'no front matter' };
  let cp = text.indexOf('\n---\n', 3);
  let bodyStart;
  if (cp !== -1) bodyStart = cp + 5;
  else if (text.endsWith('\n---')) {
    cp = text.length - 4;
    bodyStart = text.length;
  } else return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, cp);
  const data = {};
  if (fmText !== '') {
    const lines = fmText.split('\n');
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      if (isBlank(line) || line.charCodeAt(0) === 35) continue;
      // ^([a-z_]+):(?: (.*))?$
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${j + 2} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) {
        raw = line.slice(k + 2);
        let e = raw.length;
        while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
        raw = raw.slice(0, e);
      } else return { error: `line ${j + 2} is not "key: value"` };
      if (!KEY_SET.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

/** Whether `c` (a char code) is one a backslash escapes. */
function isEscapable(c) {
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 || c === 41 || c === 35 ||
    c === 43 || c === 45 || c === 46 || c === 33 || c === 62
  );
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Any character inline rendering treats specially: a markup opener, a backslash, or an HTML-special. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/;
// One shared scanner for inlineInto: its lastIndex is reset before every exec, so the recursion into
// strong, emphasis and link spans (which resets it for its own string) cannot disturb the caller's
// place — the caller sets lastIndex again before its next exec.
const INLINE_NEXT = /[\\`*\[&<>"']/g;

/** `s` rendered inline into `out` (an array of string pieces); `env.link(target)` is a link's href. */
function inlineInto(s, env, out) {
  // The exec loop renders a run with no special character at all as itself: the first exec finds
  // nothing, so the whole string is pushed unchanged — no separate pre-test is needed here.
  const next = INLINE_NEXT;
  next.lastIndex = 0;
  let i = 0;
  let m = next.exec(s);
  while (m !== null) {
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    i = j;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < s.length && isEscapable(s.charCodeAt(i + 1))) {
        const nc = s[i + 1];
        out.push(nc === '>' ? '&gt;' : nc);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
    } else if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
    } else if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out.push('<strong>');
          inlineInto(s.slice(i + 2, k), env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) {
          out.push('<em>');
          inlineInto(s.slice(i + 1, k), env, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i++;
        }
      }
    } else if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineInto(s.slice(i + 1, k), env, out);
        out.push('</a>');
        i = mm + 1;
      } else {
        out.push('[');
        i++;
      }
    } else {
      // One of & < > " '.
      out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
      i++;
    }
    next.lastIndex = i;
    m = next.exec(s);
  }
  if (i < s.length) out.push(s.slice(i));
}
/** `s` rendered inline; `env.link(target)` is a link's href. */
function inlineStr(s, env) {
  // The common no-markup case returns the string itself, untouched and unallocated.
  if (!INLINE_SPECIAL.test(s)) return s;
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence-open line's language, or null when the line is no fence open. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) k++;
    else break;
  }
  const lang = line.slice(3, k);
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
    k++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  if (k >= line.length) return null;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  let a = k;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: k, text: line.slice(a, b) };
}

/**
 * `line`'s block kind in one scan — 1 blank, 2 fence-open, 3 heading, 4 thematic break, 0 anything
 * else — exactly matching isBlank / fenceOpen / headingOf / the thematic-break test, whose four
 * separate scans this replaces on every line the block loop and the paragraph-end test look at.
 */
function lineKind(line) {
  if (line.length === 0) return 1;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) {
    for (let k = 1; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) return 0;
    }
    return 1;
  }
  if (c0 === 96) {
    if (line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return 0;
    let k = 3;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) k++;
      else break;
    }
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) return 0;
      k++;
    }
    return 2;
  }
  if (c0 === 35) {
    let k = 0;
    while (k < line.length && line.charCodeAt(k) === 35) k++;
    if (k === 0 || k > 6 || k >= line.length) return 0;
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return 0;
    let a = k;
    while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
    let b = line.length;
    while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
    return b === a ? 0 : 3;
  }
  if (c0 === 45 || c0 === 42) {
    if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return 0;
    for (let k = 3; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) return 0;
    }
    return 4;
  }
  return 0;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return lineKind(line) !== 0;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space (the JS \s set). */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  const c = line.charCodeAt(k);
  return !(
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const kind = lineKind(line);
    if (kind === 1) {
      i++;
      continue;
    }
    if (kind === 2) {
      const lang = fenceOpen(line);
      i++;
      const body = [];
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push('<pre><code');
      if (lang !== '') blocks.push(' class="language-', escapeHtml(lang), '"');
      blocks.push('>');
      for (const l of body) {
        blocks.push(escapeHtml(l), '\n');
      }
      blocks.push('</code></pre>\n');
      continue;
    }
    if (kind === 3) {
      const heading = headingOf(line);
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (kind === 4) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>\n');
      else {
        // Render straight into the block pieces: no intermediate HTML string or array.
        const joined = kept.length === 1 ? kept[0] : kept.join('\n');
        blocks.push('<blockquote>\n<p>');
        inlineInto(joined, env, blocks);
        blocks.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    // A list: `- `, `* ` (a bullet list) or digits and `. ` (an ordered list).
    const c0 = line.charCodeAt(0);
    let ordered = false;
    let start = 1;
    let itemText = null;
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) itemText = line.slice(2);
    else {
      let k = 0;
      while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
      if (k >= 1 && k <= 9 && line.charCodeAt(k) === 46 && line.charCodeAt(k + 1) === 32) {
        ordered = true;
        start = Number(line.slice(0, k));
        itemText = line.slice(k + 2);
      }
    }
    if (itemText !== null) {
      const items = [[trimLine(itemText)]];
      i++;
      while (i < n) {
        const l = lines[i];
        let m2 = null;
        if (!ordered) {
          const d = l.charCodeAt(0);
          if ((d === 45 || d === 42) && l.charCodeAt(1) === 32) m2 = l.slice(2);
        } else {
          let k = 0;
          while (k < l.length && l.charCodeAt(k) >= 48 && l.charCodeAt(k) <= 57) k++;
          if (k >= 1 && k <= 9 && l.charCodeAt(k) === 46 && l.charCodeAt(k + 1) === 32) m2 = l.slice(k + 2);
        }
        if (m2 !== null) {
          items.push([trimLine(m2)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      blocks.push(ordered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
      for (const parts of items) {
        // Render straight into the block pieces: no intermediate HTML string or array.
        const joined = parts.length === 1 ? parts[0] : parts.join('\n');
        blocks.push('<li>');
        inlineInto(joined, env, blocks);
        blocks.push('</li>\n');
      }
      blocks.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const joined = body.length === 1 ? body[0] : body.join('\n');
    if (excerpt === null) {
      // The first paragraph's HTML is also the excerpt, so it still needs the string.
      excerpt = inlineStr(joined, env);
      blocks.push(`<p>${excerpt}</p>\n`);
    } else {
      blocks.push('<p>');
      inlineInto(joined, env, blocks);
      blocks.push('</p>\n');
    }
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` holds only spaces or tabs. */
function spacesOnly(s) {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
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
      const raw = src[open + 2] === '{';
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
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = spacesOnly(src.slice(lineStart, open)) && spacesOnly(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
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

/** Parsed templates, cached by name + source text across a case set: a template is parsed once. */
const templateCache = new Map();
function getTemplate(name, src) {
  const key = name + '\0' + src;
  let e = templateCache.get(key);
  if (e === undefined) {
    try {
      e = { nodes: parseTemplate(name, src) };
    } catch (err) {
      if (err instanceof TemplateError) e = { error: err.message };
      else throw err;
    }
    templateCache.set(key, e);
  }
  return e;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
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

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * For each template, the root names it reads from scopes outside itself, given the names bound at its
 * entry — only templates whose reads are all case-level names (site, tags, recent) are kept. A template
 * whose reads are all case-level renders the same on every page of a case, so its render can be cached.
 * `for` paths are read in the enclosing scope, loop variables and `loop` are bound inside the body,
 * includes render in the same scope (so the includer's bound names carry into them). Cycles return an
 * empty set for the re-entry: the visiting frame already counts that template's own reads, and bound
 * names only grow along a path, so a read external in the re-entry is external in the visiting frame too.
 */
function computeConstantReads(templates) {
  const CASE_LEVEL = new Set(['site', 'tags', 'recent']);
  const result = new Map();
  for (const name of templates.keys()) {
    const memo = new Map();
    const visiting = new Set();
    const readsOf = (nm, bound) => {
      const key = `${nm}\0${[...bound].sort().join(',')}`;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      if (visiting.has(key)) return new Set();
      const nodes = templates.get(nm);
      if (nodes === undefined) return new Set();
      visiting.add(key);
      const out = new Set();
      const walk = (list, b) => {
        for (const n of list) {
          if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
            if (!b.has(n.path[0])) out.add(n.path[0]);
            if (n.kind === 'if') {
              walk(n.then, b);
              if (n.else !== null) walk(n.else, b);
            }
          } else if (n.kind === 'for') {
            if (!b.has(n.path[0])) out.add(n.path[0]);
            const b2 = new Set(b);
            b2.add(n.name);
            b2.add('loop');
            walk(n.body, b2);
          } else if (n.kind === 'include') {
            for (const r of readsOf(n.name, b)) out.add(r);
          }
        }
      };
      walk(nodes, bound);
      visiting.delete(key);
      memo.set(key, out);
      return out;
    };
    const rs = readsOf(name, new Set());
    let ok = true;
    for (const r of rs) {
      if (!CASE_LEVEL.has(r)) {
        ok = false;
        break;
      }
    }
    if (ok) result.set(name, rs);
  }
  return result;
}

/**
 * `nodes` rendered into `out` in `scope` ({ vars, parent }). `templates` holds the parsed templates,
 * `depth` the include depth. `cx` carries the case's base scope, its constant templates (name to the
 * root names they read) and their render cache.
 */
function renderNodes(nodes, scope, templates, depth, out, cx) {
  for (const n of nodes) {
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
        if (branch !== null) renderNodes(branch, scope, templates, depth, out, cx);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope and one loop record for the whole loop, mutated per item: rendering is
        // synchronous, so nothing can observe an earlier item's values once the next is set.
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const vars = { loop };
        vars[n.name] = undefined;
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, templates, depth, out, cx);
        }
        break;
      }
      case 'include': {
        if (depth >= 8) break;
        const reads = cx.constant.get(n.name);
        if (reads !== undefined) {
          // A case-constant template, unless a scope above the base scope binds a name it reads.
          let shadowed = false;
          let s = scope;
          while (s !== null && s !== cx.base) {
            for (const r of reads) {
              if (Object.hasOwn(s.vars, r)) {
                shadowed = true;
                break;
              }
            }
            if (shadowed) break;
            s = s.parent;
          }
          if (s === null) shadowed = true;
          if (!shadowed) {
            const key = `${n.name}\0${depth}`;
            let html = cx.cache.get(key);
            if (html === undefined) {
              const tmp = [];
              renderNodes(templates.get(n.name), scope, templates, depth + 1, tmp, cx);
              html = tmp.join('');
              cx.cache.set(key, html);
            }
            out.push(html);
            break;
          }
        }
        const t = templates.get(n.name);
        if (t !== undefined) renderNodes(t, scope, templates, depth + 1, out, cx);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort()) {
    const e = getTemplate(name, input.templates[name]);
    if ('error' in e) report.push(e.error);
    else templates.set(name, e.nodes);
  }

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  // 2. Each source's front matter, in that order: a refused source is reported and dropped, and so is a draft.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (!f.path.endsWith('.md')) {
      statics.push(f);
      continue;
    }
    const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
    const fm = parseFrontMatter(text);
    if ('error' in fm) {
      report.push(`refused ${f.path}: ${fm.error}`);
      continue;
    }
    const post = f.path.startsWith('posts/');
    const own = f.path.startsWith('tags/') ? 'tags' : f.path.startsWith('page/') ? 'page' : null;
    if (own !== null) {
      report.push(`refused ${f.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (post && !Object.hasOwn(fm.data, 'date')) {
      report.push(`refused ${f.path}: a post needs a date`);
      continue;
    }
    const layout = fm.data.layout ?? (post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${f.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (fm.data.draft === true) {
      report.push(`draft ${f.path}`);
      continue;
    }
    sources.push({ path: f.path, body: fm.body, data: fm.data, post, layout });
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s.url);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path)}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${srcPath} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
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
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards: one per source, built once and shared by its page, the lists and the tag pages.
  for (const s of sources) s.card = cardOf(s);

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const cx = { base: baseScope, constant: computeConstantReads(templates), cache: new Map() };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: baseScope }, templates, 0, out, cx);
    return out.join('');
  };
  let pageCount = 0;
  for (const s of sources) {
    if (!s.post) pageCount++;
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
