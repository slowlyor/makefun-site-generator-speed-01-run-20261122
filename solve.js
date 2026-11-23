// solve.js — a fast, dependency-free drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns
// for the same input, byte for byte: each page's index.html, the index and tag
// pages, build-report.txt and each static file. The semantics are makefun-site's
// own (front matter, template dialect, Markdown subset, slug rule, report);
// this file re-implements them with fast, hand-rolled scanners instead of the
// reference's per-line regexes and per-character escaping, and with no
// intermediate token objects. Stdlib only, deterministic, no network, no clock.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ------------------------------------------------------------------ text

/** Single-character HTML escapes, indexed by char code (escapable chars are ASCII). */
const ESC1 = new Array(128);
for (let c = 0; c < 128; c++) ESC1[c] = String.fromCharCode(c);
ESC1[38] = '&amp;';
ESC1[60] = '&lt;';
ESC1[62] = '&gt;';
ESC1[34] = '&quot;';
ESC1[39] = '&#39;';

const HAS_SPECIAL = /[&<>"']/;

/** `text` with & < > " and ' escaped. Fast path when nothing needs escaping. */
export function escapeHtml(text) {
  if (!HAS_SPECIAL.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let e = null;
    if (c === 38) e = '&amp;';
    else if (c === 60) e = '&lt;';
    else if (c === 62) e = '&gt;';
    else if (c === 34) e = '&quot;';
    else if (c === 39) e = '&#39;';
    if (e !== null) {
      out += text.slice(start, i);
      out += e;
      start = i + 1;
    }
  }
  return out + text.slice(start);
}

/** The slug of `text`, makefun-site's rule. ASCII fast path; Unicode falls back. */
export function slugify(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    else if (c > 127) return slugifyUnicode(text);
    else {
      gap = out.length > 0;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  let end = out.length > SLUG_MAX ? SLUG_MAX : out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** Slug of `text` through NFKD + combining-mark removal (the non-ASCII path). */
function slugifyUnicode(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
export function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether char code `c` is JavaScript whitespace (the \s class). */
function isWS(c) {
  if (c > 32 && c < 160) return false;
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  return (
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 32 && c < 160) {
      if (!inWord) {
        inWord = true;
        n++;
      }
      continue;
    }
    if (isWS(c)) {
      inWord = false;
      continue;
    }
    if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
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
      if (ok) {
        for (let k = 0; k < 10; k++) {
          if (k === 4 || k === 7) continue;
          const c = raw.charCodeAt(k);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        y = +raw.slice(0, 4);
        mo = +raw.slice(5, 7);
        d = +raw.slice(8, 10);
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93)
        return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1)
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let k = 0; k < raw.length && ok; k++) {
        const c = raw.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length >= 1 && raw.length <= 64;
      let prevDash = true;
      for (let k = 0; k < raw.length && ok; k++) {
        const c = raw.charCodeAt(k);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else if (c === 45 && !prevDash) prevDash = true;
        else ok = false;
      }
      if (prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Scanned by line offsets, so
 * the body is one slice, never split and re-joined.
 */
function parseFrontMatter(text) {
  const n = text.length;
  let e = text.indexOf('\n', 0);
  if (e === -1) e = n;
  if (text.slice(0, e) !== '---') return { error: 'no front matter' };
  let p = e + 1;
  const data = {};
  let lineno = 1;
  while (true) {
    if (p > n) return { error: 'the front matter is not closed' };
    e = text.indexOf('\n', p);
    if (e === -1) e = n;
    const line = text.slice(p, e);
    lineno++;
    if (line === '---') {
      const body = e === n ? '' : text.slice(e + 1);
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body };
    }
    // Blank (spaces and tabs only) or a comment: skip.
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      const ci = line.indexOf(':');
      if (ci === -1) return { error: `line ${lineno} is not "key: value"` };
      const key = line.slice(0, ci);
      let okKey = key.length > 0;
      for (let k = 0; k < key.length && okKey; k++) {
        const c = key.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || c === 95)) okKey = false;
      }
      if (!okKey) return { error: `line ${lineno} is not "key: value"` };
      let raw;
      if (ci === line.length - 1) raw = '';
      else if (line.charCodeAt(ci + 1) === 32) raw = line.slice(ci + 2);
      else return { error: `line ${lineno} is not "key: value"` };
      let re = raw.length;
      while (re > 0) {
        const c = raw.charCodeAt(re - 1);
        if (c === 32 || c === 9) re--;
        else break;
      }
      raw = raw.slice(0, re);
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = e + 1;
  }
}

// --------------------------------------------------------------- markdown

/** A line of spaces and tabs only (or empty). */
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line: "```" + optional language, spaces/tabs after. The language, or null. */
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

/** A fence-close line: "```" then spaces or tabs only. */
function isFenceClose(line) {
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
  let s = k;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: k, text: line.slice(s, e) };
}

/** A thematic break: "---" or "***", then spaces or tabs only. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text ("- " or "* " + rest), or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { text: line.slice(2) };
  return null;
}

/** An ordered item's number and text ("12. " + rest), or null. */
function orderedOf(line) {
  let k = 0;
  while (k < line.length && k < 9) {
    const c = line.charCodeAt(k);
    if (c < 48 || c > 57) break;
    k++;
  }
  if (k === 0) return null;
  if (line.charCodeAt(k) !== 46 || line.charCodeAt(k + 1) !== 32) return null;
  return { num: line.slice(0, k), text: line.slice(k + 2) };
}

/** A list continuation: two or more spaces, then a non-space character. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let k = 2;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k >= line.length) return false;
  return !isWS(line.charCodeAt(k));
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The characters a backslash escapes, by char code. */
const ESCAPABLE = new Set([92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s.charCodeAt(j + 1))) {
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
    if (c === 92 && j + 1 < s.length && ESCAPABLE.has(s.charCodeAt(j + 1))) {
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

/** Whether `s` holds any whitespace character. */
function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) if (isWS(s.charCodeAt(i))) return true;
  return false;
}

/** Inline specials and the HTML-escape characters, in one scan. */
const INLINE_RE = /[[\\`*&<>"']/g;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  const n = s.length;
  let i = 0;
  while (i < n) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    const j = m === null ? n : m.index;
    if (j > i) {
      // The run holds no special or HTML-escape character: it goes out raw.
      out += s.slice(i, j);
      i = j;
      if (i >= n) break;
    }
    const c = s.charCodeAt(i);
    if (c === 38) {
      out += '&amp;';
      i++;
      continue;
    }
    if (c === 60) {
      out += '&lt;';
      i++;
      continue;
    }
    if (c === 62) {
      out += '&gt;';
      i++;
      continue;
    }
    if (c === 34) {
      out += '&quot;';
      i++;
      continue;
    }
    if (c === 39) {
      out += '&#39;';
      i++;
      continue;
    }
    if (c === 92) {
      // Backslash: an escapable character after it is written (escaped); else the backslash itself.
      if (i + 1 < n && ESCAPABLE.has(s.charCodeAt(i + 1))) {
        out += ESC1[s.charCodeAt(i + 1)];
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out += '<code>' + escapeHtml(s.slice(i + 1, k)) + '</code>';
        i = k + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out += '<strong>' + inline(s.slice(i + 2, k), env) + '</strong>';
          i = k + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) {
          out += '<em>' + inline(s.slice(i + 1, k), env) + '</em>';
          i = k + 1;
        } else {
          out += '*';
          i++;
        }
      }
      continue;
    }
    // '[': a link, or itself.
    const k = findUnescaped(s, ']', i + 1);
    const m2 = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !hasWhitespace(target)) {
      out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
      i = m2 + 1;
    } else {
      out += '[';
      i++;
    }
  }
  return out;
}

/** A list block starting at `lines[i]` (already matched: `first` is its first item), rendered; `next` is the line after the list. */
function listBlock(lines, i, isOrdered, first, env) {
  const items = [[trimLine(first.text)]];
  let start = 1;
  if (isOrdered) start = Number(first.num);
  i++;
  const L = lines.length;
  while (i < L) {
    const li = lines[i];
    if (isOrdered) {
      const m = orderedOf(li);
      if (m !== null) {
        items.push([trimLine(m.text)]);
        i++;
        continue;
      }
    } else {
      const m = bulletOf(li);
      if (m !== null) {
        items.push([trimLine(m.text)]);
        i++;
        continue;
      }
    }
    if (isContinued(li)) {
      items[items.length - 1].push(trimLine(li));
      i++;
      continue;
    }
    break;
  }
  const tag = isOrdered ? 'ol' : 'ul';
  let s = isOrdered && start !== 1 ? '<ol start="' + start + '">\n' : '<' + tag + '>\n';
  for (const it of items) s += '<li>' + inline(it.join('\n'), env) + '</li>\n';
  s += '</' + tag + '>\n';
  return { html: s, next: i };
}

/**
 * `src` rendered, in one pass over its lines (no token objects): its HTML (each
 * block on its own lines, a "\n" after the last), its table of contents (every
 * level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the
 * first paragraph's inline HTML, or ""). Blocks are dispatched on the line's
 * first character, so a plain text line takes no block test at all.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // A line opening on a space or tab is a paragraph line.
    } else if (c0 === 96) {
      const fence = fenceOpen(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < L && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        let code = '<pre><code';
        if (fence !== '') code += ' class="language-' + escapeHtml(fence) + '"';
        code += '>';
        for (const l of body) code += escapeHtml(l) + '\n';
        out.push(code + '</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text), ids);
        const html = inline(hd.text, env);
        out.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>\n');
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const b = bulletOf(line);
      if (b !== null) {
        const lb = listBlock(lines, i, false, b, env);
        out.push(lb.html);
        i = lb.next;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push('<blockquote>\n<p>' + inline(kept.join('\n'), env) + '</p>\n</blockquote>\n');
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedOf(line);
      if (o !== null) {
        const lb = listBlock(lines, i, true, o, env);
        out.push(lb.html);
        i = lb.next;
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a fence,
    // a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < L) {
      const l2 = lines[i];
      if (l2.length === 0) break;
      const d0 = l2.charCodeAt(0);
      if (d0 === 32 || d0 === 9) {
        if (isBlank(l2)) break;
      } else if (d0 === 96) {
        if (fenceOpen(l2) !== null) break;
      } else if (d0 === 35) {
        if (headingOf(l2) !== null) break;
      } else if (d0 === 45 || d0 === 42) {
        if (isHr(l2)) break;
      }
      body.push(trimLine(l2));
      i++;
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    out.push('<p>' + html + '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// --------------------------------------------------------------- templates

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
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
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
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
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if'))
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
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
 * Compile a parsed template's node tree into a render function
 * (scope, ctx, depth, lookup, textOf, escape, truthy) => string. Code is
 * generated from the parsed AST only: text is JSON-encoded and paths are
 * validated name arrays, so nothing from a template's raw source reaches the
 * generated code unescaped. A `for` saves and restores the scope variable, so
 * nested loops and includes in the same scope behave exactly like the
 * tree-walking renderer; an include calls the compiled function of the
 * included template with the same scope and one more depth.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const gen = (ns, out) => {
    for (const n of ns) {
      switch (n.kind) {
        case 'text':
          out.push('O+=' + JSON.stringify(n.text) + ';');
          break;
        case 'var':
          out.push('O+=E(T(L(S,' + JSON.stringify(n.path) + ')));');
          break;
        case 'raw':
          out.push('O+=T(L(S,' + JSON.stringify(n.path) + '));');
          break;
        case 'if': {
          out.push('if(Y(L(S,' + JSON.stringify(n.path) + '))!==' + (n.not ? 'true' : 'false') + '){');
          gen(n.then, out);
          if (n.else !== null) {
            out.push('}else{');
            gen(n.else, out);
          }
          out.push('}');
          break;
        }
        case 'for': {
          const u = uid++;
          out.push(
            'const __a' + u + '=L(S,' + JSON.stringify(n.path) + ');' +
              'if(Array.isArray(__a' + u + ')){' +
              'for(let __k' + u + '=0;__k' + u + '<__a' + u + '.length;__k' + u + '++){' +
              'const __s' + u + '=S;' +
              'S={vars:{[' + JSON.stringify(n.name) + ']:__a' + u + '[__k' + u + '],loop:{index:__k' + u + '+1,first:__k' + u + '===0,last:__k' + u + '===__a' + u + '.length-1,length:__a' + u + '.length}},parent:S};'
          );
          gen(n.body, out);
          out.push('S=__s' + u + ';}}');
          break;
        }
        case 'include': {
          const u = uid++;
          out.push(
            'if(D<' + INCLUDE_DEPTH + '){const __t' + u + '=C.templates.get(' + JSON.stringify(n.name) + ');' +
              'if(__t' + u + '!==undefined)O+=I(__t' + u + ',S,C,D+1);}'
          );
          break;
        }
      }
    }
  };
  const parts = ['let O="";'];
  gen(nodes, parts);
  parts.push('return O;');
  return new Function('S', 'C', 'D', 'L', 'T', 'E', 'Y', 'I', parts.join(''));
}

/** Render an included template `t` (a compiled function, or a node tree when compilation failed) in `scope` at `depth`. */
function includeRender(t, scope, ctx, depth) {
  if (typeof t === 'function') return t(scope, ctx, depth, lookup, textOf, escapeHtml, truthy, includeRender);
  const out = [];
  renderNodes(t, scope, ctx, depth, out);
  return out.join('');
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
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
        for (let k = 0; k < xs.length; k++) {
          const vars = {
            [n.name]: xs[k],
            loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length },
          };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out.push(includeRender(t, scope, ctx, depth + 1));
        break;
      }
    }
  }
}

// ------------------------------------------------------------------- build

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
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

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
function build(input) {
  // Templates, parsed in code-unit order of their names and compiled to render
  // functions; one that does not parse is reported and left out, as if it were
  // not there. A template whose compilation fails keeps its node tree and is
  // rendered by the tree walker instead.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      let fn = null;
      try {
        fn = compileTemplate(nodes);
      } catch (e) {
        fn = null;
      }
      templates.set(name, fn ?? nodes);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order; a refused source is reported and dropped.
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
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
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
  sources.length = 0;
  for (const s of kept) sources.push(s);

  // Permalinks: each page's slug, unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
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

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
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

  // Collections: the posts, newest date first, equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met walking the posts in
  // collection order; ordered by count of posts, most first, then by slug.
  const slugCache = new Map();
  const cachedSlugify = (name) => {
    let s = slugCache.get(name);
    if (s === undefined) {
      s = slugify(name);
      slugCache.set(name, s);
    }
    return s;
  };
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = cachedSlugify(name);
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
      const slug = cachedSlugify(name);
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
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = cachedSlugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // What templates see.
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cards = new Map();
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
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml };
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    if (typeof t === 'function') return t(scope, ctx, 0, lookup, textOf, escapeHtml, truthy, includeRender);
    const out = [];
    renderNodes(t, scope, ctx, 0, out);
    return out.join('');
  };

  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
