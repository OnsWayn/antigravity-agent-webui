const assert = require('node:assert/strict');
const test = require('node:test');
const { decryptSecret, encryptSecret, generateClientToken, sha256 } = require('../gateway/crypto');

test('encrypts and decrypts upstream keys', () => {
  const master = 'test-master-key';
  const encrypted = encryptSecret('super-secret', master);
  assert.notEqual(encrypted.ciphertext, 'super-secret');
  assert.equal(decryptSecret(encrypted, master), 'super-secret');
  assert.throws(() => decryptSecret(encrypted, 'other-master'));
});

test('client tokens are hashed, not stored raw', () => {
  const generated = generateClientToken();
  assert.match(generated.token, /^ag-[0-9a-f]{64}$/);
  assert.equal(generated.tokenHash, sha256(generated.token));
  assert.equal(generated.token.includes(generated.tokenHash), false);
});
