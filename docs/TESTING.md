# Testing guide: rolling out the fork's features

A step-by-step script for you and your local agent. Every test is a command, an
expected result and a PASS/FAIL rule that needs no judgment. It is written so a
simple agent can follow it literally.

**What this covers:** provenance and `memory_explain`, supersession history,
`memory_forget`, dream guardrails, verification, derived concepts, review mode
(API and web UI), profiles, auth/CORS/health, failure handling, the Docker
image, and a multi-week soak period.

**What the automated suite already proves** (CI runs it on every PR): the logic
of every feature, with the model mocked. This guide exists for what a mock cannot
show: how *your* model, bundle, host and Docker behave.

---

## 0. Ground rules (read first, agent included)

1. **Never run anything in this guide against the live bundle.** Every test uses a
   copy under `~/ustory-test/`. The live bundle is only ever *read* (copied).
2. **Do not fix anything.** If a step fails, record it and move on. Paste the
   command output for every FAIL and WARN.
3. **Run tests in order inside a section.** Sections B to I can be done on
   different days; each starts from a fresh copy.
4. **Labels:** `PASS` (met the rule), `FAIL` (did not), `WARN` (the code is fine
   but your model did not follow an instruction; this is prompt-dependent),
   `INFO` (recorded for later, no verdict), `SKIP` (could not run; say why).
5. **LLM-dependent steps are not deterministic.** A model may phrase things
   differently. The PASS rules therefore check *files and exit codes*, never
   the model's wording.
6. **Stop and report** if you see anything touching `$LIVE`, any `rm -rf` that is
   not under `$WORK`, or a secret in the output.

---

## 1. Setup (about 15 minutes, once)

### 1.1 Update the code

```bash
cd ~/understory                       # your clone of REASON-labs/understory
git remote -v | head -1               # must say REASON-labs/understory
git status --short                    # must print nothing
git checkout main && git pull origin main
pnpm install && pnpm -r build
pnpm test                             # expect: all green (core 250+, server 73+)
```

**PASS:** build has no errors and `pnpm test` ends green.

### 1.2 The test environment file

Create `~/ustory-test/env.sh` (never commit it; it holds your key). Edit the four
`LLM_*` lines to match your live server. **The address must be reachable from this
machine itself:** `host.docker.internal` only works inside Docker, so use
`localhost` (or the real address) here.

```bash
mkdir -p ~/ustory-test/logs
cat > ~/ustory-test/env.sh <<'EOF'
export REPO=~/understory
export WORK=~/ustory-test
export LIVE=/home/jay/ai/memory/understory
export LLM_API_BASE_URL=http://localhost:8080/v1
export LLM_API_KEY=changeme
export LLM_API_FORMAT=openai
export LLM_MODEL=changeme

start_server() {   # start_server <name> <port> <bundle> [VAR=value ...]
  local name=$1 port=$2 bundle=$3; shift 3
  (cd "$REPO" && env "$@" PORT="$port" BUNDLE_ROOT="$bundle" nohup node packages/server/dist/index.js \
     > "$WORK/logs/$name.log" 2>&1 & echo $! > "$WORK/$name.pid")
  sleep 5; curl -s "http://localhost:$port/health"; echo
}
stop_server() { [ -f "$WORK/$1.pid" ] && kill "$(cat "$WORK/$1.pid")" 2>/dev/null; rm -f "$WORK/$1.pid"; sleep 1; }
mc()  { node "$REPO/scripts/mcp-call.mjs" "http://localhost:${PORT_T:-3801}/mcp" "${KEY:--}" "$@"; }
api() { curl -s -H "Authorization: Bearer ${KEY:-}" "http://localhost:${PORT_T:-3801}$1"; }
# fingerprint of all concept files (ignores index.md, log.md, .git, and line endings)
fp()  { (cd "$1" && find . -name '*.md' ! -name index.md ! -name log.md -not -path './.git/*' | sort \
          | while read -r f; do echo "$f"; tr -d '\r' < "$f"; done) | sha256sum | cut -c1-12; }
EOF
source ~/ustory-test/env.sh
curl -s -m 5 "$LLM_API_BASE_URL/models" | head -c 200; echo
```

**PASS:** the last command prints JSON (a model list). If it prints nothing, fix
`LLM_API_BASE_URL` before going on; every LLM test depends on it.

In every new shell: `source ~/ustory-test/env.sh`.

### 1.3 The test bundles

