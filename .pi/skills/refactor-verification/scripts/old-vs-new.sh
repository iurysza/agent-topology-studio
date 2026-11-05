#!/usr/bin/env bash
# Run the same cases against an OLD tree (detached worktree at <base-ref>) and a NEW tree,
# then compare exit code, stdout and stderr after normalising temp paths and ISO timestamps.
#
# Usage: old-vs-new.sh <base-ref> <cases-file> [--new <dir>]
#   cases-file: one case per line, `name<TAB>command`. Blank lines and lines starting with # are skipped.
#   Each command runs under bash with cwd=$ROOT, where:
#     $ROOT  the tree under test (old worktree or new dir)
#     $FIX   a fresh copy of fixtures/playground for this case and side, mtimes pinned
# Env:
#   FIXTURES      fixture source dir (default: <new>/fixtures/playground)
#   CASE_TIMEOUT  seconds per command (default: 60)
#   KEEP_OUT=1    keep the output dir for inspection
# Exit: 0 if every case matches, 1 on any DIFF, 2 on usage or setup errors.
set -euo pipefail

usage() { echo "Usage: $0 <base-ref> <cases-file> [--new <dir>]" >&2; exit 2; }
[[ $# -ge 2 ]] || usage
BASE=$1; CASES=$2; shift 2
NEW=$(git rev-parse --show-toplevel)
while [[ $# -gt 0 ]]; do
  case $1 in
    --new) [[ $# -ge 2 ]] || usage; NEW=$(cd "$2" && pwd); shift 2 ;;
    *) usage ;;
  esac
done
[[ -f $CASES ]] || { echo "No cases file: $CASES" >&2; exit 2; }
FIXTURES=${FIXTURES:-$NEW/fixtures/playground}
[[ -d $FIXTURES ]] || { echo "No fixtures dir: $FIXTURES" >&2; exit 2; }
CASE_TIMEOUT=${CASE_TIMEOUT:-60}
TIMEOUT_BIN=$(command -v timeout || command -v gtimeout || true)

WORK=$(mktemp -d "${TMPDIR:-/tmp}/old-vs-new.XXXXXX")
WORK=$(cd "$WORK" && pwd -P)
OLD=$WORK/old
cleanup() {
  git -C "$NEW" worktree remove --force "$OLD" >/dev/null 2>&1 || true
  git -C "$NEW" worktree prune >/dev/null 2>&1 || true
  if [[ ${KEEP_OUT:-} == 1 ]]; then echo "Output kept in $WORK" >&2; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

git -C "$NEW" worktree add --detach --quiet "$OLD" "$BASE"
[[ -d $NEW/node_modules ]] && ln -s "$NEW/node_modules" "$OLD/node_modules"
# Gitignored build output does not exist in a fresh worktree.
if [[ -d $NEW/web/dist && ! -e $OLD/web/dist ]]; then cp -R "$NEW/web/dist" "$OLD/web/dist"; fi
if [[ -d $NEW/web/node_modules && ! -e $OLD/web/node_modules ]]; then ln -s "$NEW/web/node_modules" "$OLD/web/node_modules"; fi

# Fresh fixture copy with pinned mtimes (mtimes leak into updatedAt and sort order).
fresh_fixture() {
  local dest=$1
  mkdir -p "$(dirname "$dest")"
  cp -R "$FIXTURES" "$dest"
  find "$dest" -exec touch -h -t 202001010000.00 {} +
}

# Replace the side's own paths and ISO timestamps with stable tokens.
normalise() {
  local root=$1 fix=$2
  R=$root F=$fix W=$WORK perl -pe '
    BEGIN { ($r,$f,$w)=@ENV{qw(R F W)}; ($pr=$r)=~s{^/private}{}; ($pf=$f)=~s{^/private}{}; ($pw=$w)=~s{^/private}{}; }
    s/\Q$f\E/<FIX>/g; s/\Q$pf\E/<FIX>/g;
    s/\Q$r\E/<ROOT>/g; s/\Q$pr\E/<ROOT>/g;
    s/\Q$w\E/<WORK>/g; s/\Q$pw\E/<WORK>/g;
    s/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/<TS>/g;
  '
}

run_side() {
  local side=$1 root=$2 name=$3 cmd=$4
  local dir=$WORK/out/$name/$side fix=$WORK/fix/$name/$side/playground
  mkdir -p "$dir"
  fresh_fixture "$fix"
  local code=0
  if [[ -n $TIMEOUT_BIN ]]; then
    (cd "$root" && ROOT=$root FIX=$fix "$TIMEOUT_BIN" "$CASE_TIMEOUT" bash -c "$cmd") >"$dir/stdout.raw" 2>"$dir/stderr.raw" || code=$?
  else
    (cd "$root" && ROOT=$root FIX=$fix bash -c "$cmd") >"$dir/stdout.raw" 2>"$dir/stderr.raw" || code=$?
  fi
  echo "$code" >"$dir/exit"
  normalise "$root" "$fix" <"$dir/stdout.raw" >"$dir/stdout"
  normalise "$root" "$fix" <"$dir/stderr.raw" >"$dir/stderr"
}

ok=0 diff=0 total=0
while IFS=$'\t' read -r name cmd || [[ -n ${name:-} ]]; do
  [[ -z ${name// } || $name == \#* ]] && continue
  [[ -n ${cmd:-} ]] || { echo "Bad case line (need name<TAB>command): $name" >&2; exit 2; }
  [[ $name =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Bad case name (use [A-Za-z0-9._-]): $name" >&2; exit 2; }
  total=$((total + 1))
  run_side old "$OLD" "$name" "$cmd"
  run_side new "$NEW" "$name" "$cmd"
  o=$WORK/out/$name/old n=$WORK/out/$name/new
  channels=()
  for ch in exit stdout stderr; do cmp -s "$o/$ch" "$n/$ch" || channels+=("$ch"); done
  if [[ ${#channels[@]} -eq 0 ]]; then
    ok=$((ok + 1)); echo "OK    $name (exit $(cat "$n/exit"))"
  else
    diff=$((diff + 1)); echo "DIFF  $name [${channels[*]}]"
    for ch in "${channels[@]}"; do diff -u --label "old/$ch" --label "new/$ch" "$o/$ch" "$n/$ch" | sed 's/^/      /' || true; done
  fi
done <"$CASES"

echo "cases: $total, ok: $ok, diff: $diff (base $BASE = $(git -C "$OLD" rev-parse --short HEAD), new $NEW)"
[[ $diff -eq 0 ]]
