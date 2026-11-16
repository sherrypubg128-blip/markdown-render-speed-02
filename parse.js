// LumenMark — a dependency-free Markdown renderer.
//
// parse(body) returns byte-for-byte the HTML that marked 18.1.3 emits
// with its stock settings (GFM on, breaks off, pedantic off, async off),
// only quicker. It is built as two cooperating passes over the source:
// a ln-oriented block pass that carves the document into paragraphs,
// headings, code, quotes, lists, tables and raw HTML, and a character
// scanner that turns the inline body of each block into HTML. Everything
// is written by hand for this task; there are no dependencies, no regular
// expressions on the hot path, and no state kept between calls, so every
// parse() is deterministic on its own.
//
// The file is arranged as:
//   A. character classification, HTML escaping, URL handling, entities
//   B. the inline engine (delimiter delimStack, code spans, links, autolinks)
//   C. the block engine (ln utilities, containers, lists, tables)
//   D. rendering and the exported parse() function.

const MISSING_CP = '�';

// ---------- A. characters, escaping, URLs ----------

/** ASCII whitespace: space, tab, LF, CR, FF, VT. */
function wsCode(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}

/** ASCII punctuation, per CommonMark's definition. */
function punctCode(code) {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

/** An ASCII letter or digit. */
function alphaNumCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** A `\w` word character: ASCII letter, digit, or underscore. */
function wordCode(code) {
  return alphaNumCode(code) || code === 95;
}

function decCode(code) {
  return code >= 48 && code <= 57;
}

function hexCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function hexDigitValue(code) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  return code - 87;
}

/**
 * Append src[from..to) to `chunks`, escaping the five HTML body
 * characters (& < > " ') as marked does. When nothing needs escaping
 * the whole slice goes in as one chunk.
 */
function appendEscaped(chunks, src, from, to) {
  let chunkStart = from;
  for (let p = from; p < to; p++) {
    const code = src.charCodeAt(p);
    let rep = null;
    if (code === 38) rep = '&amp;';
    else if (code === 60) rep = '&lt;';
    else if (code === 62) rep = '&gt;';
    else if (code === 34) rep = '&quot;';
    else if (code === 39) rep = '&#39;';
    if (rep !== null) {
      if (p > chunkStart) chunks.push(src.slice(chunkStart, p));
      chunks.push(rep);
      chunkStart = p + 1;
    }
  }
  if (to > chunkStart) chunks.push(src.slice(chunkStart, to));
}

/** Escape a whole string for HTML body output. */
function escapeHtmlText(src) {
  const chunks = [];
  appendEscaped(chunks, src, 0, src.length);
  return chunks.join('');
}

const utf8 = new TextEncoder();

/**
 * Percent-encode a link target the way marked does: like encodeURI,
 * then `&` is handled by the caller. encodeURI leaves the URL
 * characters `;,/?:@&=+$-_.!~*'()#` alone and encodes spaces, quotes,
 * angle brackets and non-ASCII as UTF-8 percent sequences. A `%` is
 * always left alone, valid escape or not.
 */
function encodeLinkUrl(url) {
  let built = '';
  let chunkStart = 0;
  for (let p = 0; p < url.length; p++) {
    const code = url.charCodeAt(p);
    // Characters encodeURI leaves alone.
    const keep =
      alphaNumCode(code) || code === 59 || code === 44 || code === 47 || code === 63 ||
      code === 58 || code === 64 || code === 38 || code === 61 || code === 43 ||
      code === 36 || code === 45 || code === 95 || code === 46 || code === 33 ||
      code === 126 || code === 42 || code === 39 || code === 40 || code === 41 ||
      code === 35;
    if (keep) continue;
    if (code === 37) continue; // '%' stays, whatever follows it.
    if (code < 128) {
      if (p > chunkStart) built += url.slice(chunkStart, p);
      built += '%' + code.toString(16).toUpperCase().padStart(2, '0');
      chunkStart = p + 1;
    } else {
      // Non-ASCII: percent-encode the whole UTF-8 form of this code point.
      if (p > chunkStart) built += url.slice(chunkStart, p);
      const cp = url.codePointAt(p);
      const wide = cp > 0xffff ? 1 : 0;
      const bytes = utf8.encode(String.fromCodePoint(cp));
      for (const b of bytes) built += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      p += wide;
      chunkStart = p + 1;
    }
  }
  if (chunkStart < url.length) built += url.slice(chunkStart);
  else if (chunkStart === 0) built = url;
  return built;
}

/**
 * The index just past a character reference beginning at `p` in `src`
 * (&name; or &#123; / &#x1F; with valid digit counts), or 0 when the
 * `&` does not start one.
 */
function refEndAt(src, p) {
  if (p + 1 >= src.length) return 0;
  const after = src.charCodeAt(p + 1);
  if (after === 35) {
    let qdx = p + 2;
    let hex = false;
    if (qdx < src.length && (src.charCodeAt(qdx) === 120 || src.charCodeAt(qdx) === 88)) {
      hex = true;
      qdx++;
    }
    const digitsStart = qdx;
    while (qdx < src.length && (hex ? hexCode(src.charCodeAt(qdx)) : decCode(src.charCodeAt(qdx)))) qdx++;
    const digits = qdx - digitsStart;
    if (digits === 0) return 0;
    if (hex ? digits > 6 : digits > 7) return 0;
    if (qdx >= src.length || src.charCodeAt(qdx) !== 59) return 0;
    return qdx + 1;
  }
  let qdx = p + 1;
  while (qdx < src.length && wordCode(src.charCodeAt(qdx))) qdx++;
  if (qdx === p + 1 || qdx >= src.length || src.charCodeAt(qdx) !== 59) return 0;
  return qdx + 1;
}

/** Escape `&` to `&amp;`, leaving character references untouched. */
function escapeAmpKeepRefs(src) {
  if (src.indexOf('&') === -1) return src;
  let built = '';
  let chunkStart = 0;
  for (let p = 0; p < src.length; p++) {
    if (src.charCodeAt(p) === 38) {
      const refEnd = refEndAt(src, p);
      if (refEnd > 0) {
        if (p > chunkStart) built += src.slice(chunkStart, p);
        built += src.slice(p, refEnd);
        p = refEnd - 1;
        chunkStart = refEnd;
        continue;
      }
      if (p > chunkStart) built += src.slice(chunkStart, p);
      built += '&amp;';
      chunkStart = p + 1;
    }
  }
  if (chunkStart < src.length) built += src.slice(chunkStart);
  return built;
}

/** Percent-encode a URL, then escape `&` except inside references. */
function escapeLinkUrl(url) {
  return escapeAmpKeepRefs(encodeLinkUrl(url));
}

/**
 * Escape a value for a double-quoted HTML attribute: the five body
 * characters, except an `&` that starts a character reference is left
 * as it is.
 */
function escapeAttrValue(src) {
  let built = '';
  let chunkStart = 0;
  for (let p = 0; p < src.length; p++) {
    const code = src.charCodeAt(p);
    if (code === 38) {
      const refEnd = refEndAt(src, p);
      if (refEnd > 0) {
        if (p > chunkStart) built += src.slice(chunkStart, p);
        built += src.slice(p, refEnd);
        p = refEnd - 1;
        chunkStart = refEnd;
        continue;
      }
    }
    if (code === 38 || code === 60 || code === 62 || code === 34 || code === 39) {
      if (p > chunkStart) built += src.slice(chunkStart, p);
      built += code === 38 ? '&amp;' : code === 60 ? '&lt;' : code === 62 ? '&gt;' : code === 34 ? '&quot;' : '&#39;';
      chunkStart = p + 1;
    }
  }
  if (chunkStart < src.length) built += src.slice(chunkStart);
  else if (chunkStart === 0) built = src;
  return built;
}

/** Decode a numeric reference body (the digits after `&#`). */
function decodeNumRef(digits, hex) {
  let cp = 0;
  if (hex) {
    for (let p = 0; p < digits.length; p++) {
      cp = cp * 16 + hexDigitValue(digits.charCodeAt(p));
      if (cp > 0x10ffff) return MISSING_CP;
    }
  } else {
    for (let p = 0; p < digits.length; p++) {
      cp = cp * 10 + (digits.charCodeAt(p) - 48);
      if (cp > 0x10ffff) return MISSING_CP;
    }
  }
  if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) {
    return MISSING_CP;
  }
  return String.fromCodePoint(cp);
}

// ---------- B. the inline engine ----------
//
// The inline scanner walks a body block once, left to right, appending
// HTML chunks. Emphasis and strikethrough ride on a delimiter delimStack:
// every delimiter run owns one chunk, and when a closer finds an opener
// the tags are spliced into those chunks (the opener's tag goes before
// tags already there, the closer's after), so nesting comes buf right.
// Link body is scanned in its own fresh scope, so delimiters never
// cross a link boundary — that is how marked behaves.

/** One emphasis / strikethrough delimiter run. */
function newRun(mark, size, mayOpen, mayClose, slot, at) {
  return { mark, size, mayOpen, mayClose, slot, head: '', live: true, at };
}

/** Unicode whitespace (CommonMark): Zs plus tab, LF, FF, CR. */
function unicodeWs(cp) {
  return cp === 9 || cp === 10 || cp === 12 || cp === 13 || cp === 32 ||
    cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x202f || cp === 0x205f || cp === 0x3000;
}

/** True for a Unicode punctuation (P) or symbol (S) character. */
const PUNCT_SYM = /[\p{P}\p{S}]/u;

// Marked quirk: an `<a href="...">` tag whose href value contains a
// newline suppresses extended autolinks (bare URLs, www., bare email)
// for the rest of the document — but not bracket links or angle
// autolinks. Reset per document in parse().
let extAutoBlocked = false;

function punctCodePoint(cp) {
  return PUNCT_SYM.test(String.fromCodePoint(cp));
}

/** Flanking facts for the delimiter run starting at `p` (length `size`). */
function flankInfo(src, p, size, end) {
  let prev = -1;
  let next = -1;
  if (p > 0) {
    const lo = src.charCodeAt(p - 1);
    if (lo >= 0xdc00 && lo <= 0xdfff && p >= 2) prev = src.codePointAt(p - 2);
    else prev = lo;
  }
  if (p + size < end) next = src.codePointAt(p + size);
  const prevWs = prev === -1 || unicodeWs(prev);
  const nextWs = next === -1 || unicodeWs(next);
  const prevPunct = prev !== -1 && punctCodePoint(prev);
  const nextPunct = next !== -1 && punctCodePoint(next);
  const leftFlank = !nextWs && (!nextPunct || prevWs || prevPunct);
  const rightFlank = !prevWs && (!prevPunct || nextWs || nextPunct);
  return { leftFlank, rightFlank, prevPunct, nextPunct };
}

/**
 * Marked's emStrong masking: before deciding whether a delimiter can
 * close, marked masks the paragraph in two passes and computes the last
 * possible closer from the masked body. Pass 1 masks backslashes and
 * backticks inside code spans; pass 2 masks whole links, code spans and
 * HTML tags by replacing their middles with `a`s. Mismatched backtick
 * runs defeat both passes in sequence: pass 1 masks a lone backtick
 * inside what it takes for a code span, which makes pass 2 see a
 * backtick-free span stretching from a link's body across an em's
 * delimiters, so the em's closer is masked away and no closer is found
 * at all — the em never forms. Replicate the two passes
 * (length-preserving, so indices still ln up with `src`) and use the
 * result to tell whether a closer position survived masking.
 */
const MASK_PUNCT_SRC = '[\\p{P}\\p{S}]';
const MASK_PASS1 = new RegExp(
  '(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(' + MASK_PUNCT_SRC + ')',
  'gu',
);
const MASK_LINK_SRC =
  '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)';
