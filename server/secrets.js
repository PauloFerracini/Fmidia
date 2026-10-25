const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Tokens das redes são guardados cifrados (AES-256-GCM). A chave vem de FMIDIA_SECRET;
// sem ela, uma chave aleatória é criada em data/secret.key na primeira execução.
let cachedKey;
function key() {
  if (cachedKey) return cachedKey;
  let secret = process.env.FMIDIA_SECRET;
  if (!secret) {
    const file = path.join(__dirname, '..', 'data', 'secret.key');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
      console.warn('[fmidia] FMIDIA_SECRET não definido: chave criada em data/secret.key (faça backup dela).');
    }
    secret = fs.readFileSync(file, 'utf8').trim();
  }
  cachedKey = crypto.createHash('sha256').update(secret).digest();
  return cachedKey;
}

function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

function decrypt(stored) {
  if (!stored) return null;
  const [, iv, tag, data] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
