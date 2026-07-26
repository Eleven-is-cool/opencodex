import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const doctorGuiIfChangedScript = fileURLToPath(new URL("../scripts/doctor-gui-if-changed.ts", import.meta.url));

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

function count(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

function workflowStep(workflow: string, name: RegExp): string {
  const steps = workflow.split(/\n {6,}- name: /).slice(1);
  const step = steps.find(candidate => name.test(candidate.split("\n", 1)[0]!));
  expect(step).toBeDefined();
  return step!;
}

describe("GitHub Actions hardening", () => {
  test("cross-platform CI keeps bounded jobs and immutable action references", async () => {
    const workflow = await readText(".github/workflows/ci.yml");

    expect(count(workflow, "timeout-minutes: 12")).toBe(1);
    expect(count(workflow, "timeout-minutes: 8")).toBe(1);
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(workflow).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
    expect(workflow).toContain("bun test --isolate tests");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("cross-platform CI keeps the GUI lint and build gates", async () => {
    // Review finding (PR #97): the GUI build gate was silently dropped once; assert the
    // enhanced gate (PR #99) stays wired so broken GUI builds cannot merge unnoticed.
    const workflow = await readText(".github/workflows/ci.yml");

    expect(workflow).toContain("- name: GUI lint");
    expect(workflow).toContain("bun run lint");
    expect(workflow).toContain("- name: GUI build");
    expect(workflow).toContain("bun run build");
  });

  test("service lifecycle is least-privilege, bounded, and cannot swallow health failures", async () => {
    const workflow = await readText(".github/workflows/service-lifecycle.yml");

    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("group: service-lifecycle-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(count(workflow, "timeout-minutes: 10")).toBe(3);
    expect(count(workflow, "if: ${{ !cancelled() }}")).toBe(3);
    expect(workflow).not.toContain("always()");
    expect(workflow).not.toContain('healthz || echo "healthz not ready yet"');
    expect(workflow).not.toContain("sleep 8");
    expect(workflow).toContain("systemd service has no positive MainPID before crash test");
    expect(workflow).toContain("Get-ScheduledTask -TaskName opencodex-proxy -ErrorAction SilentlyContinue");
    expect(workflow).toContain("launchd artifact or proxy survived uninstall");
    expect(workflow).toContain("scheduled task or proxy survived uninstall");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("release workflow gates the exact SHA, channel, and service surface without injection", async () => {
    const workflow = await readText(".github/workflows/release.yml");

    // Least privilege + never cancel a publish mid-flight.
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 15");

    // Dry-run first by default; tokenless trusted publishing only.
    expect(workflow).toMatch(/dry-run:[\s\S]*?default: true/);
    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN:");

    // Immutable action references.
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(workflow).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);

    // Workflow-dispatch inputs must reach shell code via env, never by direct
    // interpolation into run: source (script-injection hardening).
    const runBlocks = workflow.split(/\n {6,}- name: /).filter(block => block.includes("run: |"));
    for (const block of runBlocks) {
      const runSource = block.slice(block.indexOf("run: |"));
      expect(runSource).not.toContain("${{ inputs.");
    }

    // The service gate must cover the post-restructure service surface and stay
    // in sync with every service-lifecycle.yml push trigger path.
    const gateMatch = workflow.match(/grep -Eq '(\^\([^']+\)\$)'/);
    expect(gateMatch).not.toBeNull();
    const gate = new RegExp(gateMatch![1]!);
    const lifecycle = await readText(".github/workflows/service-lifecycle.yml");
    const pushPaths = lifecycle
      .split("push:")[1]!
      .split("workflow_dispatch:")[0]!
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith('- "'))
      .map(line => line.slice(3, -1));
    expect(pushPaths.length).toBeGreaterThanOrEqual(6);
    for (const path of pushPaths) {
      expect(gate.test(path)).toBe(true);
    }
    expect(gate.test("src/cli/index.ts")).toBe(true);
    expect(gate.test("src/lib/bun-runtime.ts")).toBe(true);
    expect(gate.test("src/cli.ts")).toBe(true);

    // PR and push triggers must stay path-set identical, and both must cover the
    // pre-restructure compat stub src/cli.ts that the release gate regex checks
    // (devlog 260716_passthrough_followups/020 — a release whose only service change
    // is src/cli.ts must auto-trigger service-lifecycle instead of dead-ending the gate).
    const prPaths = lifecycle
      .split("pull_request:")[1]!
      .split("push:")[0]!
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith('- "'))
      .map(line => line.slice(3, -1));
    expect([...prPaths].sort()).toEqual([...pushPaths].sort());
    expect(prPaths).toContain("src/cli.ts");
    expect(pushPaths).toContain("src/cli.ts");
    expect(gate.test("src/router.ts")).toBe(false);
    expect(gate.test("docs-site/src/pages/index.astro")).toBe(false);

    // Channel guards stay branch-exact.
    expect(workflow).toContain("Release must run from main or preview");
    expect(workflow).toContain("main releases must use a stable semver version");
    expect(workflow).toContain("preview releases must use a preview prerelease version");

    const ciGate = workflowStep(workflow, /^Require successful Cross-platform and Go CI for this commit$/);
    expect(ciGate).toContain('"ci.yml|Cross-platform CI"');
    expect(ciGate).toContain('"go-ci.yml|Go CI"');
    expect(ciGate).toContain('--commit "$GITHUB_SHA"');
    expect(ciGate).toContain('.headSha == $sha');
    expect(ciGate).toContain('.conclusion == "success"');

    // Release notes include PR categories and the full channel commit range.
    expect(workflow).toContain("releases/generate-notes");
    expect(workflow).toContain("git log --pretty=format:'- %s (%h)'");
    expect(workflow).toContain('commit_range="${notes_range_start}..${GITHUB_SHA}"');
    expect(workflow).toContain('previous_tag_name=${notes_range_start}');
    expect(workflow).toContain("skipping generate-notes (commits-only notes)");
    expect(workflow).toContain("bun scripts/release-notes.ts strip-carried");
    expect(workflow).toContain("bun scripts/release-notes.ts assemble");
    expect(workflow).toContain("bun scripts/release-notes.ts matching-preview-tags");
    expect(workflow).toContain("bun scripts/release-notes.ts has-meaningful");
    expect(workflow).toContain("bun scripts/release-notes.ts join-carried");
    expect(workflow).toContain("releases/tags/");
    expect(workflow).toContain('gh api "repos/${GITHUB_REPOSITORY}" --jq \'.full_name\'');
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("operational error, not a missing release");
    expect(workflow).toContain("not an ancestor");
    expect(workflow).toContain("newest_carried_preview_tag");
    expect(workflow).not.toMatch(/newest_preview_tag="\$preview_carry_tag"/);
    expect(workflow).toContain("--commits");
    expect(workflow).toContain('git tag --list "v${RELEASE_VERSION}-preview.*"');
    expect(workflow).toContain("Carrying preview release notes from");
    // Every subcommand the workflow invokes must be dispatched by the CLI.
    const releaseNotesHelper = await readText("scripts/release-notes.ts");
    const invoked = [...workflow.matchAll(/bun scripts\/release-notes\.ts ([a-z-]+)/g)]
      .map(m => m[1]!);
    expect(invoked.length).toBeGreaterThan(0);
    for (const cmd of new Set(invoked)) {
      expect(releaseNotesHelper).toContain(`"${cmd}"`);
    }
    expect(workflow).toContain("bun scripts/reconcile-release-assets.ts");
    expect(workflow).not.toContain("gh release create");
    expect(workflow).not.toContain("gh release edit");
    expect(workflow).not.toContain("--generate-notes");
    // Notes must be assembled before tagging so a notes API failure does not leave
    // a remote tag that blocks release retries at preflight.
    const createStep = workflow.split("- name: Create/reconcile GitHub release")[1]!.split(/\n {6}- name:/)[0]!;
    const notesAssembly = createStep.split('upload_root=')[0]!;
    // Preview carry lookup must use tag-specific API status, not `gh release view` stderr prose.
    expect(notesAssembly).toContain("releases/tags/");
    expect(notesAssembly).not.toContain("gh release view");
    // Fail closed: no soft-skip in any spelling around gh api calls in this step.
    for (const line of createStep.split("\n").filter(l => l.includes("gh api"))) {
      expect(line).not.toMatch(/\|\|\s*(true|echo|:)/);
    }
    expect(createStep).not.toContain("set +e\n            pr_notes");
    expect(createStep.indexOf("gh api")).toBeGreaterThan(-1);
    expect(createStep.indexOf("bun scripts/reconcile-release-assets.ts")).toBeGreaterThan(createStep.indexOf("gh api"));
    // First-channel releases must not call generate-notes without an explicit baseline
    // (GitHub would otherwise pick the newest repo tag, possibly from the other channel).
    // Scope to the single if-block that owns generate-notes; createStep has two
    // `[ -n "$notes_range_start" ]` blocks, so an unanchored [\s\S]* can straddle them.
    const notesBlock = createStep
      .split(/if \[ -n "\$notes_range_start" \]; then/)[1]!
      .split(/\n {10}if \[/)[0]!;
    expect(notesBlock).toContain("previous_tag_name=${notes_range_start}");
    expect(notesBlock).toContain("skipping generate-notes");
    expect(notesBlock).toMatch(/\n {10}else\n/);
  });

  test("release workflow retains one exact archive and isolates every mutation from dry-run", async () => {
    const workflow = await readText(".github/workflows/release.yml");

    expect(workflow).toMatch(/expected-sha:[\s\S]*?required: true/);
    expect(workflow).toContain('echo "::error::expected-sha is required"');
    expect(workflow).toContain('if [ -z "$EXPECTED_SHA" ]; then');
    expect(workflow).toMatch(
      /permissions:\n  contents: write[^\n]*\n  actions: read[^\n]*\n  id-token: write[^\n]*/,
    );
    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN:");

    const setupGo = workflowStep(workflow, /^Setup Go$/);
    expect(setupGo).toContain("actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e");
    expect(setupGo).toContain("cache-dependency-path: go/go.sum");

    expect(count(workflow, "npm pack --json")).toBe(1);
    const build = workflowStep(workflow, /^Build and retain exact release archive$/);
    const publish = workflowStep(workflow, /^Publish exact tarball$/);
    const smoke = workflowStep(workflow, /^Post-publish registry smoke$/);
    const release = workflowStep(workflow, /^Create\/reconcile GitHub release$/);

    expect(build).toContain("npm run build:publish");
    expect(build).toContain("npm pack --json > pack.json");
    expect(build).not.toContain("npm pack --json --ignore-scripts");
    expect(build).toContain("npm run verify:native-package");
    expect(build).toContain("npm run verify:native-install");
    expect(build).toContain("bun scripts/prepare-release-assets.ts");
    expect(build).toContain("prepare");
    expect(build).toContain("TARBALL_SHA256");
    expect(build).toContain("RELEASE_NATIVE_DIR");
    for (const mutator of ["npm publish", "git tag", "git push", "gh release create", "gh release upload"]) {
      expect(build).not.toContain(mutator);
    }

    for (const guarded of [publish, smoke, release]) {
      expect(guarded).toContain("if: ${{ inputs.dry-run != true }}");
    }
    for (const step of workflow.split(/\n {6,}- name: /).slice(1)) {
      if (/npm publish|git tag "\$release_tag"|git push origin|gh release (?:create|upload)/.test(step)) {
        expect(step).toContain("if: ${{ inputs.dry-run != true }}");
      }
    }
    expect(publish).toMatch(
      /prepare-release-assets\.ts verify[\s\S]*?npm publish "\$TARBALL" --ignore-scripts/,
    );

    const buildAt = workflow.indexOf("Build and retain exact release archive");
    const helperAt = workflow.indexOf("bun scripts/prepare-release-assets.ts", buildAt);
    const publishAt = workflow.indexOf("Publish exact tarball");
    const releaseAt = workflow.search(/Create(?:\/reconcile)? GitHub release/);
    expect(buildAt).toBeGreaterThan(-1);
    expect(helperAt).toBeGreaterThan(buildAt);
    expect(publishAt).toBeGreaterThan(helperAt);
    expect(releaseAt).toBeGreaterThan(publishAt);
  });

  test("release workflow classifies exact retries only after immutable identities exist", async () => {
    const workflow = await readText(".github/workflows/release.yml");
    const classify = workflowStep(workflow, /^Classify exact release retry state$/);
    const smoke = workflowStep(workflow, /^Post-publish registry smoke$/);
    const release = workflowStep(workflow, /^Create\/reconcile GitHub release$/);

    expect(classify).toContain("pack.json");
    expect(classify).toContain("dist.integrity");
    expect(classify).toContain("dist-tag");
    expect(classify).toContain("NPM_RELEASE_STATE");
    expect(classify).toContain("NPM_EXPECTED_INTEGRITY");
    expect(classify).toContain("GITHUB_RELEASE_CANDIDATE");
    expect(classify).not.toContain("GITHUB_RELEASE_STATE=exact");
    expect(classify).toContain("GITHUB_SHA");

    const notesAt = release.indexOf('notes_file=');
    const reconcileAt = release.indexOf("bun scripts/reconcile-release-assets.ts");
    expect(notesAt).toBeGreaterThan(-1);
    expect(reconcileAt).toBeGreaterThan(notesAt);
    expect(release).not.toContain("gh release create");
    expect(release).not.toContain("gh release upload");
    expect(release).not.toContain("git push origin");
    expect(release).toContain('--archive-sha256 "$TARBALL_SHA256"');
    expect(release).toContain('--native-dir "$upload_native_dir"');
    expect(release).toContain('--npm-tag "$NPM_DIST_TAG"');
    expect(release).toContain('--npm-integrity "$NPM_EXPECTED_INTEGRITY"');

    expect(smoke).toContain("NPM_DIST_TAG: ${{ inputs.tag }}");
    expect(smoke).toContain('dist.integrity');
    expect(smoke).toContain('"dist-tags.${NPM_DIST_TAG}"');
    expect(smoke).toContain('"$remote_integrity" != "$NPM_EXPECTED_INTEGRITY"');
    expect(smoke).toContain('"$tagged_version" = "$RELEASE_VERSION"');
  });

  test("GitHub release assets are exactly the six binaries and checksum manifest", async () => {
    const workflow = await readText(".github/workflows/release.yml");
    const release = workflowStep(workflow, /^Create\/reconcile GitHub release$/);
    const reconciler = await readText("scripts/reconcile-release-assets.ts");
    expect(reconciler).toContain("const names = [...nativeArtifactNames(version), `ocx_${version}_checksums.txt`]");
    expect(reconciler).toContain("return Promise.all(names.map(async name =>");
    expect(release).toContain("reconcile-release-assets.ts");
    expect(reconciler).toContain('"--verify-tag"');
    expect(reconciler).toContain('"--draft=false"');
    expect(reconciler).not.toContain('"--clobber"');
    expect(reconciler).toContain('"--method", "DELETE"');
    expect(reconciler).toContain("downloadAsset");
  });

  test("dev2-go changes activate both package and Go release ownership gates", async () => {
    const ci = await readText(".github/workflows/ci.yml");
    const goCi = await readText(".github/workflows/go-ci.yml");

    expect(ci).toMatch(/push:[\s\S]*?branches: \[main, preview, dev, dev2-go\]/);
    expect(ci).toContain("npm run verify:native-install");
    expect(goCi).toMatch(/push:[\s\S]*?branches: \[dev2-go, main, preview\]/);
    expect(count(goCi, "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")).toBe(3);
    expect(count(goCi, "bun-version: 1.3.14")).toBe(3);
    for (const [job, nextJob] of [
      ["build-and-test", "cross-compile"],
      ["cross-compile", "e2e"],
      ["e2e", undefined],
    ] as const) {
      const tail = goCi.split(`\n  ${job}:\n`)[1]!;
      const block = nextJob ? tail.split(`\n  ${nextJob}:\n`)[0]! : tail;
      expect(block).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
      expect(block).toContain("bun-version: 1.3.14");
    }

    for (const path of [
      '"bin/**"',
      '"src/update/job.ts"',
      '"scripts/build-go-release.go"',
      '"scripts/prepare-package.ts"',
      '"scripts/prepare-release-assets.ts"',
      '"scripts/reconcile-release-assets.ts"',
      '"scripts/ocx-native-launcher.test.mjs"',
      '"scripts/verify-native-install.mjs"',
      '"package.json"',
      '"bun.lock"',
      '".github/workflows/ci.yml"',
      '".github/workflows/release.yml"',
    ]) {
      expect(goCi).toContain(path);
    }
    expect(goCi).toContain("Verify six native release names without publishing");
    expect(goCi).toContain('version="0.0.0-preview.0"');
    expect(goCi).toContain("--dry-run");
    expect(goCi).toContain("grep -c -- ' -> '");
    for (const suffix of [
      "darwin_amd64",
      "darwin_arm64",
      "linux_amd64",
      "linux_arm64",
      "windows_amd64.exe",
      "windows_arm64.exe",
    ]) {
      expect(goCi).toContain(suffix);
    }
  });

  test("all governing workflow actions remain immutable SHA pins", async () => {
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/workflows/go-ci.yml",
      ".github/workflows/release.yml",
    ]) {
      const workflow = await readText(path);
      const refs = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s+([^\s#]+)/gm)].map(match => match[1]!);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  test("docs deployment is pinned, bounded, and scoped to Pages", async () => {
    const workflow = await readText(".github/workflows/deploy-docs.yml");

    expect(workflow).toContain("permissions:\n  contents: read\n  pages: write\n  id-token: write");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 15");
    expect(workflow).toContain("timeout-minutes: 10");
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(workflow).toContain("withastro/action@e84f40bd8d2caa9e768ec82ad30dd81f0b280853");
    expect(workflow).toContain("actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("issue-quality workflow rejects workflow_dispatch pull request numbers before mutation", async () => {
    const workflow = await readText(".github/workflows/enforce-issue-quality.yml");

    expect(workflow).toContain("issue_comment:");
    expect(workflow).toContain("Translate non-English issue comments");
    expect(workflow).toContain("shouldTranslateComment");
    expect(workflow).toContain("buildTranslatedCommentBody");
    expect(workflow).toContain("github.rest.issues.updateComment");
    expect(workflow).toContain("group: issue-translation-${{ github.event.issue.number }}");
    expect(workflow).not.toContain("issue-comment-translation-${{ github.event.comment.id }}");
    expect(workflow).toContain("if: github.event_name == 'issue_comment'");
    expect(workflow).toMatch(
      /translate:\s*\n\s*name: Translate non-English issues\s*\n\s*if: github\.event_name == 'issues' \|\| github\.event_name == 'workflow_dispatch'/,
    );
    expect(workflow).toMatch(
      /validate:\s*\n\s*if: github\.event_name == 'issues' \|\| github\.event_name == 'workflow_dispatch'/,
    );

    const commentJob = workflow.split(/\n {2}translate-comment:\n/)[1]!.split(/\n {2}[a-zA-Z]/)[0]!;
    expect(commentJob).toContain("parse-issue-translation-response.cjs");
    expect(commentJob).toContain("Apply inline comment translation");
    expect(commentJob).toContain("isPreparedSourceStillCurrent");
    expect(commentJob).toContain("updateComment");
    expect(commentJob).toContain("requires_translation == 'true'");
    expect(commentJob).toContain("group: issue-translation-${{ github.event.issue.number }}");
    expect(commentJob).toContain("# Required to rewrite the triggering issue comment in place.");
    expect(commentJob).toContain("sourceKey:");
    // Same fail-closed parse → apply gate as the issue path.
    const commentParse = commentJob
      .split("- name: Parse AI response")[1]!
      .split("- name: Apply inline comment translation")[0]!;
    expect(commentParse).toContain("parse-issue-translation-response.cjs");
    const commentRun = commentParse.split(/\n\s*run:\s*/)[1];
    expect(commentRun).toBeDefined();
    expect(commentRun!).not.toContain("${{");
    const commentApply = commentJob
      .split("- name: Apply inline comment translation")[1]!
      .split("- name: Persist comment translation control state")[0]!;
    const guardAt = commentApply.indexOf("isPreparedSourceStillCurrent({");
    const updateAt = commentApply.indexOf("updateComment");
    const missingAt = commentApply.indexOf("missingRequiredTranslationFields({");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(missingAt).toBeGreaterThanOrEqual(0);
    expect(missingAt).toBeLessThan(updateAt);
    expect(guardAt).toBeLessThan(updateAt);
    expect(commentApply).toContain("omitted required field(s)");

    // Job-scoped permissions only (no top-level issues:write; no actions:write).
    expect(workflow).toMatch(
      /jobs:\s*\n\s*translate:[\s\S]*?permissions:\s*\n(?:\s*#.*\n)*\s*contents: read\s*\n(?:\s*#.*\n)*\s*issues: write\s*\n(?:\s*#.*\n)*\s*models: read/,
    );
    const translateJob = workflow.split(/\n {2}translate:\n/)[1]!.split(/\n {2}[a-zA-Z]/)[0]!;
    expect(translateJob).not.toMatch(/actions:\s*write/);
    expect(workflow).toMatch(
      /jobs:\s*\n\s*translate:[\s\S]*?validate:[\s\S]*?permissions:\s*\n\s*contents: read\s*\n\s*#.*\n\s*issues: write/,
    );
    const beforeJobs = workflow.split(/jobs:\s*\n/)[0]!;
    expect(beforeJobs).not.toMatch(/^\s*permissions:/m);

    // Non-cancelling per-issue concurrency at workflow and translate-job scope.
    expect(workflow).toContain("group: issue-quality-${{ github.event.issue.number || inputs.issue_number }}");
    expect(workflow).toContain("group: issue-translation-${{ github.event.issue.number || inputs.issue_number }}");
    const workflowConcurrency = workflow.split(/jobs:\s*\n/)[0]!;
    expect(workflowConcurrency).toMatch(
      /concurrency:\s*\n\s*group: issue-quality-[^\n]*\n\s*cancel-in-progress:\s*false/,
    );
    expect(translateJob).toMatch(
      /concurrency:\s*\n\s*group: issue-translation-[^\n]*\n\s*cancel-in-progress:\s*false/,
    );
    expect(translateJob).toContain("translation-state-degraded");
    expect(translateJob).toContain("core.summary");

    // Trusted scripts always come from the repository default branch.
    const checkoutStep = workflow
      .split("- name: Checkout trusted workflow code")[1]!
      .split(/\n {6}- name:/)[0]!;
    expect(checkoutStep).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(checkoutStep).toContain("persist-credentials: false");
    expect(checkoutStep).toContain("sparse-checkout: .github/scripts");

    const script = workflow
      .split("- name: Validate issue quality")[1]!
      .split("script: |")[1]!
      .split(/\n {6}- name:/)[0]!;

    // Invalid issue numbers fail before any issues API call.
    const invalidNumberIdx = script.indexOf("Invalid workflow_dispatch issue_number:");
    const firstIssuesGetIdx = script.indexOf("github.rest.issues.get({");
    expect(invalidNumberIdx).toBeGreaterThan(-1);
    expect(firstIssuesGetIdx).toBeGreaterThan(-1);
    expect(invalidNumberIdx).toBeLessThan(firstIssuesGetIdx);

    // Non-default-branch dispatches fail before any issues API mutation.
    const branchGuardIdx = script.indexOf("const nonDefaultBranchFailure = rejectsWorkflowDispatchNonDefaultBranch(");
    const firstMutationIdx = script.indexOf("github.rest.issues.update({");
    expect(branchGuardIdx).toBeGreaterThan(-1);
    expect(firstMutationIdx).toBeGreaterThan(-1);
    expect(branchGuardIdx).toBeLessThan(firstMutationIdx);
    expect(branchGuardIdx).toBeLessThan(firstIssuesGetIdx);

    // Pull-request numbers are rejected after issues.get and before mutations.
    const prGuardIdx = script.indexOf("const pullRequestFailure = rejectsWorkflowDispatchPullRequest(");
    const listCommentsIdx = script.indexOf("github.rest.issues.listComments");
    const addLabelsIdx = script.indexOf("github.rest.issues.addLabels");
    expect(prGuardIdx).toBeGreaterThan(-1);
    expect(prGuardIdx).toBeGreaterThan(firstIssuesGetIdx);
    expect(prGuardIdx).toBeLessThan(listCommentsIdx);
    expect(prGuardIdx).toBeLessThan(addLabelsIdx);
    expect(prGuardIdx).toBeLessThan(firstMutationIdx);
    expect(script).toContain("if (pullRequestFailure) {");
    expect(script).toContain("core.setFailed(pullRequestFailure);");

    const translateScript = workflow
      .split("- name: Prepare translation")[1]!
      .split("- name: Detect and translate")[0]!;
    const branchGuardIdxTranslate = translateScript.indexOf(
      "rejectsWorkflowDispatchNonDefaultBranch(",
    );
    const issuesGetIdxTranslate = translateScript.indexOf("github.rest.issues.get({");
    expect(branchGuardIdxTranslate).toBeGreaterThan(-1);
    expect(issuesGetIdxTranslate).toBeGreaterThan(-1);
    expect(branchGuardIdxTranslate).toBeLessThan(issuesGetIdxTranslate);
    expect(translateScript).toContain("resolveControlState");
    expect(translateScript).toContain("Never trust author-editable issue body markers");

    const applyScript = workflow
      .split("- name: Apply inline translation")[1]!
      .split("- name: Persist translation control state")[0]!;
    const staleGuardIdx = applyScript.indexOf("isPreparedSourceStillCurrent({");
    const issueUpdateIdx = applyScript.indexOf("github.rest.issues.update(");
    expect(staleGuardIdx).toBeGreaterThan(-1);
    expect(issueUpdateIdx).toBeGreaterThan(-1);
    expect(staleGuardIdx).toBeLessThan(issueUpdateIdx);
    expect(applyScript).toContain("persistTranslationControlState");
    expect(applyScript).toContain("Translation control state not persisted");
    expect(applyScript).toContain("sourceComplete");
    expect(applyScript).toContain("source remains retryable");
    expect(applyScript).toContain("missingRequiredTranslationFields");
    expect(applyScript).toContain("omitted required field(s)");
    expect(applyScript).toMatch(/sourceComplete,\s*\n\s*\}/);
    expect(applyScript.indexOf("missingRequiredTranslationFields({")).toBeLessThan(
      applyScript.indexOf("github.rest.issues.update("),
    );

    const parseStep = workflow
      .split("- name: Parse AI response")[1]!
      .split("- name: Apply inline translation")[0]!;
    expect(parseStep).toContain("parse-issue-translation-response.cjs");
    expect(parseStep).not.toContain("node -e");
    expect(parseStep).not.toContain("node <<");
    // AI output must stay in env, never interpolated into the shell run script.
    expect(parseStep.split(/\n\s*run:\s*/)[1] || "").not.toContain("${{");

    const persistStep = workflow
      .split("- name: Persist translation control state")[1]!
      .split(/\n {2}[a-zA-Z]/)[0]!;
    expect(persistStep).toContain("always()");
    expect(persistStep).toContain("requires_translation != 'true'");
    expect(persistStep).toContain("persistTranslationControlState");
    expect(persistStep).toContain("SOURCE_COMPLETE");
    expect(persistStep).toContain("detectedLanguageForControlPersist");
    expect(persistStep).toContain('const sourceComplete = process.env.SOURCE_COMPLETE === "true"');
    expect(persistStep).toMatch(/sourceComplete,\s*\n\s*\}/);
    // Missing DETECTED_LANG on incomplete/skipped parse must not default to English.
    expect(persistStep).not.toContain('DETECTED_LANG || "English"');
    expect(persistStep).not.toContain("DETECTED_LANG || 'English'");
    expect(persistStep).not.toContain("silent_state");
    expect(persistStep).not.toContain("cleanup_comment_ids");
    expect(workflow).not.toContain("Save translation control state cache");
    expect(workflow).not.toContain("Remove migrated English control comments");
    expect(workflow).not.toContain("Restore translation control state cache");

    const commentPersist = workflow
      .split("- name: Persist comment translation control state")[1]!
      .split(/\n {2}[a-zA-Z]/)[0]!;
    expect(commentPersist).toContain('const sourceComplete = process.env.SOURCE_COMPLETE === "true"');
    expect(commentPersist).toContain("detectedLanguageForControlPersist");
    expect(commentPersist).toMatch(/sourceComplete,\s*\n\s*\}/);
    expect(commentPersist).not.toContain('DETECTED_LANG || "English"');
    expect(commentPersist).not.toContain("DETECTED_LANG || 'English'");
    const commentApplyStep = workflow
      .split("- name: Apply inline comment translation")[1]!
      .split("- name: Persist comment translation control state")[0]!;
    expect(commentApplyStep).toContain("sourceComplete");
    expect(commentApplyStep).toContain("source remains retryable");
    expect(commentApplyStep).toContain("missingRequiredTranslationFields");
    expect(commentApplyStep).toContain("omitted required field(s)");
    const commentMissingAt = commentApplyStep.indexOf("missingRequiredTranslationFields({");
    const commentUpdateAt = commentApplyStep.indexOf("updateComment");
    expect(commentMissingAt).toBeGreaterThanOrEqual(0);
    expect(commentUpdateAt).toBeGreaterThanOrEqual(0);
    expect(commentMissingAt).toBeLessThan(commentUpdateAt);

    // Helper contract: always-visible bookkeeping; sticky oldest upsert; body non-authoritative.
    const helperSrc = await readText(".github/scripts/issue-translation.cjs");
    expect(helperSrc).toContain("shouldOmitVisibleBookkeeping");
    expect(helperSrc).toContain("findStickyControlComment");
    expect(helperSrc).toContain("detectedLanguageForControlPersist");
    expect(helperSrc).toContain("Automated translation bookkeeping");
    expect(helperSrc).toContain("canonical comment first");
    expect(helperSrc).toContain("Authoritative control state comes only from verified bot-owned comments");
    expect(helperSrc).toContain("sourceComplete");
    expect(helperSrc).not.toContain("writeFileControlState");
    expect(helperSrc).not.toContain(".ocx-translation-state");
  });

  test("React Doctor workflow is SHA-pinned, engine-pinned, advisory, and read-only", async () => {
    const workflow = await readText(".github/workflows/react-doctor.yml");

    expect(workflow).toContain("actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8");
    expect(workflow).toContain("millionco/react-doctor@938008119a288f2fb47c66a69cd9279a21f31784");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);

    // Engine pin: the action wrapper would fetch react-doctor@latest without it.
    expect(workflow).toContain('version: "0.9.1"');

    // Action pin must accept CLI JSON schemaVersion 3 (baseline reports from 0.9.1).
    // v2.1.0's ensure-json-report only knew schemas 1–2 and failed every PR scan.
    // Advisory + least privilege: read-only token, all write-scoped outputs off.
    // pull-requests: read is required so the action can list PR files for
    // --changed-files-from; without it, fork PRs fail with ENOENT on that file.
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).not.toContain(": write");
    expect(workflow).toContain("blocking: none");
    expect(workflow).toContain("comment: false");
    expect(workflow).toContain("review-comments: false");
    expect(workflow).toContain("commit-status: false");
    expect(workflow).toContain("timeout-minutes: 10");
  });

  test("React Doctor package scripts pin the exact engine version with no @latest anywhere", async () => {
    const guiPkg = await readText("gui/package.json");
    const rootPkg = await readText("package.json");

    expect(guiPkg).toContain("react-doctor@0.9.1");
    expect(guiPkg).not.toContain("react-doctor@latest");
    expect(rootPkg).not.toContain("react-doctor@latest");
    expect(rootPkg).toContain('"doctor:gui:if-changed": "bun scripts/doctor-gui-if-changed.ts"');
    expect(rootPkg).toContain('"lint:gui": "cd gui && bun run lint"');
    // Gating steps (typecheck, eslint, tests, privacy) run before advisory React Doctor.
    expect(rootPkg).toContain("bun run typecheck && bun run lint:gui && bun run test");
    expect(rootPkg).toContain("bun run privacy:scan && bun run doctor:gui:if-changed");
  });
});