const MASK_CODE_SRC = '(?<b>`+)[^`]+\\k<b>(?!`)';
const MASK_TAG_SRC = '<(?! )[^<>]*?>';
const MASK_PASS2 = new RegExp(
  MASK_LINK_SRC + '|(?<!`)()' + MASK_CODE_SRC + '|' + MASK_TAG_SRC,
  'g',
);
function buildMask(src) {
  let masked = src.replace(MASK_PASS1, (whole, run, esc) =>
    esc ? '+'.repeat(whole.length)
      : run ? run + whole.slice(run.length, -run.length).replace(/`/g, '+') + run
      : whole,
  );
  masked = masked.replace(MASK_PASS2, (whole) => '[' + 'a'.repeat(whole.length - 2) + ']');
  return masked;
}

/**
 * Try to resolve the closer run `closer` against earlier openers in
 * `delimStack`, editing `chunks` in place. Uses the CommonMark matching
 * rules: nearest opener first, the odd-match rule for runs that can
 * both open and close, one delimiter for <em>/<del> and two for
 * <strong>. A closer with length left over keeps matching further
 * openers.
 */
function matchCloser(chunks, delimStack, closer, src) {
  if (!delimStack.spans) delimStack.spans = [];
  const spans = delimStack.spans;
  // A closer masked away by marked's emStrong masking (see buildMask)
  // can never close: its delimiter sits inside a region the masking
  // swallowed, so marked finds no closer and the span never forms.
  // Leave it literal.
  if (delimStack.masked && delimStack.masked[closer.at] !== closer.mark) return;
  while (closer.size > 0 && closer.mayClose) {
    let opener = null;
    // Only earlier delimiters can open for this closer — never itself.
    for (let jdx = delimStack.length - 2; jdx >= 0; jdx--) {
      const cand = delimStack[jdx];
      if (!cand.live || cand.size === 0 || cand.mark !== closer.mark) continue;
      if (!cand.mayOpen) continue;
      if (closer.mark === '~' && cand.size !== closer.size) continue;
      // A delimiter strictly inside a closed emphasis span cannot
      // match a closer outside that span (the spans would cross).
      let trapped = false;
      for (const s of spans) {
        if (s.start < cand.at && cand.at < s.end && s.end < closer.at) {
          trapped = true;
          break;
        }
      }
      if (trapped) continue;
      // Blocking strong: a `*` closer does not match a `*` opener of
      // length 1 when a <strong> span sits between them whose opener
      // could open but not close (space-preceded) and whose closer is
      // immediately followed by a word character (no space before the
      // body leading to this closer). Marked leaves the outer `*...*`
      // literal in that case. A len-1 closer must not fall through
      // to steal a delimiter from an earlier `**` opener either, or
      // the outer strong could not form — so a len-1 closer is left
      // unmatched entirely. A len-2+ closer may still pair with an
      // earlier `**` opener (strong), so it only skips this candidate.
      if (closer.mark === '*' && cand.size === 1) {
        let blocked = false;
        for (const s of spans) {
          if (s.use === 2 && !s.openMayClose && s.start > cand.at && s.end < closer.at) {
            const after = s.end + 2;
            if (after < src.length) {
              const ac = src.charCodeAt(after);
              if ((ac >= 48 && ac <= 57) || (ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || ac > 127) {
                blocked = true;
                break;
              }
            }
          }
        }
        if (blocked) {
          if (closer.size === 1) return;
          continue;
        }
      }
      // Odd-match rule: when either delimiter can both open and close
      // and the sum of the lengths is a multiple of 3, they cannot
      // match unless both lengths are multiples of 3.
      const openBoth = cand.mayOpen && cand.mayClose;
      const closeBoth = closer.mayOpen && closer.mayClose;
      if (
        (openBoth || closeBoth) &&
        (cand.size + closer.size) % 3 === 0 &&
        !(cand.size % 3 === 0 && closer.size % 3 === 0)
      ) {
        continue;
      }
      // Do not steal from `**`: a len-1 `*` closer must not pair with
      // a len-2 opener (using one delimiter) when a later `**` run
      // could close that opener as <strong> instead. Marked's regex
      // matches the outer `**...**` first and leaves the single `*`
      // literal; pairing here would leave the opener with one
      // delimiter and the strong could not form. A len-3+ opener can
      // spare one delimiter and still form <strong>, so the rule
      // applies only to exactly len-2 openers. Scan forward for a
      // later right-flanking run of 2+ of the same character.
      if (closer.mark === '*' && closer.size === 1 && cand.size === 2) {
        let laterStrong = false;
        for (let p = closer.at + 1; p + 1 < src.length; p++) {
          if (src.charCodeAt(p) === 42 && src.charCodeAt(p + 1) === 42) {
            let qdx = p;
            while (qdx < src.length && src.charCodeAt(qdx) === 42) qdx++;
            if (flankInfo(src, p, qdx - p, src.length).rightFlank) {
              laterStrong = true;
            }
            p = qdx - 1;
            if (laterStrong) break;
          }
        }
        if (laterStrong) continue;
      }
      opener = cand;
      break;
    }
    if (!opener) return;
    let use;
    if (closer.mark === '~') {
      use = opener.size;
    } else {
      use = opener.size >= 2 && closer.size >= 2 ? 2 : 1;
    }
    // Record the span so later closers cannot match an opener trapped
    // inside it.
    spans.push({ start: opener.at, end: closer.at, use, openMayClose: opener.mayClose });
    const openTag = closer.mark === '~' ? '<del>' : use === 2 ? '<strong>' : '<em>';
    const closeTag = closer.mark === '~' ? '</del>' : use === 2 ? '</strong>' : '</em>';
    opener.head = openTag + opener.head;
    opener.size -= use;
    chunks[opener.slot] = opener.mark.repeat(opener.size) + opener.head;
    if (opener.size === 0) opener.live = false;
    closer.head = closer.head + closeTag;
    closer.size -= use;
    // A leftover delimiter of a closer run goes INSIDE the close tag
    // when the span is <strong> and a span already sits strictly
    // inside this one (marked takes the last `use` delimiters of the
    // run as the closer, so the rest is content); otherwise the
    // leftover stays outside, as before.
    let nested = false;
    if (use === 2) {
      for (const s of spans) {
        if (s.start > opener.at && s.end < closer.at) { nested = true; break; }
      }
    }
    chunks[closer.slot] = nested
      ? closer.mark.repeat(closer.size) + closer.head
      : closer.head + closer.mark.repeat(closer.size);
    if (closer.size === 0) closer.live = false;
  }
}

/** Record a delimiter run in `chunks` and on the delimStack; resolve if it closes. */
function addRun(chunks, delimStack, src, p, size, end) {
  const mark = src[p];
  const f = flankInfo(src, p, size, end);
  let mayOpen;
  let mayClose;
  if (mark === '_') {
    // '_' — intraword runs cannot open or close: an opener needs to be
    // left-flanking and (not right-flanking or preceded by punctuation),
    // a closer right-flanking and (not left-flanking or followed by it).
    mayOpen = f.leftFlank && (!f.rightFlank || f.prevPunct);
    mayClose = f.rightFlank && (!f.leftFlank || f.nextPunct);
  } else {
    // '*' and '~' — open when left-flanking, close when right-flanking.
    mayOpen = f.leftFlank;
    mayClose = f.rightFlank;
  }
  chunks.push(src.slice(p, p + size));
  const run = newRun(mark, size, mayOpen, mayClose, chunks.length - 1, p);
  delimStack.push(run);
  if (mayClose) matchCloser(chunks, delimStack, run, src);
  return run;
}

/**
 * Parse an `&...;` sequence at `p`. Returns the HTML to emit and the index
 * just past the sequence, or null when this is not a character reference
 * (the `&` is then escaped as plain body). Named references pass through
 * verbatim; numeric ones decode to the character (U+FFFD when invalid).
 */
function readEntity(src, p, end) {
  if (p + 1 >= end) return null;
  const after = src.charCodeAt(p + 1);
  if (after === 35) {
    // Numeric: &#123; or &#x1F600; — decimal 1-7 digits, hex 1-6 digits.
    let qdx = p + 2;
    let hex = false;
    if (qdx < end && (src.charCodeAt(qdx) === 120 || src.charCodeAt(qdx) === 88)) {
      hex = true;
      qdx++;
    }
    const digitsStart = qdx;
    while (qdx < end && (hex ? hexCode(src.charCodeAt(qdx)) : decCode(src.charCodeAt(qdx)))) qdx++;
    const digits = qdx - digitsStart;
    if (digits === 0) return null;
    if (hex ? digits > 6 : digits > 7) return null;
    if (qdx >= end || src.charCodeAt(qdx) !== 59) return null;
    return { html: escapeHtmlText(decodeNumRef(src.slice(digitsStart, qdx), hex)), next: qdx + 1 };
  }
  let qdx = p + 1;
  while (qdx < end && wordCode(src.charCodeAt(qdx))) qdx++;
  if (qdx === p + 1 || qdx >= end || src.charCodeAt(qdx) !== 59) return null;
  return { html: src.slice(p, qdx + 1), next: qdx + 1 };
}

/**
 * Parse a backtick code span starting at `p` (a run of `n` backticks).
 * Returns the rendered `<code>...</code>` and the index past the span,
 * or null when no matching run closes it.
 */
function readCode(src, p, end) {
  let n = 0;
  while (p + n < end && src.charCodeAt(p + n) === 96) n++;
  // Find a run of exactly n backticks.
  let qdx = p + n;
  while (qdx < end) {
    if (src.charCodeAt(qdx) === 96) {
      let m = 0;
      while (qdx + m < end && src.charCodeAt(qdx + m) === 96) m++;
      if (m === n) {
        let content = src.slice(p + n, qdx);
        // Line endings become spaces; strip one space at each end when the
        // content is not all spaces and has a space at both ends.
        content = content.replace(/\r\n?/g, '\n').replace(/\n/g, ' ');
        if (
          content.length >= 2 &&
          content.charCodeAt(0) === 32 &&
          content.charCodeAt(content.length - 1) === 32 &&
          content.trim() !== ''
        ) {
          content = content.slice(1, -1);
        }
        return { html: '<code>' + escapeHtmlText(content) + '</code>', next: qdx + n };
      }
      qdx += m;
    } else {
      qdx++;
    }
  }
  return null;
}

// ---------- links ----------

/** Normalize a link label: lowercase, collapse whitespace runs to one space. */
function foldLabel(label) {
  let built = '';
  let lastWs = true;
  for (let p = 0; p < label.length; p++) {
    const code = label.charCodeAt(p);
    if (wsCode(code) || code === 10) {
      if (!lastWs) {
        built += ' ';
        lastWs = true;
      }
    } else {
      // Unicode case folding: ß (and ẞ, which lowercases to ß) folds
      // to "ss", so [ẞ] matches a [SS] definition.
      const lower = label[p].toLowerCase();
      built += lower === 'ß' ? 'ss' : lower;
      lastWs = false;
    }
  }
  return lastWs && built.length > 0 ? built.slice(0, -1) : built;
}

/**
 * Find the `]` matching the `[` whose body starts at `from` (the index
 * just after `[`). Handles nested brackets, backslash escapes and code
 * spans. A `]` inside a raw HTML tag — for instance inside a quoted
 * attribute value, as in `<bar attr="](baz)">` — does not close the
 * brackets, so a tag is skipped whole.
 */
function findCloseBracket(src, from, end) {
  let depth = 0;
  let p = from;
  while (p < end) {
    const code = src.charCodeAt(p);
    if (code === 92) {
      p += 2;
      continue;
    }
    if (code === 96) {
      // A backtick run opens a code-span unit closed by the NEXT
      // backtick run of ANY length (marked's label regex: the content
      // holds no backticks, and the runs need not match). A `]`
      // between the runs is inside the span and does not close the
      // brackets. EXCEPTION: a run directly before a `]` never opens
      // a span — a run of 2+ there is marked's ``+(?=]) unit and the
      // `]` ends the label, while a lone single backtick there is
      // caught by linkTextOk. So when the run is directly before a
      // `]`, do not scan past it for a closer; just step past the run
      // and let the main loop meet the `]`. Looking for a same-length
      // run instead would pair a run with one far past the `]`,
      // swallowing the bracket that closes the link.
      let n = 0;
      while (p + n < end && src.charCodeAt(p + n) === 96) n++;
      if (p + n < end && src.charCodeAt(p + n) === 93) {
        p += n;
        continue;
      }
      let qdx = p + n;
      let found = false;
      while (qdx < end) {
        if (src.charCodeAt(qdx) === 96) {
          let m = 0;
          while (qdx + m < end && src.charCodeAt(qdx + m) === 96) m++;
          found = true;
          qdx += m;
          break;
        }
        qdx++;
      }
      p = found ? qdx : p + n;
      continue;
    }
    if (code === 60) {
      const tag = readRawTag(src, p, end);
      if (tag) {
        p = tag.next;
        continue;
      }
      p++;
      continue;
    }
    if (code === 91) {
      depth++;
      p++;
      continue;
    }
    if (code === 93) {
      if (depth === 0) return p;
      depth--;
      p++;
      continue;
    }
    p++;
  }
  return -1;
}

/** Skip spaces, tabs and newlines starting at `p`. */
function skipWsInline(src, p, end) {
  while (p < end) {
    const code = src.charCodeAt(p);
    if (code === 32 || code === 9 || code === 10) p++;
    else break;
  }
  return p;
}

/**
 * Parse a link destination at `p`. Returns {dest, next} where `next` is
 * the index just past the destination, or null. Handles `<...>` (which
 * may hold spaces, but no `<`, `>` or ln ending) and bare destinations
 * (no spaces or control characters, parentheses balanced). Backslash
 * escapes are resolved; entities are left as they are.
 */
function readDest(src, p, end) {
  if (p >= end) return null;
  if (src.charCodeAt(p) === 60) {
    // <...>
    let qdx = p + 1;
    let dest = '';
    while (qdx < end) {
      const code = src.charCodeAt(qdx);
      if (code === 62) return { dest, next: qdx + 1 };
      if (code === 60 || code === 10) return null;
      if (code === 92 && qdx + 1 < end && punctCode(src.charCodeAt(qdx + 1))) {
        dest += src[qdx + 1];
        qdx += 2;
        continue;
      }
      dest += src[qdx];
      qdx++;
    }
    return null;
  }
  // Bare destination.
  let qdx = p;
  let depth = 0;
  let dest = '';
  while (qdx < end) {
    const code = src.charCodeAt(qdx);
    if (code === 32 || code === 9 || code === 10 || code < 32) break;
    if (code === 92 && qdx + 1 < end && punctCode(src.charCodeAt(qdx + 1))) {
      dest += src[qdx + 1];
      qdx += 2;
      continue;
    }
    if (code === 40) {
      depth++;
      dest += src[qdx];
      qdx++;
      continue;
    }
    if (code === 41) {
      if (depth === 0) break;
      depth--;
      dest += src[qdx];
      qdx++;
      continue;
    }
    dest += src[qdx];
    qdx++;
  }
  if (qdx === p) return null;
  return { dest, next: qdx };
}

/**
 * Parse a link title at `p` (`"..."`, `'...'` or `(...)`). Returns
 * {title, next} or null. Backslash escapes are resolved.
 */
function readTitle(src, p, end) {
  if (p >= end) return null;
  const quote = src.charCodeAt(p);
  if (quote !== 34 && quote !== 39 && quote !== 40) return null;
  const close = quote === 40 ? 41 : quote;
  let qdx = p + 1;
  let title = '';
  while (qdx < end) {
    const code = src.charCodeAt(qdx);
    if (code === close) return { title, next: qdx + 1 };
    if (quote === 40 && (code === 40 || code === 41)) return null;
    if (code === 92 && qdx + 1 < end && punctCode(src.charCodeAt(qdx + 1))) {
      title += src[qdx + 1];
      qdx += 2;
      continue;
    }
    title += src[qdx];
    qdx++;
  }
  return null;
}

/**
 * A link label is valid only when it holds no unescaped bracket and
 * normalizes to something non-empty. Nested-bracket labels such as
 * `ref[bar]` or `[[foo]]`, and whitespace-only labels such as `[\n ]`,
 * are not definitions and match no reference.
 */
function labelOk(label) {
  if (foldLabel(label) === '') return false;
  for (let p = 0; p < label.length; p++) {
    const code = label.charCodeAt(p);
    if (code === 92) {
      p++;
      continue;
    }
    if (code === 91 || code === 93) return false;
  }
  return true;
}

/**
 * After a link body's closing `]`, try to parse what follows: an inline
 * link `(dest "title")`, a full reference `[label]`, a collapsed
 * reference `[]`, or a shortcut reference. Returns {dest, title, next}
 * or null. `body` is the raw link body (used for collapsed/shortcut).
 */
function readLinkAfter(src, qdx, end, body, linkRefs) {
  if (qdx < end && src.charCodeAt(qdx) === 40) {
    // Inline link: ( dest title? ) — an empty pair of parens is a
    // valid link with an empty destination. When the inline form
    // fails, fall through to the shortcut reference below, so
    // `[foo](not a link)` still links `[foo]` when it is defined.
    let kdx = skipWsInline(src, qdx + 1, end);
    if (kdx < end && src.charCodeAt(kdx) === 41) {
      return { dest: '', title: '', next: kdx + 1, inline: true };
    }
    const d = readDest(src, kdx, end);
    if (d) {
      kdx = skipWsInline(src, d.next, end);
      let title = '';
      let ok = true;
      if (kdx < end && (src.charCodeAt(kdx) === 34 || src.charCodeAt(kdx) === 39 || src.charCodeAt(kdx) === 40)) {
        const t = readTitle(src, kdx, end);
        if (!t) ok = false;
        else {
          title = t.title;
          kdx = skipWsInline(src, t.next, end);
        }
      }
      if (ok && kdx < end && src.charCodeAt(kdx) === 41) {
        return { dest: d.dest, title, next: kdx + 1, inline: true };
      }
    }
  }
  if (qdx < end && src.charCodeAt(qdx) === 91) {
    // [label] or [] — full or collapsed reference.
    const close = findCloseBracket(src, qdx + 1, end);
    if (close === -1) return null;
    const label = close === qdx + 1 ? body : src.slice(qdx + 1, close);
    if (!labelOk(label)) return null;
    const ref = linkRefs.get(foldLabel(label));
    if (!ref) return null;
    return { dest: ref.dest, title: ref.title, next: close + 1 };
  }
  // Shortcut reference: the body itself is the label.
  if (body.length === 0) return null;
  if (!labelOk(body)) return null;
  const ref = linkRefs.get(foldLabel(body));
  if (!ref) return null;
  return { dest: ref.dest, title: ref.title, next: qdx };
}

/**
 * Strict backtick check for INLINE link body only (reference links do
 * not apply it). Mirrors marked's label regex: a backtick run opens a
 * code-span unit closed by the NEXT backtick run of ANY length (the
 * content holds no backticks, and the runs need not match), and a run
 * of two or more backticks immediately before the closing `]` is
 * allowed on its own. Anything else — a run with no later run and
 * body after it, or a lone single backtick at the end — kills the
 * link. (The inline render still decides whether a real code span
 * forms; equal run lengths are only needed there.)
 */
function linkTextOk(body) {
  const end = body.length;
  let p = 0;
  while (p < end) {
    const code = body.charCodeAt(p);
    if (code === 92) { p += 2; continue; }
    if (code === 96) {
      let n = 0;
      while (p + n < end && body.charCodeAt(p + n) === 96) n++;
      // The next backtick run, if any, closes the unit.
      let qdx = p + n;
      let found = false;
      while (qdx < end) {
        if (body.charCodeAt(qdx) === 96) { found = true; break; }
        qdx++;
      }
      if (found) {
        let m = 0;
        while (qdx + m < end && body.charCodeAt(qdx + m) === 96) m++;
        p = qdx + m;
        continue;
      }
      // No later run: only a run of 2+ at the very end survives.
      if (n >= 2 && p + n === end) return true;
      return false;
    }
    p++;
  }
  return true;
}

/**
 * Strip HTML tags from `html` (used for image alt body). An `<img>` tag
 * contributes its alt body, so `![foo ![bar](/url)](/url2)` gets the
 * alt `foo bar` instead of `foo `.
 */
function stripMarkup(html) {
  let built = '';
  let p = 0;
  while (p < html.length) {
    if (html.charCodeAt(p) === 60) {
      const gt = html.indexOf('>', p);
      if (gt === -1) {
        built += html.slice(p);
        break;
      }
      const tag = html.slice(p, gt + 1);
      if (tag.startsWith('<img ')) {
        const m = / alt="([^"]*)"/.exec(tag);
        if (m) built += m[1];
      }
      p = gt + 1;
    } else {
      built += html[p];
      p++;
    }
  }
  return built;
}

// ---------- email and bare-URL scanning ----------

/** True for a character that can appear in an email local part. */
function emailLocalCh(code) {
  return (
    alphaNumCode(code) || code === 46 || code === 33 || code === 35 || code === 36 || code === 37 ||
    code === 38 || code === 39 || code === 42 || code === 43 || code === 47 || code === 61 ||
    code === 63 || code === 94 || code === 95 || code === 96 || code === 123 || code === 124 ||
    code === 125 || code === 126 || code === 45
  );
}

/**
 * Parse an email domain starting at `p` (just after the `@`).
 * Labels of [A-Za-z0-9-] ending in an alphanumeric, joined by dots.
 * `needDot` requires at least one dot (bare emails); angle-bracket
 * autolinks take the spec form without one. Returns the end index or -1.
 */
function readMailDomain(src, p, end, needDot) {
  let qdx = p;
  let labels = 0;
  while (qdx < end) {
    const labelStart = qdx;
    while (qdx < end) {
      const code = src.charCodeAt(qdx);
      if (alphaNumCode(code) || code === 45) qdx++;
      else break;
    }
    if (qdx === labelStart) return -1;
    if (!alphaNumCode(src.charCodeAt(qdx - 1))) return -1;
    labels++;
    if (qdx < end && src.charCodeAt(qdx) === 46) {
      // A '.' must be followed by a label character; otherwise it is
      // trailing punctuation, not part of the domain.
      if (
        qdx + 1 >= end ||
        !(alphaNumCode(src.charCodeAt(qdx + 1)) || src.charCodeAt(qdx + 1) === 45)
      ) {
        break;
      }
      qdx++;
      continue;
    }
    break;
  }
  if (needDot && labels < 2) return -1;
  if (labels === 0) return -1;
  return qdx;
}

/**
 * Parse an email address starting at the local part at `p`. Returns the
 * end index or -1.
 */
function readMail(src, p, end, needDot, allowTrailScore) {
  let qdx = p;
  while (qdx < end && emailLocalCh(src.charCodeAt(qdx))) qdx++;
  if (qdx === p || qdx >= end || src.charCodeAt(qdx) !== 64) return -1;
  const domEnd = readMailDomain(src, qdx + 1, end, needDot);
  if (domEnd === -1) return -1;
  // A '_' right after the domain means the address is part of a
  // longer word (no word boundary), so it is not an autolink — unless
  // that '_' is an emphasis closer (an '_' opener is active), in
  // which case the address ends before it.
  if (domEnd < end && src.charCodeAt(domEnd) === 95 && !allowTrailScore) return -1;
  return domEnd;
}

/** True for a character that can appear in an extended autolink URL. */
function urlCh(code) {
  return code > 32 && code !== 60 && code !== 62;
}

/**
 * Scan a bare-URL run starting at `from` (already past the scheme).
 * A `(` is part of the URL only when a `)` follows it later in the
 * run (balanced parens); an unbalanced `(` ends the URL before it.
 * `)` and `]` are always URL characters.
 */
function scanBareUrl(src, from, end) {
  let qdx = from;
  while (qdx < end && urlCh(src.charCodeAt(qdx))) {
    if (src.charCodeAt(qdx) === 40) {
      let kdx = qdx + 1;
      let found = false;
      while (kdx < end && urlCh(src.charCodeAt(kdx))) {
        if (src.charCodeAt(kdx) === 41) { found = true; break; }
        kdx++;
      }
      if (!found) break;
    }
    qdx++;
  }
  return qdx;
}

/**
 * Marked's GFM autolink backpedal: the longest prefix of src[from..to)
 * that segments into units — a run of chars that are not trailing
 * punctuation, parens or &; a balanced (...) group; an & that does
 * not start an entity at the very end; or a run of trailing
 * punctuation that does not reach the end. A trailing `)` is kept
 * when it closes a (...) group, even if an earlier `)` was
 * unbalanced (the paren count is NOT what matters — the grouping
 * is). Re-applied until stable, exactly as marked does.
 * Returns the new end index.
 */
function trimUrlTail(src, from, to) {
  let end = to;
  for (;;) {
    const next = backpedalStep(src, from, end);
    if (next === end) return end;
    end = next;
    if (end <= from) return from;
  }
}

function backpedalStep(src, from, to) {
  let pos = from;
  let lastGood = from;
  while (pos < to) {
    const code = src.charCodeAt(pos);
    if (!backpedalSkip(code)) {
      // Unit A: run of chars that are not trailing punctuation,
      // parens or &.
      while (pos < to && !backpedalSkip(src.charCodeAt(pos))) pos++;
      lastGood = pos;
      continue;
    }
    if (code === 40) {
      // Unit B: (...) — the first ) after the ( closes it.
      let kdx = pos + 1;
      while (kdx < to && src.charCodeAt(kdx) !== 41) kdx++;
      if (kdx < to) { pos = kdx + 1; lastGood = pos; continue; }
      break;
    }
    if (code === 38) {
      // Unit C: & that does not start an entity (&word;) at the end.
      let kdx = pos + 1;
      while (kdx < to && wordCode(src.charCodeAt(kdx))) kdx++;
      if (!(kdx < to && src.charCodeAt(kdx) === 59 && kdx + 1 === to)) {
        pos = pos + 1; lastGood = pos; continue;
      }
      break;
    }
    if (backpedalTrail(code)) {
      // Unit D: run of trailing punctuation, not reaching the end.
      let kdx = pos;
      while (kdx < to && backpedalTrail(src.charCodeAt(kdx))) kdx++;
      if (kdx < to) { pos = kdx; lastGood = pos; continue; }
      // Run reaches the end: the regex backtracks one character.
      if (kdx - pos >= 2) lastGood = kdx - 1;
      break;
    }
    break;
  }
  return lastGood;
}

/** Chars excluded from a backpedal unit-A run: ?!.,:;*_'\"~()& */
function backpedalSkip(code) {
  return (
    code === 63 || code === 33 || code === 46 || code === 44 || code === 58 || code === 59 ||
    code === 42 || code === 95 || code === 39 || code === 34 || code === 126 || code === 40 ||
    code === 41 || code === 38
  );
}

/** Chars in a backpedal unit-D (trailing punctuation) run: ?!.,:;*_'\"~) */
function backpedalTrail(code) {
  return (
    code === 63 || code === 33 || code === 46 || code === 44 || code === 58 || code === 59 ||
    code === 42 || code === 95 || code === 39 || code === 34 || code === 126 || code === 41
  );
}

/**
 * True when the character at `p` sits inside an email address's local
 * part: a run of email-local characters around it, then '@', then a
 * valid domain. A delimiter (`_`, `*`, `~`) in that spot is part of
 * the address, not emphasis — treating it as a delimiter would flush
 * the body and cut the local part short at the '@'.
 */
function insideMailLocal(src, p, end, segStart) {
  let a = p;
  while (a > segStart && emailLocalCh(src.charCodeAt(a - 1))) a--;
  // The delimiter must sit strictly inside the local part: a local
  // character on both sides of it. A '_' at the start of the local
  // part (e.g. an emphasis opener before an email) is not part of it.
  if (a === p) return false;
  let b = p;
  while (b < end && emailLocalCh(src.charCodeAt(b))) b++;
  if (b <= p + 1) return false;
  if (b >= end || src.charCodeAt(b) !== 64) return false;
  return readMailDomain(src, b + 1, end, true) !== -1;
}

/**
 * Try an extended autolink starting at `p`: a www. link, an http/https/ftp
 * link, a mailto:/xmpp: email link, or a bare email. Returns {html, next}
 * or null. `textStart` is where the current plain-body run began, used to
 * find an email local part before an `@`.
 */
function tryExtLink(src, p, end, textStart, hasScoreOpener) {
  if (extAutoBlocked) return null;
  const code = src.charCodeAt(p);
  // www. — preceded by the start, whitespace, or one of ( * _ ~.
  if (code === 119 && src.charCodeAt(p + 1) === 119 && src.charCodeAt(p + 2) === 119 && src.charCodeAt(p + 3) === 46) {
    const prev = p === 0 ? -1 : src.charCodeAt(p - 1);
    if (
      p === 0 || prev === 32 || prev === 9 || prev === 10 ||
      prev === 40 || prev === 42 || prev === 95 || prev === 126
    ) {
      let qdx = scanBareUrl(src, p + 4, end);
      const stop = trimUrlTail(src, p, qdx);
      if (stop > p + 4) {
        const body = src.slice(p, stop);
        return {
          html: '<a href="http://' + escapeLinkUrl(body) + '">' + escapeHtmlText(body) + '</a>',
          next: stop,
          textFrom: p,
        };
      }
    }
    return null;
  }
  // http://, https://, ftp:// (case-insensitive).
  if (code === 104 || code === 72 || code === 102 || code === 70) {
    let schemeLen = 0;
    if (src.slice(p, p + 7).toLowerCase() === 'http://') schemeLen = 7;
    else if (src.slice(p, p + 8).toLowerCase() === 'https://') schemeLen = 8;
    else if (src.slice(p, p + 6).toLowerCase() === 'ftp://') schemeLen = 6;
    if (schemeLen > 0) {
      let qdx = scanBareUrl(src, p + schemeLen, end);
      const stop = trimUrlTail(src, p, qdx);
      if (stop > p + schemeLen) {
        const body = src.slice(p, stop);
        return {
          html: '<a href="' + escapeLinkUrl(body) + '">' + escapeHtmlText(body) + '</a>',
          next: stop,
          textFrom: p,
        };
      }
    }
    return null;
  }
  // mailto: / xmpp: followed by an email, plus one optional /segment.
  if (code === 109 || code === 77 || code === 120 || code === 88) {
    let prefixLen = 0;
    if (src.slice(p, p + 7).toLowerCase() === 'mailto:') prefixLen = 7;
    else if (src.slice(p, p + 5).toLowerCase() === 'xmpp:') prefixLen = 5;
    if (prefixLen > 0) {
      const eEnd = readMail(src, p + prefixLen, end, true);
      if (eEnd !== -1) {
        let stop = eEnd;
        if (stop < end && src.charCodeAt(stop) === 47) {
          let kdx = stop + 1;
          while (kdx < end) {
            const d = src.charCodeAt(kdx);
            if (d === 47 || !urlCh(d)) break;
            kdx++;
          }
          if (kdx > stop + 1) stop = trimUrlTail(src, p, kdx);
        }
        const body = src.slice(p, stop);
        return {
          html: '<a href="' + escapeLinkUrl(body) + '">' + escapeHtmlText(body) + '</a>',
          next: stop,
          textFrom: p,
        };
      }
    }
    return null;
  }
  // Bare email: the local part ends at p (p is '@').
  if (code === 64) {
    let localStart = p;
    while (localStart > textStart && emailLocalCh(src.charCodeAt(localStart - 1))) localStart--;
    if (localStart < p) {
      const eEnd = readMail(src, localStart, end, true, hasScoreOpener);
      if (eEnd !== -1 && eEnd > p) {
        const body = src.slice(localStart, eEnd);
        return {
          html: '<a href="mailto:' + escapeLinkUrl(body) + '">' + escapeHtmlText(body) + '</a>',
          next: eEnd,
          textFrom: localStart,
        };
      }
    }
    return null;
  }
  return null;
}

/**
 * Parse an inline HTML tag, comment, declaration, CDATA section or
 * processing instruction starting at `p` (at `<`). Returns the raw body
 * and the index past it, or null when this is not valid inline HTML.
 */
function readRawTag(src, p, end) {
  if (p + 1 >= end) return null;
  const c1 = src.charCodeAt(p + 1);
  // Comment: <!-- ... --> — but <!--> and <!---> are complete empty
  // comments on their own (abrupt closing), ending at their own '>'.
  if (c1 === 33 && src.charCodeAt(p + 2) === 45 && src.charCodeAt(p + 3) === 45) {
    if (src.charCodeAt(p + 4) === 62) {
      return { body: src.slice(p, p + 5), next: p + 5 };
    }
    if (src.charCodeAt(p + 4) === 45 && src.charCodeAt(p + 5) === 62) {
      return { body: src.slice(p, p + 6), next: p + 6 };
    }
    const close = src.indexOf('-->', p + 4);
    if (close === -1) return null;
    return { body: src.slice(p, close + 3), next: close + 3 };
  }
  // CDATA: <![CDATA[ ... ]]>
  if (c1 === 33 && src.slice(p + 2, p + 9) === '[CDATA[') {
    const close = src.indexOf(']]>', p + 9);
    if (close === -1) return null;
    return { body: src.slice(p, close + 3), next: close + 3 };
  }
  // Declaration: <!A ... >
  if (c1 === 33) {
    const c2 = src.charCodeAt(p + 2);
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) {
      let qdx = p + 2;
      while (qdx < end && src.charCodeAt(qdx) !== 62) qdx++;
      if (qdx >= end) return null;
      return { body: src.slice(p, qdx + 1), next: qdx + 1 };
    }
    return null;
  }
  // Processing instruction: <? ... ?>
  if (c1 === 63) {
    const close = src.indexOf('?>', p + 2);
    if (close === -1) return null;
    return { body: src.slice(p, close + 2), next: close + 2 };
  }
  // Open or close tag.
  let qdx = p + 1;
  const isClose = src.charCodeAt(qdx) === 47;
  if (isClose) qdx++;
  const nameStart = qdx;
  if (qdx >= end) return null;
  const nc = src.charCodeAt(qdx);
  if (!((nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122))) return null;
  qdx++;
  while (qdx < end) {
    const d = src.charCodeAt(qdx);
    if (alphaNumCode(d) || d === 45) qdx++;
    else break;
  }
  if (qdx === nameStart) return null;
  // A closing tag takes no attributes: only whitespace then '>'.
  if (isClose) {
    while (qdx < end) {
      const d = src.charCodeAt(qdx);
      if (d === 32 || d === 9 || d === 10) qdx++;
      else break;
    }
    if (qdx < end && src.charCodeAt(qdx) === 62) {
      return { body: src.slice(p, qdx + 1), next: qdx + 1 };
    }
    return null;
  }
  // Attributes. Each attribute name must be preceded by whitespace:
  // a name (or anything else) glued straight onto the tag name or onto
  // a previous attribute value is not a tag.
  for (;;) {
    let ws = 0;
    while (qdx < end) {
      const d = src.charCodeAt(qdx);
      if (d === 32 || d === 9 || d === 10) { qdx++; ws++; }
      else break;
    }
    if (qdx >= end) return null;
    const d = src.charCodeAt(qdx);
    if (d === 62) return { body: src.slice(p, qdx + 1), next: qdx + 1 };
    if (d === 47) {
      if (qdx + 1 < end && src.charCodeAt(qdx + 1) === 62) {
        return { body: src.slice(p, qdx + 2), next: qdx + 2 };
      }
      return null;
    }
    if (ws === 0) return null;
    // Attribute name.
    const ac = src.charCodeAt(qdx);
    if (!((ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || ac === 95 || ac === 58)) return null;
    qdx++;
    while (qdx < end) {
      const e = src.charCodeAt(qdx);
      if (alphaNumCode(e) || e === 95 || e === 46 || e === 58 || e === 45) qdx++;
      else break;
    }
    // Whitespace after the name may lead to '=' (a value) or to the
    // next attribute. Only consume it when '=' follows; otherwise
    // rewind so the loop top counts it as the next attribute's
    // separator.
    const afterName = qdx;
    while (qdx < end) {
      const e = src.charCodeAt(qdx);
      if (e === 32 || e === 9 || e === 10) qdx++;
      else break;
    }
    if (qdx < end && src.charCodeAt(qdx) === 61) {
      qdx++;
      while (qdx < end) {
        const e = src.charCodeAt(qdx);
        if (e === 32 || e === 9 || e === 10) qdx++;
        else break;
      }
      if (qdx >= end) return null;
      const quote = src.charCodeAt(qdx);
      if (quote === 34 || quote === 39) {
        qdx++;
        while (qdx < end && src.charCodeAt(qdx) !== quote) qdx++;
        if (qdx >= end) return null;
        qdx++;
      } else {
        if (qdx >= end) return null;
        let n = 0;
        while (qdx < end) {
          const e = src.charCodeAt(qdx);
          if (e === 32 || e === 9 || e === 10 || e === 34 || e === 39 || e === 61 || e === 60 || e === 62 || e === 96) break;
          qdx++;
          n++;
        }
        if (n === 0) return null;
      }
    } else {
      qdx = afterName;
    }
  }
}

/**
 * Try an angle-bracket autolink at `p` (`<scheme:...>` or `<email>`).
 * Returns {html, next} or null.
 */
function readAngleLink(src, p, end) {
  if (p + 1 >= end) return null;
  const c1 = src.charCodeAt(p + 1);
  // Scheme: letter, then 1-31 alnum/+/-/. then ':'.
  if ((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122)) {
    let qdx = p + 1;
    while (qdx < end) {
      const d = src.charCodeAt(qdx);
      if (alphaNumCode(d) || d === 43 || d === 45 || d === 46) qdx++;
      else break;
    }
    const schemeLen = qdx - (p + 1);
    if (schemeLen >= 2 && schemeLen <= 32 && qdx < end && src.charCodeAt(qdx) === 58) {
      let kdx = qdx + 1;
      while (kdx < end) {
        const d = src.charCodeAt(kdx);
        if (d === 32 || d === 10 || d === 60 || d === 62 || d < 32) break;
        kdx++;
      }
      if (kdx < end && src.charCodeAt(kdx) === 62) {
        const body = src.slice(p + 1, kdx);
        return {
          html: '<a href="' + escapeLinkUrl(body) + '">' + escapeHtmlText(body) + '</a>',
          next: kdx + 1,
        };
      }
      return null;
    }
  }
  // Email: local@domain (the spec form, no dot required).
  const eEnd = readMail(src, p + 1, end, false);
  if (eEnd !== -1 && eEnd < end && src.charCodeAt(eEnd) === 62) {
    const body = src.slice(p + 1, eEnd);
    return {
      html: '<a href="mailto:' + escapeLinkUrl(body) + '">' + escapeHtmlText(body) + '</a>',
      next: eEnd + 1,
    };
  }
  return null;
}

// ---------- the inline scan ----------

/**
 * Parse the inline content of `src[from..end)` into `chunks`, using `linkRefs`
 * for link references. `delimStack` is this scope's delimiter delimStack (link body
 * gets a fresh one, so emphasis never crosses a link boundary). `inLink`
 * disables link parsing inside link body.
 */
function scanInline(chunks, src, from, end, linkRefs, delimStack, inLink, noExtAuto, tracker) {
  // Marked's emStrong masking for this body (see buildMask): closers
  // masked away can never close. Computed on the full src so indices
  // ln up with the delimiter positions.
  if (!delimStack.spans) delimStack.spans = [];
  if (delimStack.masked === undefined) delimStack.masked = buildMask(src);
  let p = from;
  let textStart = from;
  const flushText = (to) => {
    if (to > textStart) appendEscaped(chunks, src, textStart, to);
    textStart = to;
  };
  while (p < end) {
    const code = src.charCodeAt(p);
    if (code === 92) {
      // Backslash: an escaped punctuation mark, or a hard ln break.
      const n = p + 1 < end ? src.charCodeAt(p + 1) : -1;
      if (n === 10) {
        flushText(p);
        chunks.push('<br>');
        p += 2;
        while (p < end && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
        textStart = p;
        continue;
      }
      if (n !== -1 && punctCode(n)) {
        flushText(p);
        chunks.push(escapeHtmlText(src[p + 1]));
        p += 2;
        textStart = p;
        continue;
      }
      p++;
      continue;
    }
    if (code === 96) {
      // Code span. When no matching run closes it, the whole run is
      // literal body: never re-scan inside a failed run, or a run of
      // three backticks would split into a literal one plus a span.
      const span = readCode(src, p, end);
      if (span) {
        flushText(p);
        chunks.push(span.html);
        p = span.next;
        textStart = p;
        continue;
      }
      let n = 0;
      while (p + n < end && src.charCodeAt(p + n) === 96) n++;
      p += n;
      continue;
    }
    if (code === 42 || code === 95 || code === 126) {
      // Emphasis / strikethrough delimiter run.
      let n = 0;
      while (p + n < end && src.charCodeAt(p + n) === code) n++;
      if (code === 126 && n >= 3) {
        // Runs of three or more tildes are literal body.
        p += n;
        continue;
      }
      if (insideMailLocal(src, p, end, from)) {
        // Part of an email address's local part: plain body, so the
        // '@' scan-back later sees the whole local part.
        p += n;
        continue;
      }
      flushText(p);
      addRun(chunks, delimStack, src, p, n, end);
      p += n;
      textStart = p;
      continue;
    }
    if (code === 33 && p + 1 < end && src.charCodeAt(p + 1) === 91) {
      // Image: ![body](dest "title") and friends.
      const close = findCloseBracket(src, p + 2, end);
      if (close !== -1) {
        const body = src.slice(p + 2, close);
        const tail = readLinkAfter(src, close + 1, end, body, linkRefs);
        if (tail && !linkTextOk(body)) {
          p++;
          continue;
        }
        if (tail) {
          flushText(p);
          const alt = stripMarkup(renderInline(body, linkRefs));
          chunks.push(
            '<img src="' + escapeLinkUrl(tail.dest) + '" alt="' + alt + '"' +
              (tail.title ? ' title="' + escapeAttrValue(tail.title) + '"' : '') + '>',
          );
          p = tail.next;
          textStart = p;
          continue;
        }
      }
      p++;
      continue;
    }
    if (code === 91 && !inLink) {
      // Link: [body](dest "title"), [body][ref], [body][], [body].
      const close = findCloseBracket(src, p + 1, end);
      if (close !== -1) {
        const body = src.slice(p + 1, close);
        const tail = readLinkAfter(src, close + 1, end, body, linkRefs);
        // Marked's label regex applies the backtick rule to every
        // link form (inline, full/collapsed/shortcut reference, and
        // images): a backtick run must open a code-span unit closed
        // by the next run, or be a run of 2+ at the very end of the
        // body. An invalid label makes the whole bracket literal,
        // and a later bracket pair may still link on its own.
        if (tail && !linkTextOk(body)) {
          p++;
          continue;
        }
        if (tail) {
          // Parse the link body first: if it already contains a
          // BRACKET link, the outer brackets are literal (links cannot
          // nest) and the inner link is the one that counts. An
          // autolink inside link body is fine (marked nests it), and
          // bare URLs inside link body are plain body, not autolinks,
          // so extended autolinks are suppressed here. But an UNCLOSED
          // angle autolink (<scheme with no > in the body) spans beyond
          // the brackets and wins, so it also makes the outer literal.
          const innerParts = [];
          const innerStack = [];
          const innerTracker = { bracket: false };
          // Unclosed angle autolink: '<' + scheme, no '>' after it.
          for (let qdx = 0; qdx < body.length; qdx++) {
            if (body.charCodeAt(qdx) === 60) {
              let r = qdx + 1;
              if (r < body.length && /[a-zA-Z]/.test(body[r])) {
                r++;
                while (r < body.length && /[a-zA-Z0-9+.-]/.test(body[r])) r++;
                if (r < body.length && body.charCodeAt(r) === 58 && r - qdx - 1 >= 2 && r - qdx - 1 <= 32) {
                  if (body.indexOf('>', qdx) === -1) { innerTracker.bracket = true; break; }
                }
              }
            }
          }
          scanInline(innerParts, body, 0, body.length, linkRefs, innerStack, false, true, innerTracker);
          const innerHtml = innerParts.join('');
          // An image may live inside a link; only another bracket link
          // makes the outer brackets literal.
          if (innerTracker.bracket) {
            p++;
            continue;
          }
          if (tracker) tracker.bracket = true;
          flushText(p);
          chunks.push(
            '<a href="' + escapeLinkUrl(tail.dest) + '"' +
              (tail.title ? ' title="' + escapeAttrValue(tail.title) + '"' : '') + '>',
          );
          chunks.push(innerHtml);
          chunks.push('</a>');
          p = tail.next;
          textStart = p;
          continue;
        }
      }
      p++;
      continue;
    }
    if (code === 60) {
      // Angle-bracket autolink, or raw HTML.
      const auto = readAngleLink(src, p, end);
      if (auto) {
        flushText(p);
        chunks.push(auto.html);
        p = auto.next;
        textStart = p;
        continue;
      }
      const tag = readRawTag(src, p, end);
      if (tag) {
        flushText(p);
        chunks.push(tag.body);
        // An unclosed inline <a ...> tag suppresses extended
        // autolinks until a </a> is seen (marked quirk — see
        // extAutoBlocked). Any <a> tag sets it, even a self-closing
        // <a /> with no href; a closed <a>...</a> pair opens and
        // closes within the same paragraph, so it leaves the flag
        // false. (A standalone <a href="x"> ln is an HTML block,
        // not inline, so it never reaches this branch and never sets
        // it.)
        if (
          tag.body.length > 2 && tag.body[1] !== '/' &&
          /^<a[\s>]/.test(tag.body)
        ) {
          extAutoBlocked = true;
        } else if (/^<\/a[\s>]/.test(tag.body)) {
          extAutoBlocked = false;
        }
        p = tag.next;
        textStart = p;
        continue;
      }
      p++;
      continue;
    }
    if (code === 38) {
      // Character reference.
      const ent = readEntity(src, p, end);
      if (ent) {
        flushText(p);
        chunks.push(ent.html);
        p = ent.next;
        textStart = p;
        continue;
      }
      p++;
      continue;
    }
    if (code === 10) {
      // Newline: a hard break when the ln ends with two or more spaces.
      let spaces = 0;
      let kdx = p - 1;
      while (kdx >= textStart && src.charCodeAt(kdx) === 32) {
        spaces++;
        kdx--;
      }
      if (spaces >= 2) {
        flushText(p - spaces);
        chunks.push('<br>');
      } else {
        flushText(p);
        chunks.push('\n');
      }
      p++;
      if (spaces >= 2) {
        while (p < end && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
      }
      textStart = p;
      continue;
    }
    if (
      (!noExtAuto || (p > from && src.charCodeAt(p - 1) === 60)) && (
      code === 119 || code === 104 || code === 72 || code === 102 || code === 70 ||
      code === 109 || code === 77 || code === 120 || code === 88 || code === 64
      )
    ) {
      // Extended autolinks: www., http(s)://, ftp://, mailto:/xmpp:, email.
      // Inside link body they are suppressed (bare URLs there are plain
      // body), except when preceded by '<', which marks an angle
      // autolink attempt that still counts as a nested link.
      // A trailing '_' after an email domain is an emphasis closer
      // (not part of the address) when an '_' opener is active.
      let hasScoreOpener = false;
      if (code === 64) {
        for (let d = 0; d < delimStack.length; d++) {
          if (delimStack[d].live && delimStack[d].mark === '_' && delimStack[d].mayOpen) {
            hasScoreOpener = true;
            break;
          }
        }
      }
      const ext = tryExtLink(src, p, end, textStart, hasScoreOpener);
      if (ext) {
        flushText(ext.textFrom);
        chunks.push(ext.html);
        p = ext.next;
        textStart = p;
        continue;
      }
    }
    p++;
  }
  flushText(end);
}

/** Parse inline Markdown `src` to HTML using reference map `linkRefs`. */
function renderInline(src, linkRefs) {
  const chunks = [];
  const delimStack = [];
  delimStack.spans = [];
  delimStack.masked = buildMask(src);
  scanInline(chunks, src, 0, src.length, linkRefs, delimStack, false);
  return chunks.join('');
}

// ---------- C. the block engine ----------
//
// Lines are processed with a container delimStack (document, blockquote, list,
// list item). Each ln first matches the open containers, then either
// continues the open leaf block or starts a new block. Link reference
// definitions are pulled buf of paragraphs after the tree is built.

// Number of indent columns at the front of `s` (a tab jumps to a multiple
// of 4).
function countIndent(s) {
  let col = 0;
  let p = 0;
  while (p < s.length) {
    const code = s.charCodeAt(p);
    if (code === 32) {
      col++;
      p++;
    } else if (code === 9) {
      col += 4 - (col % 4);
      p++;
    } else {
      break;
    }
  }
  return col;
}

// Remove `cols` columns of indentation from the front of `s`. A tab that
// straddles the boundary leaves the remaining columns as spaces.
function cutIndent(s, cols) {
  let col = 0;
  let p = 0;
  while (p < s.length && col < cols) {
    const code = s.charCodeAt(p);
    if (code === 32) {
      col++;
      p++;
    } else if (code === 9) {
      const w = 4 - (col % 4);
      if (col + w <= cols) {
        col += w;
        p++;
      } else {
        return ' '.repeat(col + w - cols) + s.slice(p + 1);
      }
    } else {
      break;
    }
  }
  return s.slice(p);
}

/** Remove up to `n` leading whitespace characters (space or tab, each
 * counting as one) from `s`. This is marked's fenceState-indent rule. */
function cutFenceIndent(s, n) {
  let p = 0;
  while (p < s.length && p < n && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9)) p++;
  return s.slice(p);
}

/** True when `s` holds only spaces and tabs (or is empty). */
function blankLine(s) {
  for (let p = 0; p < s.length; p++) {
    const code = s.charCodeAt(p);
    if (code !== 32 && code !== 9) return false;
  }
  return true;
}

/**
 * Expand tabs in the leading whitespace run of `s` to spaces,
 * assuming `s` starts at column `startCol`. Tabs after the first
 * non-whitespace character are untouched. A tab advances to the next
 * multiple of 4 from its actual column, which is what container
 * stripping must preserve.
 */
function expandLeadTabs(s, startCol) {
  let col = startCol;
  let p = 0;
  while (p < s.length) {
    const code = s.charCodeAt(p);
    if (code === 32) {
      col++;
      p++;
    } else if (code === 9) {
      col = (Math.floor(col / 4) + 1) * 4;
      p++;
    } else {
      break;
    }
  }
  if (p === 0) return s;
  const spaces = col - startCol;
  return ' '.repeat(spaces) + s.slice(p);
}

/**
 * Consume a blockquote marker at the front of `s` (up to 3 spaces of
 * indent, `>`, one optional space). Returns the rest, or null.
 */
function eatQuote(s) {
  const ind = countIndent(s);
  if (ind > 3) return null;
  const s1 = cutIndent(s, ind);
  if (s1.charCodeAt(0) !== 62) return null;
  let rest = s1.slice(1);
  let startCol;
  if (rest.charCodeAt(0) === 32) {
    rest = rest.slice(1);
    startCol = ind + 2;
  } else if (rest.charCodeAt(0) === 9) {
    // A tab after > expands to the next multiple of 4; one column is the
    // optional space, the rest stays as content. The content starts
    // after that one space, at column ind + 2.
    const spaces = 4 - ((ind + 1) % 4) - 1;
    rest = ' '.repeat(spaces > 0 ? spaces : 0) + rest.slice(1);
    startCol = ind + 2;
  } else {
    startCol = ind + 1;
  }
  return expandLeadTabs(rest, startCol);
}

/** True when `s` is an ATX heading opener; returns its level or 0. */
function atxDepth(s) {
  const ind = countIndent(s);
  if (ind > 3) return 0;
  const t = cutIndent(s, ind);
  let n = 0;
  while (n < t.length && t.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return 0;
  if (n < t.length) {
    const code = t.charCodeAt(n);
    if (code !== 32 && code !== 9) return 0;
  }
  return n;
}

/** The inline body of an ATX heading ln (hashes and spacing removed). */
function atxBody(s, level) {
  const ind = countIndent(s);
  let t = cutIndent(s, ind).slice(level);
  // Skip all spaces/tabs after the opening hashes.
  let start = 0;
  while (start < t.length && (t.charCodeAt(start) === 32 || t.charCodeAt(start) === 9)) start++;
  t = t.slice(start);
  // Strip trailing spaces, then a closing run of #s. The run is a closing
  // sequence when it is preceded by a space or tab, or when it is the
  // whole content (it was preceded by the space after the opening hashes).
  let end = t.length;
  while (end > 0 && (t.charCodeAt(end - 1) === 32 || t.charCodeAt(end - 1) === 9)) end--;
  let hashEnd = end;
  while (hashEnd > 0 && t.charCodeAt(hashEnd - 1) === 35) hashEnd--;
  if (
    hashEnd < end &&
    (hashEnd === 0 || t.charCodeAt(hashEnd - 1) === 32 || t.charCodeAt(hashEnd - 1) === 9)
  ) {
    end = hashEnd;
    while (end > 0 && (t.charCodeAt(end - 1) === 32 || t.charCodeAt(end - 1) === 9)) end--;
  }
  return t.slice(0, end);
}

/** True when `s` is a thematic break (3+ of -, _ or *, spaces allowed). */
function isRule(s) {
  const ind = countIndent(s);
  if (ind > 3) return false;
  const t = cutIndent(s, ind);
  if (t.length === 0) return false;
  const marker = t.charCodeAt(0);
  if (marker !== 45 && marker !== 95 && marker !== 42) return false;
  let count = 0;
  for (let p = 0; p < t.length; p++) {
    const code = t.charCodeAt(p);
    if (code === marker) count++;
    else if (code !== 32 && code !== 9) return false;
  }
  return count >= 3;
}

/** True when `s` is a setext underline; returns 1 for `=`, 2 for `-`. */
function setextDepth(s) {
  const ind = countIndent(s);
  if (ind > 3) return 0;
  const t = cutIndent(s, ind);
  if (t.length === 0) return 0;
  const marker = t.charCodeAt(0);
  if (marker !== 61 && marker !== 45) return 0;
  let p = 0;
  while (p < t.length && t.charCodeAt(p) === marker) p++;
  while (p < t.length && (t.charCodeAt(p) === 32 || t.charCodeAt(p) === 9)) p++;
  if (p !== t.length) return 0;
  return marker === 61 ? 1 : 2;
}

/**
 * Parse a fenced-code opener at the front of `s`. Returns
 * {marker: '`'|'~', len, info} or null. A backtick fenceState's info string
 * cannot hold a backtick.
 */
