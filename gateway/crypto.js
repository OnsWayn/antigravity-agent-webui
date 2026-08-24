const crypto = require('crypto');

function masterKeyBuffer(masterKey) {
  if (!masterKey) {
    const error = new Error('GATEWAY_MASTER_KEY is not configured');
    error.code = 'GATEWAY_NOT_CONFIGURED';
    throw error;
  }
  return crypto.createHash('sha256').update(String(masterKey), 'utf8').digest();
}

function encryptSecret(plain, masterKey) {
  const key = masterKeyBuffer(masterKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  };
}

function decryptSecret({ ciphertext, iv, tag }, masterKey) {
  const key = masterKeyBuffer(masterKey);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function generateClientToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = `ag-${raw}`;
  return {
    token,
    tokenHash: sha256(token),
    tokenPrefix: token.slice(0, 10)
  };
}

function keySuffix(apiKey) {
  const value = String(apiKey || '');
  return value.slice(-4);
}

module.exports = {
  encryptSecret,
  decryptSecret,
  sha256,
  generateClientToken,
  keySuffix
};
