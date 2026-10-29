#!/usr/bin/env node
// Scheduled APK releases. No npm dependencies; only git, gh and Android build-tools.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APK = 'awb-android.apk';
const MANIFEST = 'awb-android-release.json';
const MARKER = /<!-- awb-android-release:(\{[^\n]+\}) -->/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const git = (...args) => run('git', args);
const gh = (...args) => run('gh', args);

export function isApkInput(path) {
  return path.startsWith('apps/android/')
    && !/\/(?:src\/(?:test|androidTest)|build|\.gradle|\.idea)\//.test(path)
    && !/(?:\.md|\.iml|\.apk|\.aab)$/.test(path)
    && !/(?:^|\/)(?:\.gitignore|local\.properties)$/.test(path);
}

export function fingerprint(ref) {
  // Compare tracked input contents, not commit timestamps: web changes and reverted changes are no-ops.
  const entries = git('ls-tree', '-r', '-z', ref, '--', 'apps/android').split('\0')
    .filter((entry) => entry && isApkInput(entry.slice(entry.indexOf('\t') + 1)));
  if (!entries.length) throw new Error(`No Android build inputs at ${ref}`);
  return sha256(entries.sort().join('\0'));
}

export function parseVersion(gradle) {
  const code = gradle.match(/^\s*versionCode\s+(\d+)/m)?.[1]
    ?? gradle.match(/^\s*versionCode[^\n]*getOrElse\('(\d+)'\)/m)?.[1];
  const name = gradle.match(/^\s*versionName\s+'([^']+)'/m)?.[1]
    ?? gradle.match(/^\s*versionName[^\n]*getOrElse\('([^']+)'\)/m)?.[1];
  if (!code || !name || !/^\d+\.\d+(?:\.\d+)?$/.test(name)) throw new Error('Cannot read Android source version');
  return { code: Number(code), name };
}

export function releaseMetadata(release) {
  const match = release.body?.match(MARKER);
  if (!match) return null;
  const meta = JSON.parse(match[1]);
  if (meta.schema !== 1 || !/^[a-f0-9]{64}$/.test(meta.fingerprint)
    || !/^[a-f0-9]{40}$/.test(meta.commit) || !Number.isSafeInteger(meta.versionCode)
    || meta.versionCode < 1 || meta.versionCode > 2100000000
    || !/^\d+\.\d+(?:\.\d+)?\+\d+$/.test(meta.versionName)
    || release.tag_name !== `android-build-${meta.versionCode}`) {
    throw new Error(`Invalid APK release metadata: ${release.tag_name}`);
  }
  return meta;
}

export function planRelease({ commit, inputFingerprint, sourceVersion, releases, baseline }) {
  if (baseline?.fingerprint === inputFingerprint) return { build: false, reason: 'Android build inputs are unchanged', baseline: baseline.tag };
  // A failed upload stays a draft. Reuse its version only for the same source revision.
  const pending = releases.find((r) => r.draft && r.meta?.fingerprint === inputFingerprint && r.meta?.commit === commit);
  const reserved = releases.map((r) => r.meta?.versionCode ?? Number(r.tag_name?.match(/^android-build-(\d+)$/)?.[1] || 0));
  const versionCode = pending?.meta.versionCode ?? Math.max(sourceVersion.code - 1, baseline?.versionCode || 0, ...reserved) + 1;
  if (versionCode > 2100000000) throw new Error('Android versionCode limit exceeded');
  return {
    build: true, schema: 1, commit, fingerprint: inputFingerprint, versionCode,
    versionName: pending?.meta.versionName ?? `${sourceVersion.name}+${versionCode}`,
    tag: `android-build-${versionCode}`, baseline: baseline?.tag ?? null,
  };
}