```bash
source ~/ustory-test/env.sh
cd $REPO
node scripts/make-test-bundle.mjs $WORK/synthetic-template     # a predictable bundle
cp -a $LIVE $WORK/live-copy                                    # a copy of your real memory
DREAM_SIGNALS=all node scripts/dream-now.mjs $WORK/synthetic-template --dry-run
```

**PASS:** the template builds ("Test bundle ready") and the dry run reports ran
`false` with signals `orphans`, `links`, `oversized`, `duplicates` and `insights`
(counts of roughly 7, 1, 1, 1, 10). The dry run costs no tokens.

For each test group below you make a **fresh copy** so tests cannot affect each
other: `cp -a $WORK/synthetic-template $WORK/s1`, then `s2`, and so on.

### 1.4 Results file

```bash
cat > $WORK/results.md <<'EOF'
# Results (fill in PASS/FAIL/WARN/INFO/SKIP and a note)
EOF
```

Append one line per test, for example:
`echo "A1 PASS added concept, cited url" >> $WORK/results.md`.

---

## 2. Automated rollout script (about 10 minutes)

The repo has a script that exercises add, update, explain, forget (dry run, mixed
rewrite, delete) and the tombstone against a copy. Run it twice:

```bash
source ~/ustory-test/env.sh && cd $REPO
node scripts/rollout-test.mjs $WORK/synthetic-template  | tee $WORK/rollout-synthetic.txt | tail -45
node scripts/rollout-test.mjs $LIVE                      | tee $WORK/rollout-live.txt      | tail -45
```

(It copies the bundle itself and deletes its copy; `$LIVE` is only read.)

| ID | Rule |
|---|---|
| R1 | the line `VERDICT:` says `ALL CHECKS PASSED` for the synthetic bundle |
| R2 | same for the live bundle |
| R3 | `1c` (model cited the URL) is `PASS`, else `WARN` (not a failure) |
| R4 | `3c` (model recorded what it replaced) is `PASS`, else `WARN` |

Any `FAIL` line is a real finding: paste the whole output.

---

## 3. Manual tests

Conventions: `S` is the bundle copy for the group; `PORT_T` the port;
`mc` calls an MCP tool; every `mc` exits 0 on success and 1 when the tool reports
an error.

### A. Everyday behaviour (regression)

```bash
source ~/ustory-test/env.sh
cp -a $WORK/synthetic-template $WORK/s1 && S=$WORK/s1 && PORT_T=3801
start_server s1 3801 $S
```

**A1 add.**
```bash
mc memory_add '{"content":"The Helios cache keeps entries for 90 seconds. Source: https://example.com/helios-spec"}'; echo "exit=$?"
grep -ril helios $S --include='*.md' | grep -v '/index.md\|/log.md'
git -C $S log --oneline | head -3
```
PASS: exit 0; at least one concept file mentions Helios; the newest commit is a
`creation:` or `update:` commit.

**A2 provenance of A1.** Take the concept path from A1 (for example `/projects/helios.md`).
```bash
mc memory_explain '{"path":"/projects/helios.md"}'
```
PASS: output has a `## Sources` section containing a `trace:` entry.
Mark the result WARN (not FAIL) if `https://example.com/helios-spec` is not also
listed: your model did not cite the URL.

**A3 query.**
```bash
mc memory_query '{"question":"How long does the Helios cache keep entries?"}'
```
PASS: the answer contains `90`.

**A4 update, supersession.**
```bash
mc memory_update '{"instruction":"The Helios cache now keeps entries for 120 seconds, not 90."}'; echo "exit=$?"
F=$(grep -ril helios $S --include='*.md' | grep -v '/index.md\|/log.md' | head -1); echo $F
sed -n '1,25p' "$F"
```
PASS: exit 0, and the body mentions `120` and does **not** still say `90 seconds`.
Then: if the frontmatter has a `history:` list whose `was:` mentions 90, record
PASS; if there is no `history:` record WARN (model ignored `replaced`).

**A5 repeat edits keep earlier provenance.** Run one more small update (for
example "Add that the Helios cache owner is Platform.") then re-read the file.
PASS: every `ref:` listed after A2 is still present (the list only grows; run
citations beyond the newest 10 are trimmed, nothing else).

**A6 status and health.**
```bash
mc memory_status | head -20
node $REPO/scripts/soak-report.mjs http://localhost:3801 -
```
PASS: `memory_status` prints JSON with `"conformant": true`; the soak report
ends `RESULT: all quiet.` (dreaming OFF is fine here).

