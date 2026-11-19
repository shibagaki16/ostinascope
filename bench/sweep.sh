#!/bin/bash
# Run eval/seq over the bench sets for several option sets in parallel.
# usage: bench/sweep.sh '<optionsJSON>' ['<optionsJSON>' …]
D=bench/data; mkdir -p $D/sw; rm -f $D/sw/*.txt; i=0
for o in "$@"; do i=$((i+1)); (
  echo "== $o"
  node bench/eval.mjs src/detector.js $D/nviews "$o" | tail -1
  node bench/eval.mjs src/detector.js $D/views "$o" | tail -1
  node bench/seq.mjs src/detector.js src/tracker.js $D/emptyseq "$o" | tail -1
  node bench/seq.mjs src/detector.js src/tracker.js $D/rowseq "$o" | tail -2
) > $D/sw/$i.txt 2>&1 & done; wait; cat $D/sw/*.txt
