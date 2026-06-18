# Reproduces docs/openlore-demo.gif with charmbracelet/vhs (https://github.com/charmbracelet/vhs).
#
#   npm i -g openlore                                   # or: npm link from this repo
#   git clone --depth 1 https://github.com/django/django /tmp/demo-repo
#   cd /tmp/demo-repo && cp <repo>/.openlore/config.json .openlore/config.json   # (openlore init also works)
#   brew install vhs                                     # needs ffmpeg + ttyd
#   vhs docs/openlore-demo.tape                          # writes /tmp/openlore-demo.gif
#
# Every command below is real openlore output — no edits, no fabricated numbers.

Output "/tmp/openlore-demo.gif"

Set Shell "bash"
Set FontSize 19
Set Width 1240
Set Height 720
Set Padding 22
Set Theme "Catppuccin Mocha"
Set TypingSpeed 22ms

Hide
Type "cd /tmp/demo-repo && clear"
Enter
Show

Sleep 500ms
Type "# Django — a genuinely massive repo: 7,066 files, 2,922 Python modules."
Sleep 400ms
Enter
Sleep 700ms
Type "# Onboard once: static analysis indexes the whole repo. No LLM, no network."
Sleep 300ms
Enter
Type "openlore analyze --no-embed 2>&1 | grep -om1 'Built.*functions)'"
Enter
Sleep 4800ms

Sleep 600ms
Type "# Your agent must change mark_safe(). WITHOUT OpenLore it greps, then reads every hit:"
Sleep 300ms
Enter
Type "grep -rl mark_safe --include='*.py' . | head -n 10"
Enter
Sleep 2200ms
Type "#   ...75 files, 291 references to open and reason about — dozens of round-trips."
Sleep 300ms
Enter
Sleep 1600ms

Hide
Type "clear"
Enter
Show
Type "# WITH OpenLore — one deterministic call:"
Sleep 300ms
Enter
Type "openlore orient --task 'change how mark_safe escapes HTML' --limit 3"
Enter
Sleep 4200ms
Type "#  -> exact file + the 160-caller blast radius + where to edit, in ~0.6s. No guessing."
Sleep 400ms
Enter
Sleep 3200ms
