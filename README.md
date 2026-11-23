[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nguyentran113/hidden-spec-cli-01/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nguyentran113/hidden-spec-cli-01/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

# mend

`mend` is one command-line tool that applies the edits AI models write to a
tree of files. Models emit edits in several shapes; mend reads all four of
them, works out which lines each edit really names, and applies the whole
patch or none of it.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a file to read the patch from; with no argument, or `-`, the
patch is read from standard input. Options and the patch argument may come
in any order, and `--` ends the options. The behaviour is specified in full
by `SPEC.md`; this README is a tour.

## The four formats

With `--format=auto` (the default) the format is detected from the patch
itself; a named `--format` (`unified`, `search-replace`, `v4a`, `json`)
makes mend read the patch as that format regardless.

- **Unified diff** — `diff --git` sections and bare `---`/`+++` sections,
  with hunks. Line numbers in hunk headers are a hint, not the truth: each
  hunk's old lines are located in the file, and when they occur more than
  once the occurrence nearest the stated line is taken. Sections can also
  create, delete and rename files (`/dev/null`, `new file mode`,
  `deleted file mode`, `rename from`/`rename to`), and `\ No newline at
  end of file` lines are honoured.
- **SEARCH/REPLACE blocks** — a path line, then `<<<<<<< SEARCH`, the old
  lines, `=======`, the new lines and `>>>>>>> REPLACE`. The old lines must
  occur exactly once; empty old lines create the file. Prose and code
  fences around the blocks are ignored.
- **V4A** — `*** Begin Patch` … `*** End Patch`, with `*** Add File:`,
  `*** Delete File:` and `*** Update File:` sections. Updates are a series
  of chunks applied in order with a forward-only cursor; a chunk can be
  anchored on a named line, pinned to the end of the file with
  `*** End of File`, and an update can move the file with `*** Move to:`.
- **JSON** — text-editor tool calls: one JSON array of edit objects, or
  JSON Lines, one object a line. Each object names a `path` and a
  `command`: `create` (write `file_text` byte-for-byte), `str_replace`
  (replace the one occurrence of `old_str` with `new_str`) or `insert`
  (insert `new_str` after line `insert_line`).

## Matching

Models drift: the lines an edit names rarely match the file byte-for-byte.
mend looks for the old lines at three tiers — exactly; then equal after
removing trailing spaces and tabs; then equal after removing leading and
trailing spaces and tabs — and uses the first tier where they occur. At
the third tier the new lines are re-indented from the patch's indentation
to the file's. `--strict` turns the drift off: tier one only. Context
lines are always written as the file's own lines, and a changed file keeps
its own line breaks (LF or CRLF) and its own final line break, except
where a unified hunk's `\` lines say otherwise.

## All or nothing, and what mend prints

Edits apply in patch order, each to the tree as the earlier edits left it.
If every edit succeeds, the files are written and mend prints one line per
changed path — `A`, `D` or `M`, or `R <old> -> <new>` for a move — in byte
order, then `ok: <n> files`. If any edit fails, nothing is written; mend
prints one `error: <code> <path>` line per failed edit (`no-match`,
`ambiguous`, `missing`, `exists`, `unsafe`) and `failed: <k> of <n> edits`,
and exits 1. Before any of that, a patch that cannot be read as edits at
all exits 2 with a single line: `error: usage`, `error: no-patch`,
`error: format` or `error: parse <N>`. `--check` prints exactly what a run
would print and writes nothing. Paths that escape the tree (absolute, or
with `..` segments) are refused as `unsafe`.

## Files

- `main.ts` — the CLI. Node 22, standard library only, deterministic. Its
  last lines hand a sealed trial over to `runner.ts` when
  `MAKEFUN_ENV_URL` is set.
- `runner.ts` — the trial runner; kept as the kit ships it.
- `check.ts` — runs the public practice checks:
  `node check.ts <practice.json> [family ...]`.
- `SPEC.md` — the specification mend implements.
- `LICENSE` — MIT.
