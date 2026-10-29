import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fingerprint, isApkInput, parseVersion, planRelease, releaseMetadata, verifyApk } from '../android-release.mjs';

const commit = 'a'.repeat(40);
const inputFingerprint = 'b'.repeat(64);
const args = { commit, inputFingerprint, sourceVersion: { code: 12, name: '2.2.0' }, releases: [], baseline: { tag: 'android-v2.1.0', versionCode: 11, fingerprint: 'c'.repeat(64) } };

test('only native APK inputs count, including build dependencies and wrapper', () => {
  for (const file of ['app/src/main/AndroidManifest.xml', 'app/src/main/java/Main.java', 'app/src/main/res/raw/tone.mp3', 'app/build.gradle', 'gradle/wrapper/gradle-wrapper.properties', 'settings.gradle']) {
    assert.equal(isApkInput(`apps/android/${file}`), true, file);
  }
  for (const file of ['docs/android-app.md', 'apps/client/src/native/androidBridge.ts', 'apps/server/src/main.ts', 'apps/android/README.md', 'apps/android/app/src/test/java/Test.java', 'apps/android/app/src/androidTest/java/Test.java', 'apps/android/local.properties', 'apps/android/app/build/outputs/foo.apk']) {
    assert.equal(isApkInput(file), false, file);
  }
});

test('fingerprints compare contents: web/test edits and native reverts skip, native deletion changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awb-apk-test-'));
  const previous = process.cwd();
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    mkdirSync(join(dir, 'apps/android/app/src/main'), { recursive: true });
    writeFileSync(join(dir, 'apps/android/app/src/main/app.java'), 'original');
    writeFileSync(join(dir, 'apps/android/build.gradle'), 'build');
    git('add', '.'); git('commit', '-m', 'native');
    process.chdir(dir);
    const initial = fingerprint('HEAD');
    writeFileSync(join(dir, 'web.ts'), 'web change');
    writeFileSync(join(dir, 'apps/android/README.md'), 'docs');
    git('add', '.'); git('commit', '-m', 'web');
    assert.equal(fingerprint('HEAD'), initial);
    writeFileSync(join(dir, 'apps/android/app/src/main/app.java'), 'changed');
    git('add', '.'); git('commit', '-m', 'change');
    assert.notEqual(fingerprint('HEAD'), initial);
    writeFileSync(join(dir, 'apps/android/app/src/main/app.java'), 'original');
    git('add', '.'); git('commit', '-m', 'revert');
    assert.equal(fingerprint('HEAD'), initial);
    git('rm', 'apps/android/app/src/main/app.java'); git('commit', '-m', 'delete');
    assert.notEqual(fingerprint('HEAD'), initial);
  } finally { process.chdir(previous); rmSync(dir, { recursive: true, force: true }); }
});

test('legacy and property-overridden Gradle versions bootstrap without a source bump', () => {
  assert.deepEqual(parseVersion("// previous versionCode 1–3\nversionCode 11\nversionName '2.1.0'"), { code: 11, name: '2.1.0' });
  assert.deepEqual(parseVersion("versionCode providers.gradleProperty('awbVersionCode').getOrElse('12').toInteger()\nversionName providers.gradleProperty('awbVersionName').getOrElse('2.2.0')"), { code: 12, name: '2.2.0' });
  assert.throws(() => parseVersion('no version'));
});

test('initial native change publishes code 12; unchanged input does not build', () => {
  assert.equal(planRelease(args).versionCode, 12);
  assert.equal(planRelease({ ...args, baseline: { ...args.baseline, fingerprint: inputFingerprint } }).build, false);
});

test('version increases past published and abandoned draft versions', () => {
  const releases = [{ tag_name: 'android-build-15', draft: true }];
  assert.equal(planRelease({ ...args, releases }).versionCode, 16);
});

test('retry reuses only a draft for this exact source; successful publish becomes a no-op', () => {
  const plan = planRelease(args);
  const draft = { tag_name: plan.tag, draft: true, meta: plan };
  assert.deepEqual(planRelease({ ...args, releases: [draft] }), plan);
  assert.equal(planRelease({ ...args, commit: 'd'.repeat(40), releases: [draft] }).versionCode, 13);
  assert.equal(planRelease({ ...args, baseline: plan }).build, false);
});

test('release metadata must match its tag and valid identity', () => {
  const plan = planRelease(args);
  const release = { tag_name: plan.tag, body: `notes\n<!-- awb-android-release:${JSON.stringify(plan)} -->` };
  assert.deepEqual(releaseMetadata(release), plan);
  assert.throws(() => releaseMetadata({ ...release, tag_name: 'android-build-99' }));
  assert.equal(releaseMetadata({ body: 'legacy release' }), null);
});

test('wrong package, version, unsigned APK and changed signing key cannot publish', () => {
  const plan = planRelease(args);
  const cert = 'a'.repeat(64);
  const badging = `package: name='com.parnmanas.awb' versionCode='12' versionName='2.2.0+12'`;
  const signatures = `Signer #1 certificate SHA-256 digest: ${cert}`;
  verifyApk(badging, signatures, plan, cert);
  assert.throws(() => verifyApk(badging.replace('12', '11'), signatures, plan, cert));
  assert.throws(() => verifyApk(badging.replace('com.parnmanas.awb', 'another.app'), signatures, plan, cert));
  assert.throws(() => verifyApk(badging, '', plan, cert));
  assert.throws(() => verifyApk(badging, signatures, plan, 'b'.repeat(64)));
});