function readFenceStart(s) {
  const ind = countIndent(s);
  if (ind > 3) return null;
  const t = cutIndent(s, ind);
  if (t.length === 0) return null;
  const marker = t.charCodeAt(0);
  if (marker !== 96 && marker !== 126) return null;
  let n = 0;
  while (n < t.length && t.charCodeAt(n) === marker) n++;
  if (n < 3) return null;
  const info = t.slice(n);
  if (marker === 96 && info.indexOf('`') !== -1) return null;
  return { marker: String.fromCharCode(marker), len: n, info };
}

/** True when `s` closes a fenceState of `marker` opened with length `openLen`. */
function isFenceEnd(s, marker, openLen) {
  const ind = countIndent(s);
  if (ind > 3) return false;
  const t = cutIndent(s, ind);
  if (t.length === 0) return false;
  if (t.charCodeAt(0) !== marker.charCodeAt(0)) return false;
  let n = 0;
  while (n < t.length && t.charCodeAt(n) === marker.charCodeAt(0)) n++;
  if (n < openLen) return false;
  for (let p = n; p < t.length; p++) {
    const code = t.charCodeAt(p);
    if (code !== 32 && code !== 9) return false;
  }
  return true;
}

// ---------- HTML nodes, lists, link references, tables ----------

const BLOCK_TAG_NAMES = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

