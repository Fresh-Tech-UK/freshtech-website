import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedPaths, checkedPaths, findDrift, publicUrl, selectedPaths, uploadOrder, verifySelection } from './deploy-20i.mjs';

const manifest = files => ({ schemaVersion: 1, mode: 'production', preservedFiles: ['server/api/send-email.php'], files: files.map(path => ({ path })) });

test('uploads assets, then pages, then handlers, then .htaccess last', () => {
  assert.deepEqual(uploadOrder(['.htaccess', 'pricing/index.html', 'server/api/website-proof.php', '_astro/a.js', 'index.html', 'fonts/x.woff2']),
    ['_astro/a.js', 'fonts/x.woff2', 'index.html', 'pricing/index.html', 'server/api/website-proof.php', '.htaccess']);
});

test('never uploads the live email handler, private files or unsafe paths', () => {
  assert.deepEqual(checkedPaths(manifest(['index.html', 'server/api/website-proof.php'])), ['index.html', 'server/api/website-proof.php']);
  for (const bad of ['server/api/send-email.php', 'private/website-proof/x.json', '../x', 'a/../../b', '/etc/passwd', 'a b.html', 'a"b', 'x;rm']) {
    assert.throws(() => checkedPaths(manifest([bad])), undefined, bad);
  }
  assert.throws(() => checkedPaths({ ...manifest(['index.html']), preservedFiles: [] }), /preserve the live email handler/);
  assert.throws(() => checkedPaths({ ...manifest(['index.html']), mode: 'preview' }), /production/);
});

test('verifies pages by their clean URL and skips files that are not served as-is', () => {
  assert.equal(publicUrl('index.html'), '/');
  assert.equal(publicUrl('pricing/index.html'), '/pricing');
  assert.equal(publicUrl('_astro/a.js'), '/_astro/a.js');
  for (const hidden of ['.htaccess', 'server/api/website-proof.php', '404.html']) assert.equal(publicUrl(hidden), null);
});

test('flags live files changed outside the workflow, and nothing it wrote itself', () => {
  const next = { files: [{ path: 'index.html', sha256: 'new-home' }, { path: 'pricing/index.html', sha256: 'new-pricing' }, { path: 'about/index.html', sha256: 'same' }] };
  const state = { commit: 'abc', files: { 'index.html': 'old-home', 'pricing/index.html': 'old-pricing' } };
  // Last deploy's own files, and files already equal to the package, are not drift.
  assert.deepEqual(findDrift({ 'index.html': 'old-home', 'about/index.html': 'same' }, state, next), []);
  // A hand-uploaded page matches neither the record nor the package.
  assert.deepEqual(findDrift({ 'index.html': 'old-home', 'pricing/index.html': 'hand-edited' }, state, next), ['pricing/index.html']);
  // With no record (first deploy), every live file that would change counts.
  assert.deepEqual(findDrift({ 'pricing/index.html': 'whatever', 'index.html': 'live', 'about/index.html': 'same' }, null, next), ['index.html', 'pricing/index.html']);
});

test('verifies the home page and only the files this deploy changed, within the limit', () => {
  const files = ['index.html', 'about/index.html', 'pricing/index.html', '.htaccess', 'server/api/website-proof.php', '_astro/a.js']
    .map(path => ({ path, sha256: `new-${path}` }));
  const backup = { 'index.html': 'new-index.html', 'about/index.html': 'old', '.htaccess': 'old', 'pricing/index.html': 'new-pricing/index.html' };
  // Home page always; about changed; _astro/a.js is new; pricing unchanged; .htaccess and PHP are not served as-is.
  assert.deepEqual(verifySelection(files, backup).map(file => file.path), ['index.html', 'about/index.html', '_astro/a.js']);
  const many = Array.from({ length: 100 }, (_, index) => ({ path: `p${String(index).padStart(3, '0')}/index.html`, sha256: 'x' }));
  const picked = verifySelection([{ path: 'index.html', sha256: 'h' }, ...many], {}, 5).map(file => file.path);
  assert.deepEqual(picked, ['index.html', 'p000/index.html', 'p025/index.html', 'p050/index.html', 'p075/index.html']);
});

test('moves only the files whose content changed since the last recorded deploy', () => {
  const manifest = { files: [{ path: 'index.html', sha256: 'h2' }, { path: 'about/index.html', sha256: 'a1' }, { path: '_astro/new.js', sha256: 'n1' }] };
  const paths = manifest.files.map(file => file.path);
  const state = { commit: 'abc', files: { 'index.html': 'h1', 'about/index.html': 'a1' } };
  // Home changed, about unchanged, the new asset was never deployed.
  assert.deepEqual(changedPaths(paths, manifest, state), ['index.html', '_astro/new.js']);
  // No record, a damaged record or a full run: every file.
  assert.deepEqual(changedPaths(paths, manifest, null), paths);
  assert.deepEqual(changedPaths(paths, manifest, { files: [] }), paths);
  assert.deepEqual(changedPaths(paths, manifest, state, true), paths);
  // Nothing changed: nothing to move.
  assert.deepEqual(changedPaths(paths, manifest, { files: { 'index.html': 'h2', 'about/index.html': 'a1', '_astro/new.js': 'n1' } }), []);
});

test('uploads the list the backup chose, and refuses one naming files outside the package', () => {
  const paths = ['index.html', 'about/index.html'];
  const dir = mkdtempSync(join(tmpdir(), 'deploy-list-'));
  // An older backup folder with no list (or none given) means every file.
  assert.deepEqual(selectedPaths(paths, dir), paths);
  assert.deepEqual(selectedPaths(paths, undefined), paths);
  writeFileSync(join(dir, 'deploy-files.json'), JSON.stringify(['about/index.html']));
  assert.deepEqual(selectedPaths(paths, dir), ['about/index.html']);
  writeFileSync(join(dir, 'deploy-files.json'), JSON.stringify(['private/send-email-config.php']));
  assert.throws(() => selectedPaths(paths, dir), /not in this package/);
});