**A7 web UI smoke (a human does this, 3 minutes).** Open
`http://localhost:3801`. PASS if all of these hold: the tree shows concepts but
**no** `index.md` entries; clicking a concept shows its text; the Graph view
draws nodes; the chat box answers "What is the Helios cache TTL?"; the sidebar
has a **Dreams / reviews** entry that opens without an error.

```bash
stop_server s1
```

### B. Evidence on older concepts

Concepts written before this fork had no sources. They must say so honestly.
```bash
cp -a $WORK/synthetic-template $WORK/s2 && S=$WORK/s2 && PORT_T=3802 && start_server s2 3802 $S
mc memory_explain '{"path":"/misc/lunch.md"}'
mc memory_explain '{"path":"/svc/billing.md"}'
mc memory_explain '{"path":"/nope.md"}'; echo "exit=$?"
```
- **B1** (lunch, no sources): output contains `No sources recorded` under Caveats. PASS.
- **B2** (billing): lists `https://example.com/billing-runbook` with its quote. PASS.
- **B3** (missing): exit **1** and a "Concept not found" message. PASS.

### C. Forget (`memory_forget`)

Fixtures in the synthetic bundle: `/people/dana.md` cites
`https://example.com/hr-memo` ("Dana is allergic to peanuts.");
`/ops/handbook.md` cites only `https://example.com/ops-wiki`.

```bash
cp -a $WORK/synthetic-template $WORK/s3 && S=$WORK/s3 && PORT_T=3803 && start_server s3 3803 $S
BEFORE=$(fp $S)
```

**C1 dry run is the default and changes nothing.**
```bash
mc memory_forget '{"source":"https://example.com/hr-memo"}'; echo "exit=$?"
[ "$(fp $S)" = "$BEFORE" ] && echo UNCHANGED
ls -a $S | grep -c forgotten
```
PASS: output starts `DRY RUN`; `/people/dana.md` is listed under Delete (its only
origin is that memo); `UNCHANGED` printed; `0` forgotten files.

**C2 exactly one target is required.**
```bash
mc memory_forget '{}'; echo "exit=$?"
```
PASS: exit 1, message says `exactly one`.

**C3 mixed provenance is rewritten, not deleted.** First give Dana a second source:
```bash
mc memory_update '{"instruction":"Add to Dana: she is on the Platform team, per https://example.com/team-page. Keep everything else."}'
mc memory_forget '{"source":"https://example.com/hr-memo"}'
```
PASS: the plan now lists `/people/dana.md` under **Rewrite** (not Delete). If your
model did not cite the team page, `Rewrite` will be empty and Dana stays under
Delete: record WARN and skip C4.

**C4 apply the rewrite.**
```bash
mc memory_forget '{"source":"https://example.com/hr-memo","dry_run":false}'; echo "exit=$?"
grep -ril peanut $S --include='*' 2>/dev/null | grep -v '/\.git/'
grep -i platform $S/people/dana.md
```
PASS: exit 0 and the output starts `Forgotten.`; the `grep peanut` prints **nothing**
(not in concepts, log, index or traces); Dana still mentions Platform. If the output
lists a **Warnings** block, record WARN and paste it (a known excerpt survived).
Git history still has the text: expected (see Known limits).

**C5 full delete and cleanup.**
```bash
mc memory_forget '{"source":"https://example.com/ops-wiki","dry_run":false}'; echo "exit=$?"
ls $S/ops 2>&1 | head -2
ls -a $S | grep forgotten
grep -c "ops/handbook" $S/log.md
```
PASS: exit 0; `/ops/handbook.md` is gone (the empty `ops/` directory is pruned too, so `ls` may
report that it does not exist, which also counts); `.forgotten.json` exists; the log has `0`
lines naming the handbook.

**C6 forgotten sources cannot come back.**
```bash
mc memory_add '{"content":"The ops wiki at https://example.com/ops-wiki says deploys are on Tuesdays."}'; echo "exit=$?"
```
PASS: exit **1**, message contains `forgotten`, and no new file mentions deploys.

**C7 known limit (INFO only).** Re-add the same *idea* without the URL:
`mc memory_add '{"content":"The operations handbook says deploys happen on Tuesdays."}'`.
This is **allowed**; a paraphrase with no reference cannot be matched. Record INFO
whether it was accepted. This is documented, not a bug.

```bash
stop_server s3
```

### D. Dreams

Dreaming is the one feature that changes memory unattended. Test it in this order.

```bash
cd $REPO
cp -a $WORK/synthetic-template $WORK/s4
```

**D1 dry run costs nothing.**
```bash
DREAM_SIGNALS=all node scripts/dream-now.mjs $WORK/s4 --dry-run | head -12
```
PASS: `"ran": false`, signals listed, `"filesChanged": []`.