/**
 * The HTML block type a ln starts (1-7), or 0. `endTag` is the closing
 * tag a type-1 block waits for (lowercase, e.g. 'script').
 */
function htmlKind(s) {
  const ind = countIndent(s);
  if (ind > 3) return 0;
  const t = cutIndent(s, ind);
  if (t.length === 0 || t.charCodeAt(0) !== 60) return 0;
  const lower = t.toLowerCase();
  // Type 1: <script, <pre, <style, <textarea.
  for (const tag of ['script', 'pre', 'style', 'textarea']) {
    if (lower.startsWith('<' + tag)) {
      const afterIdx = 1 + tag.length;
      if (afterIdx >= lower.length) return { type: 1, endTag: tag };
      const after = lower.charCodeAt(afterIdx);
      if (after === 32 || after === 9 || after === 10 || after === 62 || after === 47) {
        return { type: 1, endTag: tag };
      }
    }
  }
  // Type 2: <!--
  if (lower.startsWith('<!--')) return { type: 2, endTag: null };
  // Type 3: <?
  if (lower.startsWith('<?')) return { type: 3, endTag: null };
  // Type 4: <! + letter.
  if (lower.startsWith('<!')) {
    const code = t.charCodeAt(2);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return { type: 4, endTag: null };
  }
  // Type 5: <![CDATA[
  if (lower.startsWith('<![cdata[')) return { type: 5, endTag: null };
  // Type 6: a block tag (open or close), followed by space/tab/EOL/>//>.
  let qdx = 1;
  let closing = false;
  if (t.charCodeAt(qdx) === 47) {
    closing = true;
    qdx++;
  }
  const nameStart = qdx;
  while (qdx < t.length) {
    const code = t.charCodeAt(qdx);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45) qdx++;
    else break;
  }
  if (qdx > nameStart) {
    const name = t.slice(nameStart, qdx).toLowerCase();
    const after = t.charCodeAt(qdx);
    if (
      BLOCK_TAG_NAMES.has(name) &&
      (qdx === t.length || after === 32 || after === 9 || after === 62 || after === 47)
    ) {
      return { type: 6, endTag: null };
    }
  }
  // Type 7: a complete open or close tag alone on the ln.
  const tag = readRawTag(t, 0, t.length);
  if (tag && tag.next === t.length) return { type: 7, endTag: null };
  return 0;
}