describe("doctor-gui-if-changed", () => {
  test("guiPathsChanged is a slash-guarded gui/ prefix predicate", async () => {
    const { guiPathsChanged } = await import("../scripts/doctor-gui-if-changed");

    expect(guiPathsChanged(["gui/src/App.tsx"])).toBe(true);
    expect(guiPathsChanged(["gui"])).toBe(true);
    expect(guiPathsChanged(["scripts/foo.ts", "gui/package.json"])).toBe(true);
    expect(guiPathsChanged(["scripts/foo.ts"])).toBe(false);
    expect(guiPathsChanged(["guitools/x.ts"])).toBe(false);
    expect(guiPathsChanged([])).toBe(false);
  });

  test("DRY_RUN prints the run/skip decision without spawning the doctor", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: { ...process.env, DOCTOR_DRY_RUN: "1", DOCTOR_FILES: "gui/src/App.tsx\nscripts/x.ts" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("doctor:run");

    const skip = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: { ...process.env, DOCTOR_DRY_RUN: "1", DOCTOR_FILES: "scripts/x.ts\nREADME.md" },
    });
    expect(skip.exitCode).toBe(0);
    expect(skip.stdout.toString()).toContain("doctor:skip");
  });

  test("degrades gracefully when the doctor engine is unavailable (offline prepush)", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "definitely-not-a-real-command-xyz",
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr.toString()).toContain("skipping advisory scan");
  });
});