**D2 default signals leave duplicate-merging off.**
```bash
node scripts/dream-now.mjs $WORK/s4 --dry-run | grep -A2 suppressed
```
PASS: `duplicates` appears under `suppressed`, not under `signals`.

**D3 review mode: a dream lands on a branch, the live memory is untouched.**
```bash
HEAD0=$(git -C $WORK/s4 rev-parse HEAD); FP0=$(fp $WORK/s4)
node scripts/dream-now.mjs $WORK/s4 --mode review | tee $WORK/d3.json | head -30
echo "head same: $([ "$(git -C $WORK/s4 rev-parse HEAD)" = "$HEAD0" ] && echo yes || echo NO)"
echo "files same: $([ "$(fp $WORK/s4)" = "$FP0" ] && echo yes || echo NO)"
git -C $WORK/s4 branch --list 'dream/*'
```
PASS: `outcome` is `success`; `review.branch` is `dream/<timestamp>`; both "same" lines
say `yes`; the branch exists. (If outcome is `too_broad`, `unverified` or `rolled_back`,
the safety net worked: record INFO with the summary and repeat once.)

**D4 read, accept, undo.** Start the server on the copy and use the API:
```bash
PORT_T=3804; start_server s4 3804 $WORK/s4
api /api/dream/reviews | head -c 400; echo
ID=$(api /api/dream/reviews | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].id))'); echo $ID
api /api/dream/reviews/$ID/diff | head -40
curl -s -X POST -H "Authorization: Bearer ${KEY:-}" http://localhost:3804/api/dream/reviews/$ID/accept | head -c 400; echo
git -C $WORK/s4 log --oneline | head -3
```
PASS: the diff shows concept changes (no `index.md` or `log.md` noise); accept returns
`"ok":true` with a `revertCommand`; the newest commit starts with `dream: accept`.
Then undo it with that exact `revertCommand` (run inside `$WORK/s4`) and check
`fp $WORK/s4` equals `$FP0` again. PASS if it does.

**D5 reject.**
```bash
cp -a $WORK/synthetic-template $WORK/s5
node scripts/dream-now.mjs $WORK/s5 --mode review > /dev/null
PORT_T=3805; start_server s5 3805 $WORK/s5
ID=$(api /api/dream/reviews | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].id))')
curl -s -X POST -H "Authorization: Bearer ${KEY:-}" http://localhost:3805/api/dream/reviews/$ID/reject; echo
git -C $WORK/s5 branch --list 'dream/*' | wc -l
```
PASS: reject answers success and the branch count is `0`; the live files are unchanged.

**D6 only one review at a time.** With a review pending, run the dream again.
PASS: the report says `review pending` and `"ran": false`.