function releasesFor(repo) {
  return JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`)).flat()
    .map((release) => ({ ...release, meta: releaseMetadata(release) }));
}

function currentPlan(repo) {
  const commit = git('rev-parse', 'HEAD');
  const releases = releasesFor(repo);
  const latest = releases.filter((r) => !r.draft && !r.prerelease
    && r.assets.some((a) => a.name === APK && a.state === 'uploaded' && a.size > 0))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  let baseline = null;
  if (latest) {
    // Bootstrap from existing manually published APK tags. Never infer "no release" from an API failure.
    const ref = `refs/tags/${latest.tag_name}`;
    baseline = latest.meta ? { ...latest.meta, tag: latest.tag_name } : {
      tag: latest.tag_name, fingerprint: fingerprint(ref),
      versionCode: parseVersion(git('show', `${ref}:apps/android/app/build.gradle`)).code,
    };
  }
  return planRelease({ commit, releases, baseline, inputFingerprint: fingerprint('HEAD'),
    sourceVersion: parseVersion(git('show', 'HEAD:apps/android/app/build.gradle')) });
}

export function verifyApk(badging, signatures, plan, expectedCertificate) {
  const pkg = badging.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/);
  if (!pkg || pkg[1] !== 'com.parnmanas.awb' || Number(pkg[2]) !== plan.versionCode || pkg[3] !== plan.versionName) {
    throw new Error('APK package/version does not match release plan');
  }
  const normalize = (s) => String(s || '').replace(/:/g, '').trim().toLowerCase();
  const expected = normalize(expectedCertificate);
  const actual = [...signatures.matchAll(/Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9:]+)/g)].map((m) => normalize(m[1]));
  if (!/^[a-f0-9]{64}$/.test(expected) || actual.length !== 1 || actual[0] !== expected) {
    throw new Error('APK signing certificate differs from the installed-app release key');
  }
}

function publish(repo, plan, directory) {
  if (!plan.build) throw new Error('No APK release planned');
  // Guard manual invocation and a stale plan, even though Actions also serializes runs.
  const fresh = currentPlan(repo);
  if (!fresh.build) { console.log(fresh.reason); return; }
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) throw new Error('Release state changed; run plan and build again');
  if (git('status', '--porcelain', '--untracked-files=no', '--', 'apps/android')) throw new Error('Android sources changed after checkout');
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('ANDROID_HOME is required');
  const buildTools = join(sdk, 'build-tools', '36.0.0');
  const apk = resolve('apps/android/app/build/outputs/apk/release/app-release.apk');
  verifyApk(run(join(buildTools, 'aapt'), ['dump', 'badging', apk]),
    run(join(buildTools, 'apksigner'), ['verify', '--print-certs', apk]), plan, process.env.AWB_ANDROID_CERT_SHA256);
  mkdirSync(directory, { recursive: true });
  const apkFile = join(directory, APK);
  copyFileSync(apk, apkFile);
  const manifest = { ...plan, apkSha256: sha256(readFileSync(apkFile)),
    certificateSha256: process.env.AWB_ANDROID_CERT_SHA256.replace(/:/g, '').toLowerCase() };
  const manifestFile = join(directory, MANIFEST);
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  const notesFile = join(directory, 'notes.md');
  writeFileSync(notesFile, `Android native app update: **${plan.versionName}** (versionCode ${plan.versionCode}).\n\n`
    + `Built from ${plan.commit}. Install awb-android.apk over the existing app.\n\n`
    + `APK SHA-256: \`${manifest.apkSha256}\`\n\n<!-- awb-android-release:${JSON.stringify(manifest)} -->\n`);
  const existing = releasesFor(repo).find((r) => r.tag_name === plan.tag);
  if (existing && (!existing.draft || existing.meta?.fingerprint !== plan.fingerprint || existing.meta?.commit !== plan.commit)) {
    throw new Error('Refusing to replace a published or unrelated release');
  }
  if (!existing) {
    gh('release', 'create', plan.tag, '--repo', repo, '--target', plan.commit, '--draft',
      '--title', `AWB Android ${plan.versionName}`, '--notes-file', notesFile);
  }
  // Draft-only replacement makes upload interruption retryable without exposing half a release.
  gh('release', 'upload', plan.tag, apkFile, manifestFile, '--repo', repo, '--clobber');
  const uploaded = releasesFor(repo).find((r) => r.tag_name === plan.tag);
  for (const [name, file] of [[APK, apkFile], [MANIFEST, manifestFile]]) {
    const asset = uploaded?.assets.find((a) => a.name === name);
    const content = readFileSync(file);
    if (!asset || asset.state !== 'uploaded' || asset.size !== content.length || asset.digest !== `sha256:${sha256(content)}`) {
      throw new Error(`Uploaded asset verification failed: ${name}; release remains a draft`);
    }
  }
  gh('release', 'edit', plan.tag, '--repo', repo, '--notes-file', notesFile, '--draft=false', '--latest');
  console.log(`Published ${plan.tag}: https://github.com/${repo}/releases/latest/download/${APK}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directoryArg = '.android-release'] = process.argv.slice(2);
  const directory = resolve(directoryArg);
  const repo = process.env.GITHUB_REPOSITORY || 'parnmanas/ai-workflow-board';
  if (command === 'plan') {
    const plan = currentPlan(repo);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `build=${plan.build}\nversion_code=${plan.versionCode || ''}\nversion_name=${plan.versionName || ''}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      plan.build ? `APK build planned: ${plan.versionName} (${plan.commit})\n` : `APK skipped: ${plan.reason}\n`);
    console.log(JSON.stringify(plan, null, 2));
  } else if (command === 'publish') {
    publish(repo, JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')), directory);
  } else {
    throw new Error('Usage: node scripts/android-release.mjs plan|publish <output-directory>');
  }
}
