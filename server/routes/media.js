const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { requireBrand } = require('../auth');
const { config } = require('../config');

// Instagram só aceita JPEG em imagens; PNG/WebP funcionam no Facebook e TikTok (WebP).
const TYPES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
};

const uploadsDir = () => process.env.FMIDIA_UPLOADS || path.join(__dirname, '..', '..', 'data', 'uploads');

// Upload de mídia própria. As redes baixam o arquivo pela URL pública (PUBLIC_URL/media/...),
// então o servidor precisa estar acessível pela internet com HTTPS.
function mediaRoutes(db) {
  const r = express.Router({ mergeParams: true });
  r.post('/', requireBrand(db, 'editor'),
    express.raw({ type: Object.keys(TYPES), limit: process.env.FMIDIA_UPLOAD_LIMIT || '300mb' }),
    (req, res) => {
      const ext = TYPES[req.headers['content-type']];
      if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: 'Envie uma imagem JPEG, PNG ou WebP, ou um vídeo MP4/MOV' });
      }
      fs.mkdirSync(uploadsDir(), { recursive: true });
      const name = `${req.brandId}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(uploadsDir(), name), req.body);
      res.status(201).json({ url: `${config.publicUrl()}/media/${name}`, type: req.headers['content-type'] });
    });
  return r;
}

module.exports = { mediaRoutes, uploadsDir };
