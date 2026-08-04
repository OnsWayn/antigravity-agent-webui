const assert = require('node:assert/strict');
const test = require('node:test');
const tar = require('tar-stream');
const {
  extractFileFromTar,
  normalizeArchivePath
} = require('../environment-files');

function createArchive(entries) {
  const pack = tar.pack();
  for (const [name, content] of entries) {
    pack.entry({ name }, content);
  }
  pack.finalize();
  return pack;
}

test('normalizes sandbox and archive paths consistently', () => {
  assert.equal(normalizeArchivePath('/workspace/diagram.svg'), 'workspace/diagram.svg');
  assert.equal(normalizeArchivePath('./workspace\\diagram.svg'), 'workspace/diagram.svg');
});

test('extracts an SVG from an environment snapshot', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  const archive = createArchive([
    ['workspace/readme.txt', 'hello'],
    ['workspace/diagram.svg', svg]
  ]);

  const result = await extractFileFromTar(archive, '/workspace/diagram.svg');
  assert.equal(result.archivePath, '/workspace/diagram.svg');
  assert.equal(result.buffer.toString('utf8'), svg);
});

test('returns useful archive paths when a file is missing', async () => {
  const archive = createArchive([['workspace/actual.svg', '<svg/>']]);
  await assert.rejects(
    extractFileFromTar(archive, '/workspace/missing.svg'),
    error => {
      assert.equal(error.code, 'FILE_NOT_FOUND_IN_SNAPSHOT');
      assert.deepEqual(error.availablePaths, ['/workspace/actual.svg']);
      return true;
    }
  );
});

test('finds a uniquely named file without requiring its full path', async () => {
  const archive = createArchive([
    ['var/lib/dpkg/status', 'system data'],
    ['home/oai/share/generated/flowchart.svg', '<svg id="found"/>']
  ]);

  const result = await extractFileFromTar(archive, 'flowchart.svg');
  assert.equal(result.matchedBy, 'basename');
  assert.equal(result.archivePath, '/home/oai/share/generated/flowchart.svg');
  assert.equal(result.buffer.toString('utf8'), '<svg id="found"/>');
});

test('does not guess when multiple files have the same basename', async () => {
  const archive = createArchive([
    ['workspace/a/flowchart.svg', '<svg id="a"/>'],
    ['workspace/b/flowchart.svg', '<svg id="b"/>']
  ]);

  await assert.rejects(
    extractFileFromTar(archive, 'flowchart.svg'),
    error => {
      assert.equal(error.code, 'MULTIPLE_FILES_IN_SNAPSHOT');
      assert.deepEqual(error.availablePaths, [
        '/workspace/a/flowchart.svg',
        '/workspace/b/flowchart.svg'
      ]);
      return true;
    }
  );
});

test('treats a bare root filename as a basename search, not an exact path', async () => {
  const archive = createArchive([
    ['flowchart.svg', '<svg id="root"/>'],
    ['workspace/flowchart.svg', '<svg id="workspace"/>']
  ]);

  await assert.rejects(
    extractFileFromTar(archive, 'flowchart.svg'),
    error => {
      assert.equal(error.code, 'MULTIPLE_FILES_IN_SNAPSHOT');
      assert.deepEqual(error.availablePaths, [
        '/flowchart.svg',
        '/workspace/flowchart.svg'
      ]);
      return true;
    }
  );
});

test('prioritizes likely user files over operating-system files in suggestions', async () => {
  const archive = createArchive([
    ['var/lib/dpkg/status', 'system data'],
    ['usr/share/doc/example.txt', 'system docs'],
    ['flowchart.svg', '<svg/>']
  ]);

  await assert.rejects(
    extractFileFromTar(archive, '/tmp/workspace_project.zip'),
    error => {
      assert.equal(error.code, 'FILE_NOT_FOUND_IN_SNAPSHOT');
      assert.equal(error.availablePaths[0], '/flowchart.svg');
      return true;
    }
  );
});