**D7 change budget.**
```bash
cp -a $WORK/synthetic-template $WORK/s6
DREAM_MAX_CHANGES=1 DREAM_SIGNALS=all node scripts/dream-now.mjs $WORK/s6 --mode apply | grep -E '"outcome"|"summary"' 
```
PASS (either): `too_broad` (then `git -C $WORK/s6 status --short` is empty and the concept
fingerprint equals the template's), **or** `success` with at most one file changed.

**D8 a dream that runs out of steps is rolled back, not kept half-done.**
```bash
cp -a $WORK/synthetic-template $WORK/s7; FP0=$(fp $WORK/s7)
AGENT_MAX_STEPS=2 DREAM_SIGNALS=all node scripts/dream-now.mjs $WORK/s7 --mode apply | grep -E '"outcome"|used all'
echo "unchanged: $([ "$(fp $WORK/s7)" = "$FP0" ] && echo yes || echo NO)"
```
PASS: outcome `rolled_back`, summary says `used all 2 steps`, `unchanged: yes`.
(With 2 steps the model almost certainly runs out. If it did not, record INFO.)

**D9 derived overviews (needs the insights signal alone).**
```bash
cp -a $WORK/synthetic-template $WORK/s8
DREAM_SIGNALS=insights node scripts/dream-now.mjs $WORK/s8 --mode apply | tee $WORK/d9.json | grep -E '"outcome"|filesChanged' -A4 | head -14
grep -l "derived: true" $WORK/s8 -r --include='*.md' | grep -v '/\.git/'
```
PASS: if a new overview concept was written, its frontmatter has `derived: true` and a
`sources:` list naming concept paths such as `/svc/billing.md`. If the model wrote
nothing ("do not force an insight" is allowed), record INFO. Then:
`mc memory_explain` on the overview must contain `DERIVED`; and a search for a word in
both the overview and a primary concept (`curl` `/api/search?q=billing`) must list the
primary concept **before** the derived one.

**D10 verification can be switched off (and back on).**
```bash
DREAM_VERIFY=false DREAM_SIGNALS=orphans node scripts/dream-now.mjs $WORK/s8 --dry-run | head -5
```
PASS: runs without error. Verification *failures* cannot be forced with a real model;
they are covered by automated tests. During the soak watch for outcome `unverified`
and read its reasons (section 5).

### E. Forget and dream reviews together

```bash
cp -a $WORK/synthetic-template $WORK/s9
node scripts/dream-now.mjs $WORK/s9 --mode review > $WORK/e1.json
PORT_T=3809; start_server s9 3809 $WORK/s9
api /api/dream/reviews | head -c 500
```
Pick any path from the review's `filesChanged` (call it `/misc/printer.md`).
```bash
mc memory_forget '{"path":"/misc/printer.md"}'
```
PASS: the dry run lists the review id under `Pending dream reviews ... to reject`.
Then apply it with `"dry_run":false`: PASS if `git -C $WORK/s9 branch --list 'dream/*'`
now prints nothing. (If the dream did not touch that concept the list is empty: pick
another path from `filesChanged`.)

### F. Profiles

```bash
mkdir -p $WORK/profiles; export PROFILES_ROOT=$WORK/profiles
cd $REPO
node packages/server/dist/profiles-cli.js create alpha     # copy the usk_... key shown
node packages/server/dist/profiles-cli.js create beta      # copy that key too
export KEY_A=usk_...  KEY_B=usk_...
(cd $REPO && env PORT=3811 nohup node packages/server/dist/index.js > $WORK/logs/profiles.log 2>&1 & echo $! > $WORK/profiles.pid); sleep 5
curl -s http://localhost:3811/health; echo
```
**F1 a key is required.** `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3811/api/tree` prints `401`. PASS.

**F2 each key sees its own memory.**
```bash
PORT_T=3811
KEY=$KEY_A mc memory_add '{"content":"ALPHAONLY: the alpha vault code is 4417."}'
KEY=$KEY_B mc memory_add '{"content":"BETAONLY: the beta garage code is 9921."}'
curl -s -H "Authorization: Bearer $KEY_A" http://localhost:3811/api/profile; echo
curl -s -H "Authorization: Bearer $KEY_B" "http://localhost:3811/api/search?q=ALPHAONLY"; echo
curl -s -H "Authorization: Bearer $KEY_A" "http://localhost:3811/api/search?q=BETAONLY"; echo
grep -r BETAONLY $WORK/profiles/alpha --include='*' | grep -v '/\.git/' | wc -l
```
PASS: `/api/profile` names `alpha`; both cross searches return `[]`; the last count is
`0` (the other profile's text is not even on alpha's disk).

**F3 forget is per profile.** Add the same sourced fact to both, forget it in alpha only:
```bash
for K in $KEY_A $KEY_B; do KEY=$K mc memory_add '{"content":"SHARED fact: the printer queue is Q7. Source: https://example.com/it-memo"}'; done
KEY=$KEY_A mc memory_forget '{"source":"https://example.com/it-memo","dry_run":false}' | head -3
curl -s -H "Authorization: Bearer $KEY_B" "http://localhost:3811/api/search?q=printer" | head -c 200; echo
ls -a $WORK/profiles/alpha | grep forgotten; ls -a $WORK/profiles/beta | grep -c forgotten
```
PASS: alpha reports `Forgotten`, beta still finds the printer fact, alpha has a
`.forgotten.json`, beta has none (`0`).

**F4 AUTH_TOKEN is ignored in profile mode** (documented): nothing to run; just confirm the
startup log says so when `AUTH_TOKEN` is set.
`kill $(cat $WORK/profiles.pid)` when done.

### G. Auth, CORS, health

```bash
cp -a $WORK/synthetic-template $WORK/s10
start_server s10 3821 $WORK/s10 AUTH_TOKEN=secret123
curl -s -o /dev/null -w "health no token: %{http_code}\n" http://localhost:3821/health
curl -s -o /dev/null -w "tree no token:   %{http_code}\n" http://localhost:3821/api/tree
curl -s -o /dev/null -w "tree with token: %{http_code}\n" -H "Authorization: Bearer secret123" http://localhost:3821/api/tree
curl -s -D - -o /dev/null -H "Origin: http://evil.example" -H "Authorization: Bearer secret123" http://localhost:3821/api/tree | grep -ic access-control-allow-origin
curl -s -X POST -H "Authorization: Bearer secret123" -H "Content-Type: application/json" -d '{bad' http://localhost:3821/api/chat | head -c 120; echo
stop_server s10
```
PASS: `200`, `401`, `200`; the CORS count is `0` (no header for a foreign origin);
the bad JSON gets a JSON error, not an HTML page.
Then `AUTH_REQUIRED=true` without a token: start the server with that and no
`AUTH_TOKEN`: PASS if it refuses to start and the log says so.

### G2. Read-only access

A second token lets an agent read the memory but never change it.
```bash
cp -a $WORK/synthetic-template $WORK/s12
start_server s12 3823 $WORK/s12 AUTH_TOKEN=fulltok AUTH_TOKEN_READONLY=rotok
PORT_T=3823
KEY=rotok mc list
KEY=rotok mc memory_status | head -3; echo "exit=$?"
for t in 'memory_add {"content":"x"}' 'memory_update {"instruction":"x"}' 'memory_forget {"path":"/people/dana.md","dry_run":false}' 'memory_maintain {}'; do
  set -- $t; KEY=rotok mc "$1" "${t#* }" 2>&1 | head -1
done
curl -s -o /dev/null -w "write tool, raw HTTP: %{http_code}\n" -X POST -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer rotok' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_forget","arguments":{}}}' http://localhost:3823/mcp
curl -s -o /dev/null -w "chat with read-only token: %{http_code}\n" -X POST -H 'Authorization: Bearer rotok' -H 'Content-Type: application/json' -d '{"messages":[]}' http://localhost:3823/api/chat
curl -s -o /dev/null -w "tree with read-only token: %{http_code}\n" -H 'Authorization: Bearer rotok' http://localhost:3823/api/tree
ls $WORK/s12/people/dana.md
stop_server s12
```
- **G2a** `mc list` shows exactly three tools: `memory_query`, `memory_status`, `memory_explain`. PASS.
- **G2b** `memory_status` works with the read-only token (exit 0). PASS.
- **G2c** each of the four write calls prints a "read-only and cannot call ..." message and the raw HTTP request answers **403**. PASS.
- **G2d** chat with the read-only token answers **403**, the tree answers **200**. PASS.
- **G2e** `dana.md` still exists (nothing was forgotten). PASS.
- **G2f** with the **full** token (`KEY=fulltok mc list`) all seven tools are listed. PASS.
- **G2g** start the server with `AUTH_TOKEN_READONLY=x` and **no** `AUTH_TOKEN`: PASS if it refuses to start and says so.
- **G2h** start it with no tokens on the default interface: PASS if the log shows `WARNING: auth is OFF`.

### H. Failure handling

**H1 the model is unreachable: nothing is half-written.**
```bash
cp -a $WORK/synthetic-template $WORK/s11; FP0=$(fp $WORK/s11)
start_server s11 3822 $WORK/s11 LLM_API_BASE_URL=http://127.0.0.1:9/v1
PORT_T=3822 mc memory_add '{"content":"Offline test fact."}'; echo "exit=$?"
echo "unchanged: $([ "$(fp $WORK/s11)" = "$FP0" ] && echo yes || echo NO)"
stop_server s11
```
PASS: exit 1, message starts `Mutation failed`, `unchanged: yes`.

**H1b a deadline makes a slow add finish in time instead of being aborted.** Your calling
agent aborts a mutation after a fixed time (about 300 s). With `AGENT_MUTATION_DEADLINE` the
run must be finished before that. Use 30s here so it is quick to see.
```bash
cp -a $WORK/synthetic-template $WORK/s13
start_server s13 3824 $WORK/s13 AGENT_MUTATION_DEADLINE=30s
grep "mutation deadline" $WORK/logs/s13.log
S0=$(date +%s)
PORT_T=3824 mc memory_add '{"content":"The Helios cache keeps entries for 90 seconds, per https://example.com/helios-spec. Link it to anything related."}'; echo "exit=$?"
echo "seconds: $(( $(date +%s) - S0 ))"
grep -ril helios $WORK/s13 --include='*.md' | grep -v '/index.md\|/log.md' | head -2
stop_server s13
```
PASS: the startup log says `mutation deadline: 30s`; the call returns in about 30 to 60 seconds
(not minutes). Then either (a) exit 0, a concept mentioning Helios exists, and the answer ends with
"reached its time limit and was moved to a write-only phase", or (b) exit 1 with a message saying it
"reached its ... deadline before storing anything, so nothing was saved" (and no Helios file).
Both are correct; the failure is that it ran past the deadline or was reported as success with
nothing stored. Run the same add once on a server **without** the deadline and note how long it takes
(INFO): if that is near your caller's timeout, set the deadline to about 90% of it.

**H2 restart keeps everything.** After section C, stop and start the s3 server again.
PASS: the forgotten source is still refused (repeat C6), concepts are intact, a
pending review from D (if any) still lists.

**H3 git missing is explained, not silent** (optional, needs a spare shell): run the
server with `PATH` stripped of git and no `GIT_AUTOCOMMIT=false`: PASS if it refuses to
start and names `GIT_AUTOCOMMIT=false` as the way out.

### I. Docker image (rehearse the real deploy path on a copy)

Your normal stack keeps running; this uses a different project name and port.
```bash
mkdir -p $WORK/compose-test && cd $WORK/compose-test
sed -e 's#"3800:3800"#"3831:3800"#' -e "s#build: \\.#build: $REPO#" $REPO/docker-compose.yml > docker-compose.yml
cat > .env <<EOF
BUNDLE_PATH=$WORK/live-copy
LLM_API_BASE_URL=http://host.docker.internal:8080/v1
LLM_API_KEY=changeme
LLM_API_FORMAT=openai
LLM_MODEL=changeme
EOF
docker compose -p ustory-test config | grep -A1 ':/bundle'
docker compose -p ustory-test up -d --build
sleep 15
docker compose -p ustory-test ps
curl -s http://localhost:3831/health; echo
docker compose -p ustory-test exec understory env | grep -E '^(GIT_AUTOCOMMIT|DREAM_|AGENT_MAX|LLM_TIMEOUT|MUTATION_ROLLBACK|CORS)'
docker compose -p ustory-test exec understory git --version
```
(Set the four `LLM_*` lines to your real values, using the address the **container**
can reach, normally `host.docker.internal`.)

- **I1** build finishes with no error. PASS.
- **I2** `config` shows the source as `.../ustory-test/live-copy` (not the sample bundle). PASS.
- **I3** `ps` shows the service `healthy` (give it up to a minute) and `/health` answers `ok`. PASS.
- **I4** `env` lists the forwarded names (empty values are fine): proves settings reach the container. PASS.
- **I5** `git --version` prints a version. PASS.
- **I6** an add through the container writes **and commits** to the mounted copy:
  `PORT_T=3831 mc memory_add '{"content":"Container test fact ZETA-77."}'` then
  `git -C $WORK/live-copy log --oneline | head -2` shows a new commit. PASS.
  (A file-ownership or `safe.directory` problem would show here as a missing commit.)
- **I7** teardown and rollback rehearsal:
  `docker compose -p ustory-test down`, then in `$REPO` run `git checkout HEAD~1`,
  rebuild the same way, confirm `/health`, then `git checkout main`. PASS if both
  versions start. This is your rollback plan, proven.

---

## 4. Results and go/no-go

Paste `$WORK/results.md` and the output of every FAIL/WARN. Decide with this table:

| Condition | Decision |
|---|---|
| Any `FAIL` in sections C (forget), D3-D5 (review mode), F (profiles) or I (Docker) | **Do not deploy.** Send me the output. |
| `FAIL` in A, B, G, H | Fix before deploying; not a data-safety risk but a regression. |
| Only `WARN`s (model ignored `replaced`, did not cite a URL, did not mark an overview derived) | **Safe to deploy.** Say which WARNs so the prompts can be tightened. |
| Everything `PASS`/`INFO` | **Deploy** (section 6), then start the soak. |

---

## 5. The soak period (2 to 4 weeks)

Goal: see how dreams behave on real memory, with a human in the loop, before
trusting them unattended.

**Setup on the live server** (after a deploy and a backup, section 6): set
`DREAM_INTERVAL=6h` and `DREAM_MODE=review` in the live `.env`, then restart the
stack. Every dream now waits on a branch for you; nothing changes without your accept.

**Daily (2 minutes), from any shell:**
```bash
node ~/understory/scripts/soak-report.mjs http://localhost:3800 -       # add the key instead of - if AUTH_TOKEN is set
```
It prints whether dreaming is on, the last runs and their outcomes, and any pending
reviews. Lines marked `!!` need a look. Exit code 1 means the same.

**For each pending review:** read the diff in the web UI (**Dreams / reviews**) or
`api /api/dream/reviews/<id>/diff`, then accept or reject. Keep a one-line note in
`$WORK/soak.md`: date, review id, accept/reject, why.

**Weekly (10 minutes):**
```bash
git -C $LIVE log --oneline --grep '^dream:' | head -20
git -C $LIVE branch --list 'dream/*'
node ~/understory/scripts/soak-report.mjs http://localhost:3800 -
```
and write down: dreams run, outcomes (success / too_broad / unverified / rolled_back),
how many you accepted, anything wrong you noticed in an accepted dream.

**Read these outcomes carefully:**
- `too_broad`: the model tried to change more than `DREAM_MAX_CHANGES` and was undone. Fine
  occasionally; frequent means the limit or the instructions need tuning.
- `unverified`: a check caught something. The summary lists exactly what. Always paste
  these to me; they are the most valuable data in the soak.
- `rolled_back` with "used all N steps": the model needs more room (`AGENT_MAX_STEPS`).

**Graduating from review to apply mode** (only then set `DREAM_MODE=apply` or unset it):
all of these hold for at least two weeks:
1. at least 10 dreams ran;
2. you accepted at least 90% of them;
3. no accepted dream contained something you had to fix by hand;
4. no `unverified` outcome you could not explain;
5. you have rehearsed an undo (`git revert -m 1 <accept commit>`) at least once on live.

Stop the soak and report immediately if: a dream removes knowledge you wanted, a
`dream:` commit appears that you did not expect, the server will not start, or disk or
memory use climbs steadily.

---

## 6. Deploying to the live server

Only after section 4 says deploy. In order:

```bash
cd ~/understory
git rev-parse HEAD > ~/understory-previous-commit.txt          # the way back for code
cp -a $LIVE ~/understory-bundle-backup-$(date +%Y%m%d-%H%M)    # the way back for data
grep -n BUNDLE_PATH .env                                      # must point at the real bundle
git pull origin main
docker compose up -d --build
sleep 15 && docker compose ps && curl -s http://localhost:3800/health
node scripts/soak-report.mjs http://localhost:3800 -
```
Rollback: `git checkout $(cat ~/understory-previous-commit.txt) && docker compose up -d --build`.
To undo one bad dream: `git -C $LIVE revert -m 1 <commit>` (the accept commit) or
`git -C $LIVE revert <commit>` for an apply-mode `dream:` commit; stop the container first
if you restore the whole backup directory.

---

## Known limits (do not report these as bugs)

- **Git history keeps forgotten text.** `memory_forget` cleans the working files, log,
  traces and caches, and blocks re-adding; it does not rewrite git history. Do that
  separately (for example `git filter-repo`) if it matters.
- **A paraphrase with no URL or path is not blocked** after a forget (test C7).
- **The rewrite step of forget is LLM-based.** It checks for known excerpts afterwards and
  warns if one survived; review mixed concepts it touched.
- **Mixed-signal dreams depend on the model marking an overview `derived=true`.** A dream
  with only the `insights` signal always marks it.
- **Verification is structural.** It checks citations, deletions, links and forgotten
  sources; it cannot judge whether a summary is accurate.
- **All profiles share one LLM configuration.** Their text goes to the same model.
- **Dreams run one memory at a time**, in turn, never in parallel.
- **On Windows hosts** git is slow; allow extra time. (Your host is Linux.)

---

## Appendix: quick reference

| Task | Command |
|---|---|
| Fresh copy of the synthetic bundle | `cp -a $WORK/synthetic-template $WORK/sN` |
| Start / stop a test server | `start_server <name> <port> <bundle> [VAR=val ...]` / `stop_server <name>` |
| Call a tool | `PORT_T=<port> KEY=<key> mc <tool> '<json>'` (`KEY` empty for no auth) |
| Call the HTTP API | `PORT_T=<port> api /api/dream/status` |
| Run a dream now | `node scripts/dream-now.mjs <bundle> [--dry-run] [--mode review\|apply]` |
| Health summary | `node scripts/soak-report.mjs <base-url> [key\|-]` |
| Did concepts change? | `fp <bundle>` before and after |
| Recent dream commits | `git -C <bundle> log --oneline --grep '^dream:'` |
| Pending reviews | `git -C <bundle> branch --list 'dream/*'` |
| Server log of a test | `tail -50 $WORK/logs/<name>.log` |

**If `mc` says "could not call ... ECONNREFUSED":** the server is not up. Check
`tail $WORK/logs/<name>.log`. **If a model call times out:** your model is slow;
set `LLM_TIMEOUT=30m` when starting the server. **If `curl /health` prints nothing:** wait
five more seconds and retry; startup runs git checks first.
