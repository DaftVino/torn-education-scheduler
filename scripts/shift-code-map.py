"""Hand-shift docs/code-map.md anchors from the code-map test's own output.

`docs/code-map.md` is hand-curated prose and must never be regenerated — see
CLAUDE.md repo constraint 1 and the map's own header. What IS mechanical is the
line numbers: when a declaration moves, every anchor below it shifts, and doing
that by hand across ~90 rows is error-prone busywork with no judgement in it.

`tests/code-map.test.js` already computes exactly where each symbol really is,
so this reads that report and applies it. Numbers only: it rewrites the final
table cell of the named lines and the recorded userscript length, and touches
no prose. A row whose anchor cell does not match is reported, never guessed at.

Usage:
    npm test 2>&1 | grep -oE 'code-map\\.md:[0-9]+ "[^"]+" spans [^ ]+ but what it names lives at [^ ]+' > anchors.txt
    python scripts/shift-code-map.py anchors.txt
"""
import io
import re
import sys

ANCHOR_CELL = re.compile(r'\|\s*[0-9]+(?:[–-][0-9]+)?\s*\|\s*$')
REPORT = re.compile(
    r'code-map\.md:(\d+) "(.+?)" spans ([0-9–-]+) '
    r'but what it names lives at ([0-9–-]+)'
)

MAP = 'docs/code-map.md'
SOURCE = 'torn-education-scheduler.user.js'


def main(report_path):
    wanted = {}
    for line in io.open(report_path, encoding='utf-8'):
        m = REPORT.match(line.strip())
        if m:
            # Same row is reported by more than one failing test; last wins,
            # and they always agree because both read the same file.
            wanted[int(m.group(1))] = m.group(4)

    lines = io.open(MAP, encoding='utf-8').read().split('\n')
    unmatched = []
    for number, anchor in sorted(wanted.items()):
        i = number - 1
        shifted = ANCHOR_CELL.sub('| %s |' % anchor, lines[i])
        if shifted == lines[i]:
            unmatched.append((number, lines[i][-60:]))
        lines[i] = shifted

    # The same count tests/code-map.test.js computes: splitting on '\n' yields
    # a trailing empty element for a file that ends in a newline, and counting
    # it would record a length one greater than the file has.
    source_lines = io.open(SOURCE, encoding='utf-8').read().split('\n')
    real = len(source_lines) - (1 if source_lines[-1] == '' else 0)
    lines[2] = re.sub(r'\(\d+ lines\)', '(%d lines)' % real, lines[2])

    io.open(MAP, 'w', encoding='utf-8', newline='').write('\n'.join(lines))
    print('shifted %d anchors; userscript recorded at %d lines' % (len(wanted), real))
    if unmatched:
        print('UNMATCHED (fix these by hand):')
        for number, tail in unmatched:
            print('  line %d ... %s' % (number, tail))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
