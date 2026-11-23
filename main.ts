// mend — one command-line tool that applies the edits AI models write, in
// four formats (unified diff, SEARCH/REPLACE blocks, V4A patches and JSON
// text-editor calls), to a tree of files. The whole behaviour is SPEC.md.
// Node and its standard library alone; deterministic.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------- errors

// An exit-2 condition: the single line to print (usage, no-patch, format,
// parse). Thrown from the reading phase, before any file is looked at.
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

// One failed edit: an error code and the path the patch named.
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------- helpers

const blank = (s: string): boolean => s.trim() === '';

// The lines of a patch: split at "\n", one trailing "\r" removed from each,
// and no empty piece after a final "\n" (SPEC section 6).
function patchLines(text: string): string[] {
  const parts = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// A safe path (SPEC section 2): non-empty, no leading "/", no backslash,
// and no empty, "." or ".." segment.
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function needSafe(p: string): void {
  if (!safePath(p)) throw new Fail('unsafe', p);
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => trailTrim(s.replace(/^[ \t]+/, ''));

// ------------------------------------------------- file text and its lines

// A file's text as lines (SPEC section 3): the line break is CRLF when the
// first LF follows a CR, else LF; the lines are the text split at that
// break, and a trailing break leaves no empty last line.
interface TextLines {
  lines: string[];
  br: string;
  tail: boolean; // the text ends with a line break
}

function splitText(text: string): TextLines {
  if (text === '') return { lines: [], br: '\n', tail: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const tail = text.endsWith(br);
  const parts = text.split(br);
  if (tail) parts.pop();
  return { lines: parts, br, tail };
}

function joinText(t: TextLines): string {
  if (t.lines.length === 0) return '';
  return t.lines.join(t.br) + (t.tail ? t.br : '');
}

// ------------------------------------------------------- matching (sect. 5)

function normFor(tier: number): (s: string) => string {
  return tier === 0 ? (s: string) => s : tier === 1 ? trailTrim : bothTrim;
}

// Every start position (at or after `from`) where `old` occurs in `lines`
// at the given tier. Occurrences may overlap.
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const norm = normFor(tier);
  const want = old.map(norm);
  const out: number[] = [];
  for (let i = Math.max(0, from); i + old.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < old.length; k++) {
      if (norm(lines[i + k]!) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  at: number[];
}

// The first tier with at least one occurrence, and its occurrences.
// --strict keeps tier 0 only.
function findTier(lines: string[], old: string[], strict: boolean, from: number): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, old, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

// One line of a hunk or chunk body, in order: a context line, a removed
// line, an added line, or a "\" line (kept only for the no-newline rules).
interface Entry {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
}

function oldOf(entries: Entry[]): string[] {
  return entries.filter((e) => e.kind === 'ctx' || e.kind === 'del').map((e) => e.text);
}

// At tier 2 an added line that is not blank and starts with the old block's
// own leading whitespace P has that P replaced by the file's F.
function reindent(s: string, tier: number, f: string, p: string): string {
  if (tier !== 2 || s.trim() === '' || !s.startsWith(p)) return s;
  return f + s.slice(p.length);
}

// The lines a matched hunk or chunk writes: context lines are the file's
// own matched lines; added lines are written as they are, but for the
// re-indentation of tier 2.
function renderNew(lines: string[], pos: number, entries: Entry[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadWs(lines[pos]!);
    const firstOld = entries.find((e) => e.kind === 'ctx' || e.kind === 'del');
    p = firstOld ? leadWs(firstOld.text) : '';
  }
  let oi = 0;
  for (const e of entries) {
    if (e.kind === 'ctx') {
      out.push(lines[pos + oi]!);
      oi++;
    } else if (e.kind === 'del') {
      oi++;
    } else if (e.kind === 'add') {
      out.push(reindent(e.text, tier, f, p));
    }
  }
  return out;
}

// Does a "\" line follow the body's last context or added line?
function bsAfterLastWritten(entries: Entry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const k = entries[i]!.kind;
    if (k === 'ctx' || k === 'add') return entries[i + 1]?.kind === 'bs';
  }
  return false;
}

// ---------------------------------------------------------------- the tree

// The file tree as the patch sees it: edits read and write through the
// overlay, so later edits see the tree as earlier edits left it, and the
// disk is touched only once every edit has succeeded (SPEC section 10).
class Tree {
  private origCache = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<readonly [string, string]> = [];

  original(p: string): string | null {
    const hit = this.origCache.get(p);
    if (hit !== undefined) return hit;
    let v: string | null = null;
    try {
      if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
    } catch {
      v = null;
    }
    this.origCache.set(p, v);
    return v;
  }

  get(p: string): string | null {
    const n = this.now.get(p);
    return n !== undefined ? n : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree) => void;

// ------------------------------------------------------------- unified diff

interface UHunk {
  a: number;
  entries: Entry[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pair: { old: string | null; new: string | null } | null;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// The path a --- or +++ line names: the text after the four characters, up
// to the first tab, with surrounding spaces removed; "/dev/null" is no
// file, and a leading a/ or b/ is removed.
function headerPath(raw: string): string | null {
  const s = raw.split('\t')[0]!.trim();
  if (s === '/dev/null') return null;
  return s.startsWith('a/') || s.startsWith('b/') ? s.slice(2) : s;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const fresh = (): USection => {
    const s: USection = {
      gitOld: null,
      gitNew: null,
      pair: null,
      renameOld: null,
      renameNew: null,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.*?) b\/(.*)$/.exec(line.slice('diff --git '.length));
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const hm = HUNK_RE.exec(line);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      // The body: lines starting with " ", "-", "+", "\" or empty, ending
      // at the first other line, a diff --git line, a ---/+++ pair, or the
      // end of the patch. Empty lines at the end of a body are not in it.
      const raw: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        const c = b[0];
        if (b === '' || c === ' ' || c === '-' || c === '+' || c === '\\') {
          raw.push(b);
          j++;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const entries: Entry[] = raw.map((b): Entry => {
        if (b === '') return { kind: 'ctx', text: '' };
        const kind = b[0] === ' ' ? 'ctx' : b[0] === '-' ? 'del' : b[0] === '+' ? 'add' : 'bs';
        return { kind, text: b.slice(1) };
      });
      cur.hunks.push({ a: Number(hm[1]), entries });
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!(cur && cur.hunks.length === 0 && !cur.pair)) cur = fresh();
      cur.pair = { old: headerPath(line.slice(4)), new: headerPath(lines[i + 1]!.slice(4)) };
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur && cur.hunks.length === 0 && !cur.pair) {
      // A --- line inside a section's header, not followed by a +++ line.
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (cur && cur.hunks.length === 0) {
      // The rest of the section header: only these lines carry meaning.
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i++;
  }
  return sections;
}

// Apply one section's hunks, in order, each to the result of the last.
// `path` is named in a no-match failure.
function applyUnifiedHunks(text: string, hunks: UHunk[], strict: boolean, path: string): string {
  const t = splitText(text);
  const lines = [...t.lines];
  let tail = t.tail;
  let d = 0; // the sum over applied hunks of (new length - old length)
  for (const h of hunks) {
    const old = oldOf(h.entries);
    if (old.length === 0) {
      // An empty old text: the new lines go after the first A + d lines.
      const adds = h.entries.filter((e) => e.kind === 'add').map((e) => e.text);
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...adds);
      d += adds.length;
      if (atEnd) tail = !bsAfterLastWritten(h.entries);
      continue;
    }
    const found = findTier(lines, old, strict, 0);
    if (!found) throw new Fail('no-match', path);
    // The occurrence whose position is nearest to A - 1 + d, the earlier
    // one on a tie (positions are scanned in order, so only a strictly
    // nearer one replaces the best).
    const target = h.a - 1 + d;
    let pos = found.at[0]!;
    for (const p of found.at) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const rendered = renderNew(lines, pos, h.entries, found.tier);
    const touchesEnd = pos + old.length === lines.length;
    lines.splice(pos, old.length, ...rendered);
    d += rendered.length - old.length;
    // A hunk whose matched lines run to the end of the file decides the
    // final line break; otherwise it stays as it was.
    if (touchesEnd) tail = !bsAfterLastWritten(h.entries);
  }
  return joinText({ lines, br: t.br, tail });
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    // The ---/+++ pair names the paths when there is one; rename from/to
    // name them when no pair does; the diff --git paths when nothing else.
    let oldP: string | null;
    let newP: string | null;
    if (sec.pair) {
      oldP = sec.pair.old;
      newP = sec.pair.new;
    } else {
      oldP = sec.renameOld ?? sec.gitOld;
      newP = sec.renameNew ?? sec.gitNew;
    }
    if (oldP === null && !sec.pair) oldP = newP;
    if (newP === null && !sec.pair) newP = oldP;
    const isCreate = sec.newFile || (sec.pair !== null && sec.pair.old === null);
    const isDelete = !isCreate && (sec.delFile || (sec.pair !== null && sec.pair.new === null));
    if (isCreate) {
      const p = newP ?? '';
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      // The file is the + lines of all its hunks, in order; it ends with a
      // line break unless a "\" line follows its last + line.
      const content: string[] = [];
      let lastAddBs = false;
      for (const h of sec.hunks) {
        h.entries.forEach((e, idx) => {
          if (e.kind === 'add') {
            content.push(e.text);
            lastAddBs = h.entries[idx + 1]?.kind === 'bs';
          }
        });
      }
      tree.set(p, joinText({ lines: content, br: '\n', tail: !lastAddBs }));
      return;
    }
    if (isDelete) {
      const p = oldP ?? '';
      needSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null); // its hunks are not read
      return;
    }
    const o = oldP ?? '';
    const n = newP ?? '';
    needSafe(o);
    if (n !== o) needSafe(n);
    const text = tree.get(o);
    if (text === null) throw new Fail('missing', o);
    if (n !== o && tree.get(n) !== null) throw new Fail('exists', n);
    const result = sec.hunks.length > 0 ? applyUnifiedHunks(text, sec.hunks, strict, o) : text;
    if (n !== o) {
      tree.set(n, result);
      tree.set(o, null);
      tree.moves.push([o, n]);
    } else {
      tree.set(o, result);
    }
  };
}

// --------------------------------------------------------- SEARCH/REPLACE

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let bound = 0; // blocks look for their path at or after this line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    // The block's path: the nearest non-blank line before the SEARCH line,
    // back to the previous block's REPLACE line (or the start), whose
    // trimmed form does not start with three backticks; failing that, the
    // previous block's path.
    let path: string | null = null;
    for (let j = i - 1; j >= bound; j--) {
      const l = lines[j]!;
      if (!blank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let eq = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
    let end = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, end) });
    prevPath = path;
    bound = end + 1;
    i = end + 1;
  }
  return blocks;
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    needSafe(b.path);
    if (b.oldLines.length === 0) {
      // Empty old lines create the file with the new lines.
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const text = tree.get(b.path);
    if (text === null) throw new Fail('missing', b.path);
    const t = splitText(text);
    const found = findTier(t.lines, b.oldLines, strict, 0);
    if (!found) throw new Fail('no-match', b.path);
    if (found.at.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.at[0]!;
    const f = leadWs(t.lines[pos]!);
    const p = leadWs(b.oldLines[0]!);
    const rendered = b.newLines.map((s) => reindent(s, found.tier, f, p));
    const lines = [...t.lines];
    lines.splice(pos, b.oldLines.length, ...rendered);
    tree.set(b.path, joinText({ lines, br: t.br, tail: t.tail }));
  };
}

// --------------------------------------------------------------------- V4A

interface VChunk {
  anchor: string | null;
  entries: Entry[];
  eof: boolean;
}

type VSection =
  | { kind: 'add'; path: string; fileLines: string[] }
  | { kind: 'del'; path: string }
  | { kind: 'upd'; path: string; moveTo: string | null; chunks: VChunk[] };

function v4aHeader(l: string): { kind: 'add' | 'del' | 'upd'; path: string } | null {
  if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice('*** Add File: '.length).trim() };
  if (l.startsWith('*** Delete File: ')) return { kind: 'del', path: l.slice('*** Delete File: '.length).trim() };
  if (l.startsWith('*** Update File: ')) return { kind: 'upd', path: l.slice('*** Update File: '.length).trim() };
  return null;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const h = v4aHeader(l);
    if (!h) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    i++;
    const content: Array<{ text: string; n: number }> = [];
    while (i < last && !v4aHeader(lines[i]!)) {
      content.push({ text: lines[i]!, n: i + 1 });
      i++;
    }
    // Blank lines at the end of a section are not part of it.
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (h.kind === 'add') {
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
        else if (c.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${c.n}`);
      }
      sections.push({ kind: 'add', path: h.path, fileLines });
    } else if (h.kind === 'del') {
      // A Delete File section has no lines.
      for (const c of content) {
        if (!blank(c.text)) throw new Exit2(`error: parse ${c.n}`);
      }
      sections.push({ kind: 'del', path: h.path });
    } else {
      let rest = content;
      let moveTo: string | null = null;
      if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
        rest = rest.slice(1);
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const close = (): void => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (const c of rest) {
        const t = c.text;
        if (t.trim() === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${c.n}`);
          cur.eof = true;
          close();
          continue;
        }
        if (t.startsWith('@@')) {
          close();
          const a = t.slice(2).trim();
          cur = { anchor: a === '' ? null : a, entries: [], eof: false };
          continue;
        }
        const ch = t[0];
        if (t === '' || ch === ' ' || ch === '-' || ch === '+') {
          if (!cur) cur = { anchor: null, entries: [], eof: false };
          const kind = t === '' || ch === ' ' ? 'ctx' : ch === '-' ? 'del' : 'add';
          cur.entries.push({ kind, text: t === '' ? '' : t.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${c.n}`);
      }
      close();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      sections.push({ kind: 'upd', path: h.path, moveTo, chunks });
    }
  }
  return sections;
}

// Apply one Update File section's chunks in order, with a cursor that only
// moves forward through the file.
function applyV4aChunks(text: string, chunks: VChunk[], strict: boolean, path: string): string {
  const t = splitText(text);
  const lines = [...t.lines];
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      // The first line at or after the cursor equal to the anchor, at the
      // first tier where one matches; the cursor moves past it.
      const tiers = strict ? [0] : [0, 1, 2];
      let at = -1;
      for (const tier of tiers) {
        const norm = normFor(tier);
        const want = norm(ch.anchor);
        for (let k = cursor; k < lines.length; k++) {
          if (norm(lines[k]!) === want) {
            at = k;
            break;
          }
        }
        if (at >= 0) break;
      }
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const old = oldOf(ch.entries);
    if (old.length === 0) {
      const adds = ch.entries.filter((e) => e.kind === 'add').map((e) => e.text);
      const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
      lines.splice(at, 0, ...adds);
      cursor = at + adds.length;
      continue;
    }
    const found = findTier(lines, old, strict, cursor);
    if (!found) throw new Fail('no-match', path);
    // The first occurrence at or after the cursor; an end-of-file chunk
    // takes only an occurrence that ends at the file's last line.
    let pos = -1;
    for (const p of found.at) {
      if (!ch.eof || p + old.length === lines.length) {
        pos = p;
        break;
      }
    }
    if (pos < 0) throw new Fail('no-match', path);
    const rendered = renderNew(lines, pos, ch.entries, found.tier);
    lines.splice(pos, old.length, ...rendered);
    cursor = pos + rendered.length;
  }
  return joinText({ lines, br: t.br, tail: t.tail });
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    needSafe(sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      // The file is the section's lines, ended by a line break.
      tree.set(sec.path, joinText({ lines: sec.fileLines, br: '\n', tail: true }));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.set(sec.path, null);
      return;
    }
    const text = tree.get(sec.path);
    if (text === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null) {
      needSafe(sec.moveTo);
      if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    }
    const result = applyV4aChunks(text, sec.chunks, strict, sec.path);
    if (sec.moveTo !== null) {
      tree.set(sec.moveTo, result);
      tree.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.set(sec.path, result);
    }
  };
}

// -------------------------------------------------------------------- JSON

// One edit object: a string path and a command; other keys are ignored.
// Anything else is a parse fault (null here).
function jsonEdit(v: unknown): Edit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  const cmd = o.command;
  if (typeof p !== 'string' || typeof cmd !== 'string') return null;
  if (cmd === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const ft = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, ft); // written byte-for-byte
    };
  }
  if (cmd === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const os = o.old_str;
    const ns = typeof o.new_str === 'string' ? o.new_str : '';
    return (tree) => {
      needSafe(p);
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      // In a CRLF file the texts are read with "\r\n" as "\n" and the
      // result is written back with "\r\n". Exact match; no tiers.
      const crlf = splitText(text).br === '\r\n';
      const hay = crlf ? text.replaceAll('\r\n', '\n') : text;
      const from = crlf ? os.replaceAll('\r\n', '\n') : os;
      const to = crlf ? ns.replaceAll('\r\n', '\n') : ns;
      const hits: number[] = [];
      for (let k = hay.indexOf(from); k >= 0; k = hay.indexOf(from, k + 1)) hits.push(k);
      if (hits.length === 0) throw new Fail('no-match', p);
      if (hits.length > 1) throw new Fail('ambiguous', p);
      const at = hits[0]!;
      const out = hay.slice(0, at) + to + hay.slice(at + from.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (cmd === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const at = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      needSafe(p);
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const t = splitText(text);
      if (at < 0 || at > t.lines.length) throw new Fail('no-match', p);
      const lines = [...t.lines];
      lines.splice(at, 0, ...add);
      tree.set(p, joinText({ lines, br: t.br, tail: t.tail }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    // One JSON array of edit objects; any fault is at the array's line.
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    return v.map((x) => {
      const e = jsonEdit(x);
      if (!e) throw new Exit2(`error: parse ${first + 1}`);
      return e;
    });
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  const edits: Edit[] = [];
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (!e) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ------------------------------------------------------- format detection

type Kind = 'unified' | 'search-replace' | 'v4a' | 'json';

// With --format=auto the format is detected; the first rule that matches
// wins (SPEC section 4).
function detect(lines: string[]): Kind | null {
  const first = lines.find((l) => !blank(l));
  if (first === undefined) return null;
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const fc = first.trimStart()[0];
  if (fc === '[' || fc === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('diff --git ')) return 'unified';
    if (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// -------------------------------------------------------------- the command

const FORMATS: readonly string[] = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function parseArgs(
  args: string[],
): { format: string | null; check: boolean; strict: boolean; file: string | null } | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.length > 1 && a.startsWith('-')) {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return null; // an unknown - argument, or an option given twice
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return null;
  return { format, check, strict, file: pos.length === 0 || pos[0] === '-' ? null : pos[0]! };
}

interface Result {
  code: number;
  out: string[];
}

function run(args: string[]): Result {
  const pa = parseArgs(args);
  if (!pa) return { code: 2, out: ['error: usage'] };
  let text: string;
  if (pa.file === null) {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(pa.file, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = patchLines(text);
  const kind: Kind | null =
    pa.format === null || pa.format === 'auto' ? detect(lines) : (pa.format as Kind);
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, pa.strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => srEdit(b, pa.strict));
    else edits = parseV4a(lines).map((s) => v4aEdit(s, pa.strict));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // The edits apply in patch order, each to the tree as the earlier edits
  // left it; a failed edit changes nothing, and later edits still run.
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (e instanceof Fail) {
        tree.now.clear();
        for (const [k, v] of snapshot) tree.now.set(k, v);
        tree.moves.length = moveCount;
        fails.push(e);
      } else {
        throw e;
      }
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  // The summary: one line per changed path, in byte order; a successful
  // move replaces its pair of D and A lines and sorts by the new path.
  const changed = new Map<string, 'A' | 'D' | 'M'>();
  for (const [p, now] of tree.now) {
    const was = tree.original(p);
    if (was !== now) changed.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: Array<{ key: string; text: string }> = [];
  const consumed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (changed.get(o) === 'D' && changed.get(n) === 'A') {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const [p, k] of changed) {
    if (!consumed.has(p)) rows.push({ key: p, text: `${k} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const out = rows.map((r) => r.text);
  out.push(rows.length === 1 ? 'ok: 1 file' : `ok: ${rows.length} files`);
  if (!pa.check) {
    for (const [p, now] of tree.now) {
      if (tree.original(p) === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now, 'utf8');
      }
    }
  }
  return { code: 0, out };
}

// When MAKEFUN_ENV_URL is set, a sealed trial is waiting: hand over to
// runner.ts. Otherwise mend is the command-line tool of SPEC section 1.
const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