/** True when the ln ends an HTML block of `type` (type 1 needs `endTag`). */
function htmlEnds(ln, type, endTag) {
  const lower = ln.toLowerCase();
  if (type === 1) return lower.indexOf('</' + endTag) !== -1;
  if (type === 2) return ln.indexOf('-->') !== -1;
  if (type === 3) return ln.indexOf('?>') !== -1;
  if (type === 4) return ln.indexOf('>') !== -1;
  if (type === 5) return ln.indexOf(']]>') !== -1;
  return false; // Types 6 and 7 end at a blank ln.
}

/**
 * Parse a list item marker at the front of `s`. Returns null, or
 * {ordered, start, delim, bodyIndent, content} where `content` is the
 * ln after the marker (and a task checkbox, when present).
 */
function readItemMarker(s) {
  const ind = countIndent(s);
  if (ind > 3) return null;
  const t = cutIndent(s, ind);
  if (t.length === 0) return null;
  const code = t.charCodeAt(0);
  let markerLen;
  let ordered = false;
  let start = 0;
  let delim = '';
  if (code === 45 || code === 43 || code === 42) {
    markerLen = 1;
    delim = t[0];
  } else if (decCode(code)) {
    let n = 0;
    while (n < t.length && decCode(t.charCodeAt(n))) n++;
    if (n > 9 || n >= t.length) return null;
    const d = t.charCodeAt(n);
    if (d !== 46 && d !== 41) return null;
    ordered = true;
    start = 0;
    for (let kdx = 0; kdx < n; kdx++) start = start * 10 + (t.charCodeAt(kdx) - 48);
    markerLen = n + 1;
    delim = t[n];
  } else {
    return null;
  }
  // The marker must be followed by a space, a tab, or the end of the ln.
  if (markerLen < t.length) {
    const next = t.charCodeAt(markerLen);
    if (next !== 32 && next !== 9) return null;
  }
  const rest = t.slice(markerLen);
  // Columns of whitespace after the marker.
  let wsCols = 0;
  let kdx = 0;
  while (kdx < rest.length) {
    const d = rest.charCodeAt(kdx);
    if (d === 32) {
      wsCols++;
      kdx++;
    } else if (d === 9) {
      wsCols += 4 - ((ind + markerLen + wsCols) % 4);
      kdx++;
    } else {
      break;
    }
  }
  let bodyIndent;
  let content;
  if (kdx >= rest.length) {
    // Empty item: the content indent is the marker width plus one.
    bodyIndent = ind + markerLen + 1;
    content = '';
  } else if (wsCols <= 4) {
    bodyIndent = ind + markerLen + wsCols;
    content = cutIndent(rest, wsCols);
  } else {
    bodyIndent = ind + markerLen + 1;
    content = cutIndent(rest, 1);
  }
  // Task list item: [ ], [x] or [X] at the start of the content.
  let task = null;
  if (
    content.length >= 3 && content.charCodeAt(0) === 91 &&
    (content.charCodeAt(1) === 32 || content.charCodeAt(1) === 120 || content.charCodeAt(1) === 88) &&
    content.charCodeAt(2) === 93 &&
    (content.length === 3 || content.charCodeAt(3) === 32 || content.charCodeAt(3) === 9)
  ) {
    task = content.charCodeAt(1) === 32 ? ' ' : 'x';
    const after = content.slice(3);
    let ws2 = 0;
    let m = 0;
    while (m < after.length) {
      const d = after.charCodeAt(m);
      if (d === 32) {
        ws2++;
        m++;
      } else if (d === 9) {
        ws2 += 4 - ((bodyIndent + 3 + ws2) % 4);
        m++;
      } else {
        break;
      }
    }
    if (m >= after.length) {
      content = '';
    } else if (ws2 <= 4) {
      content = cutIndent(after, ws2);
    } else {
      content = cutIndent(after, 1);
    }
    // The checkbox is content, not part of the marker, so the content
    // indent stays where the marker left it (after `- `). A sublist
    // indented to the marker width therefore nests inside the item,
    // and a continuation ln is stripped by that indent.
  }
  // Expand any leading tabs in the content from their true column:
  // the content starts at bodyIndent, and a tab there advances to
  // the next multiple of 4 from that column, not from column 0.
  return { ordered, start, delim, bodyIndent, content: expandLeadTabs(content, bodyIndent), task };
}

/**
 * Try to parse a link reference definition starting at paragraph ln
 * `startIdx`. Returns the number of lines consumed (0 when not a
 * definition). Adds the definition to `linkRefs` (first one wins).
 */
function tryDefinition(lines, startIdx, linkRefs, register = true) {
  // The definition may span several lines (a label can run over ln
  // ends, a title can too), so join all remaining paragraph lines
  // first and parse from the joined body.
  const chunks = [];
  for (let kdx = startIdx; kdx < lines.length; kdx++) chunks.push(lines[kdx]);
  const body = chunks.join('\n');
  let ind = 0;
  while (ind < 3 && ind < body.length && body.charCodeAt(ind) === 32) ind++;
  if (ind >= body.length || body.charCodeAt(ind) !== 91) return 0;
  const close = findCloseBracket(body, ind + 1, body.length);
  if (close === -1) return 0;
  const label = body.slice(ind + 1, close);
  if (label.length === 0 || label.length > 999) return 0;
  if (!labelOk(label)) return 0;
  if (close + 1 >= body.length || body.charCodeAt(close + 1) !== 58) return 0;
  let p = close + 2;
  // Skip whitespace (spaces, tabs, ln endings) between the chunks; the
  // destination and the title may each sit on a following ln.
  const skipSpaceAndNewline = () => {
    while (p < body.length) {
      const code = body.charCodeAt(p);
      if (code === 32 || code === 9 || code === 10) p++;
      else break;
    }
  };
  skipSpaceAndNewline();
  const d = readDest(body, p, body.length);
  if (!d) return 0;
  // An empty `<>` destination is valid; a bare destination is never empty.
  p = d.next;
  // Whitespace, a newline, or end of body must follow the destination:
  // a title opener glued straight onto it (as in `<bar>(baz)`) is not
  // a definition.
  if (p < body.length) {
    const code = body.charCodeAt(p);
    if (code !== 32 && code !== 9 && code !== 10) return 0;
  }
  // Try a title (on this ln or a following ln). If the title is
  // present but junk follows it on its ln, the definition still
  // stands without a title and the title ln is left as body.
  let endPos = d.next;
  let title = '';
  const isTitleOpener = (code) => code === 34 || code === 39 || code === 40;
  // Skip spaces/tabs on this ln, then look for a title opener here.
  let qdx = p;
  while (qdx < body.length && (body.charCodeAt(qdx) === 32 || body.charCodeAt(qdx) === 9)) qdx++;
  let titleStart = -1;
  if (qdx < body.length && isTitleOpener(body.charCodeAt(qdx))) {
    titleStart = qdx;
  } else {
    // Or the title may sit on a following ln.
    let kdx = qdx;
    while (kdx < body.length) {
      const code = body.charCodeAt(kdx);
      if (code === 32 || code === 9 || code === 10) kdx++;
      else break;
    }
    if (kdx < body.length && isTitleOpener(body.charCodeAt(kdx))) titleStart = kdx;
  }
  if (titleStart !== -1) {
    const t = readTitle(body, titleStart, body.length);
    // An unterminated title invalidates the whole definition.
    if (!t) return 0;
    // Only whitespace may follow the title on its ln.
    let kdx = t.next;
    let ok = true;
    while (kdx < body.length && body.charCodeAt(kdx) !== 10) {
      const code = body.charCodeAt(kdx);
      if (code !== 32 && code !== 9) {
        ok = false;
        break;
      }
      kdx++;
    }
    if (ok) {
      title = t.title;
      endPos = t.next;
    } else {
      // Junk after the title. When the title sits on the same ln as
      // the destination, the definition fails; when it sits on a
      // following ln, the definition stands without a title and the
      // title ln is left as body.
      const sameLine = body.slice(d.next, titleStart).indexOf('\n') === -1;
      if (sameLine) return 0;
    }
  } else {
    // No title: only whitespace may follow the destination on its own
    // ln. Junk there (not a title, not whitespace) invalidates the
    // whole definition.
    let kdx = p;
    while (kdx < body.length && (body.charCodeAt(kdx) === 32 || body.charCodeAt(kdx) === 9)) kdx++;
    if (kdx < body.length && body.charCodeAt(kdx) !== 10) return 0;
  }
  const consumed = body.slice(0, endPos).split('\n').length;
  const key = foldLabel(label);
  if (register && !linkRefs.has(key)) linkRefs.set(key, { dest: d.dest, title });
  return consumed;
}

/**
 * Parse a table delimiter row. Returns the alignments array
 * ('left' | 'center' | 'right' | null) or null.
 */
function readDelimRow(s) {
  const ind = countIndent(s);
  if (ind > 3) return null;
  let t = cutIndent(s, ind);
  // Trim spaces/tabs at both ends.
  let a = 0;
  let b = t.length;
  while (a < b && (t.charCodeAt(a) === 32 || t.charCodeAt(a) === 9)) a++;
  while (b > a && (t.charCodeAt(b - 1) === 32 || t.charCodeAt(b - 1) === 9)) b--;
  t = t.slice(a, b);
  if (t.length === 0) return null;
  const cells = t.split('|');
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    if (c.charCodeAt(0) === 58 && c.charCodeAt(c.length - 1) === 58) aligns.push('center');
    else if (c.charCodeAt(0) === 58) aligns.push('left');
    else if (c.charCodeAt(c.length - 1) === 58) aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}

/** Split a table row ln into cells (unescaped `|` separates). */
function splitRow(s) {
  const ind = countIndent(s);
  let t = cutIndent(s, ind);
  let a = 0;
  let b = t.length;
  while (a < b && (t.charCodeAt(a) === 32 || t.charCodeAt(a) === 9)) a++;
  while (b > a && (t.charCodeAt(b - 1) === 32 || t.charCodeAt(b - 1) === 9)) b--;
  t = t.slice(a, b);
  const cells = [];
  let cur = '';
  for (let p = 0; p < t.length; p++) {
    const code = t.charCodeAt(p);
    if (code === 92 && p + 1 < t.length && t.charCodeAt(p + 1) === 124) {
      cur += '|';
      p++;
      continue;
    }
    if (code === 124) {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += t[p];
  }
  cells.push(cur);
  // Drop an empty cell from a leading or trailing pipe.
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
}

// ---------- block parser ----------

/** True when `ln` could start a block that interrupts a paragraph. */
function interruptsPara(ln) {
  if (atxDepth(ln) > 0) return true;
  if (readFenceStart(ln)) return true;
  const hb = htmlKind(ln);
  if (hb !== 0 && hb.type !== 7) return true;
  if (isRule(ln)) return true;
  if (setextDepth(ln) > 0) return true;
  if (eatQuote(ln) !== null) return true;
  const m = readItemMarker(ln);
  if (m && (!m.ordered || m.start === 1)) return true;
  return false;
}

/**
 * Strip leading link reference definitions from `lines`, adding them to
 * `linkRefs` when `register` is true. Returns the remaining lines. A
 * speculative call (the table check, mid-paragraph) passes
 * register=false so an in-progress definition is not recorded before
 * its title ln has arrived.
 */
function dropDefinitions(lines, linkRefs, register = true) {
  let idx = 0;
  while (idx < lines.length) {
    const n = tryDefinition(lines, idx, linkRefs, register);
    if (n === 0) break;
    idx += n;
  }
  return lines.slice(idx);
}

/** True when the parsed content of `seg` ends with a still-open paragraph. */
function openParaAtEnd(seg, segNl, linkRefs) {
  if (seg.length === 0) return false;
  if (blankLine(seg[seg.length - 1])) return false;
  const inner = readBlocks(seg, segNl, 0, seg.length, linkRefs, false, 'top', false, null);
  let node = inner[inner.length - 1];
  while (node) {
    if (node.type === 'para') return true;
    if (node.type === 'quote') {
      node = node.children[node.children.length - 1];
    } else if (node.type === 'list') {
      const item = node.items[node.items.length - 1];
      node = item ? item.children[item.children.length - 1] : undefined;
    } else {
      return false;
    }
  }
  return false;
}

/**
 * Parse a blockquote starting at ln `from`. Returns
 * {node, next} where `next` is the first ln after the quote.
 */
function readQuote(lines, nl, from, end, linkRefs) {
  const seg = [];
  const segNl = [];
  const segLazy = new Set();
  let idx = from;
  while (idx < end) {
    const ln = lines[idx];
    const qdx = eatQuote(ln);
    if (qdx !== null) {
      seg.push(qdx);
      segNl.push(nl[idx]);
      idx++;
      continue;
    }
    if (blankLine(ln)) {
      // A blank ln without a quote marker ends the blockquote, even
      // when a later ln carries a marker again.
      break;
    }
    // A lazy continuation ln joins the quote's open paragraph. A
    // level-1 setext underline (=) can also be lazy: it joins the
    // paragraph as literal body, indented four spaces so it is not
    // read as a setext underline again. (A level-2 underline is a
    // thematic break, which ends the quote.)
    if (openParaAtEnd(seg, segNl, linkRefs)) {
      if (!interruptsPara(ln)) {
        // A lazy ln indented four or more columns loses four of
        // them, as an indented code block would.
        const lazyLine = countIndent(ln) >= 4 ? cutIndent(ln, 4) : ln;
        segLazy.add(seg.length);
        seg.push(lazyLine);
        segNl.push(nl[idx]);
        idx++;
        continue;
      }
      if (setextDepth(ln) === 1) {
        segLazy.add(seg.length);
        seg.push('    ' + ln);
        segNl.push(nl[idx]);
        idx++;
        continue;
      }
    }
    break;
  }
  const children = readBlocks(
    seg, segNl, 0, seg.length, linkRefs,
    idx < end && blankLine(lines[idx]), 'quote', false, segLazy,
  );
  return { node: { type: 'quote', children }, next: idx };
}

/**
 * Parse a list starting at ln `from`. Returns {node, next}.
 */
function readList(lines, nl, from, end, linkRefs, kind = 'top') {
  const first = readItemMarker(lines[from]);
  const ordered = first.ordered;
  const delim = first.delim;
  const startNum = first.start;
  // The base indent of this list: a marker at a lower indent belongs
  // to an outer list, not to this one — but only when this list is
  // itself nested (inside a quote or an item). A top-level list takes
  // items at indents 0-3 as siblings.
  const baseIndent = kind === 'top' ? 0 : countIndent(lines[from]);
  const items = [];
  let isLoose = false;
  let idx = from;
  while (idx < end) {
    // Skip blank lines between items.
    while (idx < end && blankLine(lines[idx])) idx++;
    if (idx >= end) break;
    const ln = lines[idx];
    // A thematic break ends the list instead of starting a new item.
    if (isRule(ln)) break;
    const m = readItemMarker(ln);
    if (!m || m.ordered !== ordered || m.delim !== delim) break;
    if (countIndent(ln) < baseIndent) break;
    const bodyIndent = m.bodyIndent;
    const seg = [m.content];
    const segNl = [nl[idx]];
    const segLazy = new Set();
    const task = m.task;
    // A fenced code block opened inside this item captures its content
    // lines whatever their indent, until the closing fenceState. Without
    // this, a code ln with indent < bodyIndent ends the item and
    // its closing fenceState becomes a new opener that swallows the rest
    // of the document.
    let fenceState = null;
    // Whether the fenceState has captured a non-blank indented content
    // ln since it opened (or since the last blank ln), and
    // whether it is inside a run of captured low-indent lines.
    // Marked only captures a low-indent ln in a run that starts
    // right after an indented fenceState content ln: a fenceState with no
    // indented content yet ends at the first low-indent ln and
    // stays empty, a blank ln ends the run, and a low-indent
    // closer never closes the fenceState (the item ends and the closer
    // becomes a new opener outside it).
    let fenceLastIndented = false;
    let fenceLowRun = false;
    const fenceOpen = (s) => {
      const t = s.trimStart();
      if (t.length < 3) return null;
      const ch = t[0];
      if (ch !== '`' && ch !== '~') return null;
      let len = 0;
      while (len < t.length && t[len] === ch) len++;
      return len >= 3 ? { ch, len } : null;
    };
    const fenceCloses = (s, f) => {
      const t = s.trimStart();
      if (!t.startsWith(f.ch)) return false;
      let len = 0;
      while (len < t.length && t[len] === f.ch) len++;
      if (len < f.len) return false;
      return t.slice(len).trim() === '';
    };
    if (!fenceState) {
      fenceState = fenceOpen(m.content);
      fenceLastIndented = false;
      fenceLowRun = false;
    }
    idx++;
    while (idx < end) {
      const l2 = lines[idx];
      // Inside a fenced code block, every ln is code content until
      // the closing fenceState, whatever its indent — but only when the
      // fenceState is actually closed later inside this item. An unclosed
      // fenceState does not capture a ln outside the item: that ln ends
      // the item and the fenceState stays empty.
      if (fenceState) {
        if (countIndent(l2) < bodyIndent) {
          // A low-indent closer never closes the fenceState: the item
          // ends, the fenceState ends unclosed with the content it has,
          // and this ln becomes a new fenceState opener outside it.
          if (fenceCloses(l2, fenceState)) break;
          if (blankLine(l2)) {
            // A low-indent blank ln is captured only when the next
            // non-blank ln belongs to the item (is indented);
            // otherwise it ends the fenceState (and the item).
            let kdx = idx + 1;
            while (kdx < end && blankLine(lines[kdx])) kdx++;
            if (kdx >= end || countIndent(lines[kdx]) < bodyIndent) break;
          } else {
            // A low-indent content ln is captured only in a run
            // that starts right after an indented fenceState content ln
            // (or continues such a run) and only when a closer
            // exists later inside the item.
            const inRun = fenceLowRun || fenceLastIndented;
            if (!inRun) break;
            let closerAhead = false;
            for (let kdx = idx + 1; kdx < end; kdx++) {
              // Only a closer inside this item (indent at least the
              // content indent) counts: a fenceState ln further down in
              // another item or at the top level belongs to that block.
              if (countIndent(lines[kdx]) < bodyIndent) continue;
              const cand = expandLeadTabs(cutIndent(lines[kdx], bodyIndent), bodyIndent);
              if (fenceCloses(cand, fenceState)) { closerAhead = true; break; }
            }
            if (!closerAhead) break;
            fenceLowRun = true;
          }
        }
        const stripped = countIndent(l2) >= bodyIndent ? expandLeadTabs(cutIndent(l2, bodyIndent), bodyIndent) : l2;
        seg.push(stripped);
        segNl.push(nl[idx]);
        if (blankLine(l2)) {
          // A blank ln ends the low-indent run.
          fenceLastIndented = false;
          fenceLowRun = false;
        } else if (countIndent(l2) >= bodyIndent) {
          fenceLastIndented = true;
          fenceLowRun = false;
        }
        if (fenceCloses(stripped, fenceState)) {
          fenceState = null;
          fenceLastIndented = false;
          fenceLowRun = false;
        }
        idx++;
        continue;
      }
      if (blankLine(l2)) {
        let jdx = idx;
        while (jdx < end && blankLine(lines[jdx])) jdx++;
        if (jdx < end) {
          const nextMarker = readItemMarker(lines[jdx]);
          if (
            nextMarker && nextMarker.ordered === ordered &&
            nextMarker.delim === delim &&
            countIndent(lines[jdx]) < bodyIndent &&
            countIndent(lines[jdx]) >= baseIndent &&
            !isRule(lines[jdx])
          ) {
            // Blank ln(s) between two items: the list is isLoose.
            isLoose = true;
            break;
          }
          // An empty item is closed by a blank ln: content after it
          // is not part of the item, however it is indented.
          const hasContent = seg.some((s) => !blankLine(s));
          if (hasContent && countIndent(lines[jdx]) >= bodyIndent) {
            while (idx < jdx) {
              seg.push('');
              segNl.push(nl[idx]);
              idx++;
            }
            continue;
          }
        }
        break;
      }
      if (countIndent(l2) >= bodyIndent) {
        const stripped = expandLeadTabs(cutIndent(l2, bodyIndent), bodyIndent);
        seg.push(stripped);
        segNl.push(nl[idx]);
        if (!fenceState) {
          fenceState = fenceOpen(stripped);
          fenceLastIndented = false;
          fenceLowRun = false;
        }
        idx++;
        continue;
      }
      // A list item marker ends the current item; it is never a lazy
      // continuation of the item's paragraph, whether it belongs to
      // this list or starts a new one.
      const lm = readItemMarker(l2);
      if (lm && !isRule(l2)) {
        break;
      }
      // A lazy continuation ln joins the item's open paragraph. A
      // lazy ln indented four or more columns loses four of them.
      if (openParaAtEnd(seg, segNl, linkRefs) && !interruptsPara(l2)) {
        const lazyLine = countIndent(l2) >= 4 ? cutIndent(l2, 4) : l2;
        segLazy.add(seg.length);
        seg.push(lazyLine);
        segNl.push(nl[idx]);
        idx++;
        continue;
      }
      break;
    }
    // Whether another item follows this one (after any blank lines).
    let jdx = idx;
    while (jdx < end && blankLine(lines[jdx])) jdx++;
    let listContinues = false;
    if (jdx < end) {
      const nm = readItemMarker(lines[jdx]);
      listContinues = !!nm && nm.ordered === ordered &&
        nm.delim === delim && !isRule(lines[jdx]);
    }
    const children = readBlocks(
      seg, segNl, 0, seg.length, linkRefs,
      idx < end && blankLine(lines[idx]), 'item', listContinues, segLazy,
    );
    // Looseness, following marked exactly: a blank ln inside this
    // item makes the list isLoose only when it separates two nodes of
    // this item itself. A blank inside a nested list — between two of
    // its items, or between two nodes of one of its items — belongs
    // to that nested list, not to this one, and a blank inside a
    // fenced code block never counts. So track the nested lists open
    // in this item as a delimStack: when a blank is followed by a ln that
    // continues the innermost nested list open at the blank (a marker
    // of that list, or a ln indented to its current item's content
    // indent), the blank is inside that list; otherwise the ln
    // after the blank starts a new block of this item and the list is
    // isLoose. A lazy continuation ln of a nested item's open
    // paragraph stays in that nested item even below its content
    // indent, so the open paragraph's owner is tracked too.
    let prevLine = null;
    let blankPrevLine = null;
    let blankFrame = null;
    let inFence = false;
    let fenceMarker = '';
    let fenceLen = 0;
    const nestStack = [];
    let openParaFrame = null;
    for (const s of seg) {
      const t = s.trimStart();
      if (inFence) {
        if (isFenceEnd(s, fenceMarker, fenceLen)) inFence = false;
        prevLine = s;
        continue;
      }
      if (blankLine(s)) {
        if (blankPrevLine === null) {
          blankPrevLine = prevLine;
          blankFrame = nestStack.length ? nestStack[nestStack.length - 1] : null;
        }
        openParaFrame = null;
        continue;
      }
      const ind = countIndent(s);
      if (blankPrevLine !== null) {
        // The blank is inside a nested list when the ln after it
        // belongs to any nested list open at the blank: a marker of
        // one of those lists, or a ln indented to one of their
        // items' content indents (a deeper block of that item). Only
        // a ln inside no nested list starts a new block of this
        // item, making the list isLoose.
        const mkAfter = readItemMarker(s);
        let continues = false;
        for (let fi = nestStack.length - 1; fi >= 0; fi--) {
          const fr = nestStack[fi];
          if (
            mkAfter && ind === fr.markerIndent &&
            mkAfter.ordered === fr.ordered && mkAfter.delim === fr.delim
          ) {
            continues = true;
            break;
          }
          if (ind >= fr.bodyIndent) {
            continues = true;
            break;
          }
        }
        if (!continues) {
          isLoose = true;
          break;
        }
        blankPrevLine = null;
        blankFrame = null;
      }
      const fo = readFenceStart(s);
      if (fo) {
        inFence = true;
        fenceMarker = fo.marker;
        fenceLen = fo.len;
        openParaFrame = null;
        prevLine = s;
        continue;
      }
      const mk = readItemMarker(s);
      if (mk) {
        while (nestStack.length && nestStack[nestStack.length - 1].markerIndent > ind) nestStack.pop();
        const top = nestStack.length ? nestStack[nestStack.length - 1] : null;
        if (top && top.markerIndent === ind) {
          if (top.ordered === mk.ordered && top.delim === mk.delim) {
            top.bodyIndent = mk.bodyIndent;
          } else {
            nestStack.pop();
            nestStack.push({ markerIndent: ind, bodyIndent: mk.bodyIndent, ordered: mk.ordered, delim: mk.delim });
          }
        } else {
          nestStack.push({ markerIndent: ind, bodyIndent: mk.bodyIndent, ordered: mk.ordered, delim: mk.delim });
        }
        openParaFrame = mk.content.trim() ? nestStack[nestStack.length - 1] : null;
        prevLine = s;
        continue;
      }
      // A setext underline completes the open paragraph as a heading;
      // it belongs to the paragraph's item and closes the paragraph.
      if (openParaFrame !== null && setextDepth(s) > 0) {
        openParaFrame = null;
        prevLine = s;
        continue;
      }
      // A new block (heading, thematic break, quote, HTML, table
      // row is plain body) belongs to the innermost frame it reaches.
      if (atxDepth(s) > 0 || isRule(s) || t.startsWith('>')) {
        while (nestStack.length && ind < nestStack[nestStack.length - 1].bodyIndent) nestStack.pop();
        openParaFrame = null;
        prevLine = s;
        continue;
      }
      if (openParaFrame !== null) {
        // A lazy continuation of the open paragraph stays in that
        // paragraph's item, closing any deeper nested lists.
        while (nestStack.length && nestStack[nestStack.length - 1] !== openParaFrame) nestStack.pop();
        prevLine = s;
        continue;
      }
      // A new paragraph ln: pop nestStack it is not inside, then it
      // opens a paragraph in the innermost remaining frame (or here).
      while (nestStack.length && ind < nestStack[nestStack.length - 1].bodyIndent) nestStack.pop();
      openParaFrame = nestStack.length ? nestStack[nestStack.length - 1] : null;
      prevLine = s;
    }
    items.push({ task, children });
  }
  return {
    node: { type: 'list', ordered, start: startNum, delim, tight: !isLoose, items },
    next: idx,
  };
}

/**
 * Parse lines[from..end) into block nodes. `nl[idx]` says whether
 * lines[idx] is followed by a newline in the source. `linkRefs` collects link
 * reference definitions for the whole document. `followedByBlank` says
 * the ln after `end` (in the parent context) is blank. `kind` is the
 * container whose lines these are ('top' | 'quote' | 'item');
 * `listContinues` says another list item follows this one (item only).
 * `lazy` is a set of ln indices (into `lines`) that are lazy
 * continuation lines: they join the open paragraph as body and never
 * start a new block. The container kind decides an HTML block's
 * trailing newline at the end of the container: a quote drops it, a
 * list item keeps it when the list continues across a blank ln, the
 * top level keeps it.
 */
function readBlocks(lines, nl, from, end, linkRefs, followedByBlank, kind, listContinues, lazy) {
  const nodes = [];
  let idx = from;
  let para = null;

  const closePara = () => {
    if (!para) return;
    para.lines = dropDefinitions(para.lines, linkRefs);
    if (para.lines.length > 0) nodes.push(para);
    para = null;
  };

  while (idx < end) {
    const ln = lines[idx];
    if (blankLine(ln)) {
      // A whitespace-only ln that is the very last ln joins the
      // open paragraph as content instead of ending it.
      if (para && idx === end - 1 && ln.length > 0) {
        para.lines.push(ln);
        idx++;
        continue;
      }
      closePara();
      idx++;
      continue;
    }
    // A lazy continuation ln joins the open paragraph as body and
    // never starts a new block.
    if (lazy && lazy.has(idx)) {
      if (!para) para = { type: 'para', lines: [] };
      para.lines.push(ln);
      idx++;
      continue;
    }
    // A setext underline converts the open paragraph into a heading,
    // but only when the paragraph still has content once link
    // reference definitions are stripped: a paragraph made of
    // definitions alone is not a heading, and the underline ln joins
    // it as ordinary body.
    if (para) {
      const sl = setextDepth(ln);
      if (sl > 0) {
        const headingLines = dropDefinitions([...para.lines], linkRefs, false);
        if (headingLines.length > 0) {
          dropDefinitions(para.lines, linkRefs);
          para.lines = headingLines;
          // A setext heading's content is trimmed at both ends: leading
          // whitespace off the first ln, trailing off the last ln.
          const first = headingLines[0];
          let a = 0;
          while (a < first.length && (first.charCodeAt(a) === 32 || first.charCodeAt(a) === 9)) a++;
          headingLines[0] = first.slice(a);
          const lastIdx = headingLines.length - 1;
          const last = headingLines[lastIdx];
          let b = last.length;
          while (b > 0 && (last.charCodeAt(b - 1) === 32 || last.charCodeAt(b - 1) === 9)) b--;
          headingLines[lastIdx] = last.slice(0, b);
          nodes.push({ type: 'heading', level: sl, lines: headingLines });
          para = null;
          idx++;
          continue;
        }
      }
    }
    // ATX heading.
    const al = atxDepth(ln);
    if (al > 0) {
      closePara();
      nodes.push({ type: 'heading', level: al, lines: [atxBody(ln, al)] });
      idx++;
      continue;
    }
    // Fenced code.
    const fenceState = readFenceStart(ln);
    if (fenceState) {
      closePara();
      const fenceInd = countIndent(ln);
      const content = [];
      let lastIdx = -1;
      let jdx = idx + 1;
      while (jdx < end) {
        const fl = lines[jdx];
        if (isFenceEnd(fl, fenceState.marker, fenceState.len)) break;
        // Marked strips the opening fenceState's indent from content
        // lines for backtick fences only, by CHARACTER count (each
        // leading whitespace character, space or tab, counts as one),
        // not by columns: a tab that straddles the indent is removed
        // whole, not left as spaces. A tilde fenceState keeps its content
        // exactly as written.
        content.push(fenceState.marker === '~' ? fl : cutFenceIndent(fl, fenceInd));
        lastIdx = jdx;
        jdx++;
      }
      // A fenced code block drops one trailing empty ln (a ln
      // holding only spaces is kept).
      if (content.length > 0 && content[content.length - 1].length === 0) {
        content.pop();
      }
      // An unclosed fenceState (it ran to the end of the input) always
      // ends its content with a newline, even when the last ln
      // has none; a closed fenceState ends with the last ln's newline.
      const closed = jdx < end;
      const endsNl = content.length > 0 ? (!closed || nl[idx + content.length]) : false;
      nodes.push({ type: 'code', info: fenceState.info, lines: content, endsNl });
      idx = jdx < end ? jdx + 1 : jdx;
      continue;
    }
    // HTML block (type 7 cannot interrupt a paragraph).
    const hb = htmlKind(ln);
    if (hb !== 0 && (!para || hb.type !== 7)) {
      closePara();
      const content = [ln];
      let lastIdx = idx;
      let jdx = idx + 1;
      // A type 1-5 block can end on its opening ln.
      const endsOnFirst = hb.type >= 1 && hb.type <= 5 && htmlEnds(ln, hb.type, hb.endTag);
      if (!endsOnFirst) {
        while (jdx < end) {
          const l2 = lines[jdx];
          if (blankLine(l2)) {
            if (hb.type === 6 || hb.type === 7) break;
            content.push(l2);
            lastIdx = jdx;
            jdx++;
            continue;
          }
          content.push(l2);
          lastIdx = jdx;
          if (hb.type >= 1 && hb.type <= 5 && htmlEnds(l2, hb.type, hb.endTag)) {
            jdx++;
            break;
          }
          jdx++;
        }
      }
      // The trailing newline after the last ln depends on the
      // container: at the top level it is dropped only when a blank
      // ln follows; inside a quote it survives only when a non-blank
      // ln follows in the same quote; inside a list item it survives
      // whenever the item has more content, and at the item's end only
      // when the list continues across a blank ln.
      let endsNl;
      if (kind === 'quote') {
        endsNl = jdx < end && !blankLine(lines[jdx]) ? nl[lastIdx] : false;
      } else if (kind === 'item') {
        // The block keeps its trailing newline unless the next ln
        // is truly empty: the block regex swallows consecutive
        // newlines and `ge` then strips them all, but a spaces-only
        // ln is not a newline, so it does not swallow the newline.
        const nextEmpty = jdx < end && lines[jdx].length === 0;
        endsNl =
          jdx < end
            ? nextEmpty
              ? false
              : nl[lastIdx]
            : followedByBlank && listContinues
              ? nl[lastIdx]
              : false;
      } else {
        // A blank ln after the block drops its trailing newline.
        // For a type 6/7 block (which ends at a blank ln) a ln
        // holding only whitespace counts as blank. For a type 1-5
        // block (which ends at its closing tag) only a truly empty
        // ln counts: a spaces-only ln does not swallow the
        // newline (a tab ln is content and does not drop it).
        const nextBlank =
          jdx < end && (hb.type >= 6 ? blankLine(lines[jdx]) : lines[jdx].length === 0);
        const tabLine = nextBlank && lines[jdx].includes('\t');
        endsNl = nextBlank && (hb.type === 6 || hb.type === 7 || !tabLine) ? false : nl[lastIdx];
      }
      nodes.push({ type: 'html', lines: content, endsNl });
      idx = jdx;
      continue;
    }
    // Thematic break.
    if (isRule(ln)) {
      closePara();
      nodes.push({ type: 'hr' });
      idx++;
      continue;
    }
    // List (an ordered list interrupts a paragraph only from 1; an
    // empty item never interrupts a paragraph). Inside a list item,
    // though, a marker at the item's own level always starts a nested
    // list, whatever its start number.
    const marker = readItemMarker(ln);
    if (
      marker &&
      (!para || !marker.ordered || marker.start === 1 || kind === 'item') &&
      (!para || marker.content !== '')
    ) {
      closePara();
      const res = readList(lines, nl, idx, end, linkRefs, kind);
      nodes.push(res.node);
      idx = res.next;
      continue;
    }
    // Blockquote.
    if (eatQuote(ln) !== null) {
      closePara();
      const res = readQuote(lines, nl, idx, end, linkRefs);
      nodes.push(res.node);
      idx = res.next;
      continue;
    }
    // Table: a one-ln paragraph followed by a delimiter row whose
    // cell count matches the header row's. Strip definitions from a
    // COPY here: a definition may still be in progress (its title on
    // a later ln), so the real stripping waits for closePara, when
    // the paragraph is complete.
    if (para) {
      const remaining = dropDefinitions([...para.lines], linkRefs, false);
      if (remaining.length === 1) {
        const aligns = readDelimRow(ln);
        const headerCells = aligns ? splitRow(remaining[0]) : null;
        if (aligns && headerCells.length === aligns.length) {
          const table = {
            type: 'table',
            aligns,
            header: headerCells,
            rows: [],
          };
          let jdx = idx + 1;
          while (jdx < end) {
            const l2 = lines[jdx];
            // A ln of only spaces (or empty) ends the table, but a
            // ln holding a tab is a row of empty cells: the tab is
            // real content for the row splitter.
            if (blankLine(l2) && !l2.includes('\t')) break;
            if (eatQuote(l2) !== null) break;
            // A setext underline (=== / ---) is a table row here, not
            // an interrupting start: only ATX, fenceState, HTML block,
            // thematic break, or a list marker ends the table.
            if (atxDepth(l2) > 0) break;
            if (readFenceStart(l2)) break;
            {
              const hb = htmlKind(l2);
              if (hb !== 0 && hb.type !== 7) break;
            }
            if (isRule(l2)) break;
            {
              const m = readItemMarker(l2);
              if (m && (!m.ordered || m.start === 1)) break;
            }
            table.rows.push(splitRow(l2));
            jdx++;
          }
          nodes.push(table);
          para = null;
          idx = jdx;
          continue;
        }
      }
    }
    // Indented code (never interrupts a paragraph).
    if (!para && countIndent(ln) >= 4) {
      const content = [];
      let lastIdx = -1;
      let jdx = idx;
      while (jdx < end) {
        const l2 = lines[jdx];
        if (blankLine(l2)) {
          let kdx = jdx;
          while (kdx < end && blankLine(lines[kdx])) kdx++;
          if (kdx < end && countIndent(lines[kdx]) >= 4) {
            while (jdx < kdx) {
              content.push(cutIndent(lines[jdx], 4));
              lastIdx = jdx;
              jdx++;
            }
            continue;
          }
          break;
        }
        if (countIndent(l2) < 4) break;
        content.push(cutIndent(l2, 4));
        lastIdx = jdx;
        jdx++;
      }
      nodes.push({ type: 'code', info: '', lines: content, endsNl: lastIdx >= 0 ? nl[lastIdx] : false });
      idx = jdx;
      continue;
    }
    // Otherwise this ln continues (or starts) a paragraph.
    if (!para) para = { type: 'para', lines: [] };
    para.lines.push(ln);
    idx++;
  }
  closePara();
  return nodes;
}

// ---------- D. renderer ----------

/** The first word of a fenced-code info string (the language). Backslash
 * escapes are processed first: `\` before ASCII punctuation is dropped. */
function langOf(info) {
  let built = '';
  let p = 0;
  while (p < info.length && (info.charCodeAt(p) === 32 || info.charCodeAt(p) === 9)) p++;
  while (p < info.length) {
    const code = info.charCodeAt(p);
    if (code === 32 || code === 9) break;
    if (code === 92 && p + 1 < info.length && punctCode(info.charCodeAt(p + 1))) {
      built += info[p + 1];
      p += 2;
      continue;
    }
    built += info[p];
    p++;
  }
  return built;
}

function emitBlock(b, linkRefs, buf, tight) {
  switch (b.type) {
    case 'para': {
      const body = b.lines.join('\n');
      if (!tight) buf.push('<p>');
      scanInline(buf, body, 0, body.length, linkRefs, [], false);
      if (!tight) buf.push('</p>\n');
      break;
    }
    case 'heading': {
      const body = b.lines.join('\n');
      buf.push('<h', String(b.level), '>');
      scanInline(buf, body, 0, body.length, linkRefs, [], false);
      buf.push('</h', String(b.level), '>\n');
      break;
    }
    case 'code': {
      buf.push('<pre><code');
      const lang = langOf(b.info);
      if (lang) {
        buf.push(' class="language-');
        buf.push(escapeAttrValue(lang));
        buf.push('"');
      }
      buf.push('>');
      let body = b.lines.join('\n');
      if (b.endsNl && b.lines.length > 0) body += '\n';
      buf.push(escapeHtmlText(body));
      buf.push('</code></pre>\n');
      break;
    }
    case 'html': {
      buf.push(b.lines.join('\n'));
      if (b.endsNl) buf.push('\n');
      break;
    }
    case 'hr': {
      buf.push('<hr>\n');
      break;
    }
    case 'quote': {
      buf.push('<blockquote>\n');
      emitBlocks(b.children, linkRefs, buf, false);
      buf.push('</blockquote>\n');
      break;
    }
    case 'list': {
      if (b.ordered) {
        buf.push('<ol');
        if (b.start !== 1) {
          buf.push(' start="', String(b.start), '"');
        }
        buf.push('>\n');
      } else {
        buf.push('<ul>\n');
      }
      for (const item of b.items) {
        buf.push('<li>');
        const checkbox = item.task !== null
          ? (item.task === 'x'
            ? '<input checked="" disabled="" type="checkbox"> '
            : '<input disabled="" type="checkbox"> ')
          : null;
        if (checkbox !== null && item.children.length > 0 && item.children[0].type === 'para') {
          // The checkbox lives inside the first paragraph's <p> when
          // the list is isLoose, and directly before its body when tight.
          const first = item.children[0];
          const body = first.lines.join('\n');
          if (!b.tight) buf.push('<p>');
          buf.push(checkbox);
          scanInline(buf, body, 0, body.length, linkRefs, [], false);
          if (!b.tight) buf.push('</p>\n');
          for (let kdx = 1; kdx < item.children.length; kdx++) {
            emitBlock(item.children[kdx], linkRefs, buf, b.tight);
          }
        } else {
          if (checkbox !== null) buf.push(checkbox);
          emitBlocks(item.children, linkRefs, buf, b.tight);
        }
        buf.push('</li>\n');
      }
      buf.push(b.ordered ? '</ol>\n' : '</ul>\n');
      break;
    }
    case 'table': {
      buf.push('<table>\n<thead>\n<tr>\n');
      for (let kdx = 0; kdx < b.aligns.length; kdx++) {
        const cell = kdx < b.header.length ? b.header[kdx] : '';
        buf.push('<th');
        if (b.aligns[kdx]) {
          buf.push(' align="', b.aligns[kdx], '"');
        }
        buf.push('>');
        scanInline(buf, cell, 0, cell.length, linkRefs, [], false);
        buf.push('</th>\n');
      }
      buf.push('</tr>\n</thead>\n');
      if (b.rows.length > 0) {
        buf.push('<tbody>');
        for (const row of b.rows) {
          buf.push('<tr>\n');
          for (let kdx = 0; kdx < b.aligns.length; kdx++) {
            const cell = kdx < row.length ? row[kdx] : '';
            buf.push('<td');
            if (b.aligns[kdx]) {
              buf.push(' align="', b.aligns[kdx], '"');
            }
            buf.push('>');
            scanInline(buf, cell, 0, cell.length, linkRefs, [], false);
            buf.push('</td>\n');
          }
          buf.push('</tr>\n');
        }
        buf.push('</tbody>');
      }
      buf.push('</table>\n');
      break;
    }
  }
}

function emitBlocks(nodes, linkRefs, buf, tight) {
  for (const b of nodes) emitBlock(b, linkRefs, buf, tight);
}

/**
 * Render `markdown` to the HTML marked 18.1.3 produces with its default
 * options (gfm on, breaks off). Each case is rendered alone; nothing is
 * cached between calls.
 */
export function parse(markdown) {
  extAutoBlocked = false;
  const body = markdown.replace(/\r\n?/g, '\n');
  const endsWithNewline = body.endsWith('\n');
  const lines = body === '' ? [] : body.split('\n');
  if (endsWithNewline) lines.pop();
  const nl = new Array(lines.length);
  for (let p = 0; p < lines.length; p++) {
    nl[p] = p < lines.length - 1 || endsWithNewline;
  }
  const linkRefs = new Map();
  const nodes = readBlocks(lines, nl, 0, lines.length, linkRefs, false, 'top', false, null);
  const buf = [];
  emitBlocks(nodes, linkRefs, buf, false);
  return buf.join('');
}

export default parse;
