const integrations = require('./integrations');

let running = false;

// Publica todos os posts agendados cujo horário já passou. Retorna quantos foram processados.
async function runDuePosts(db, now = new Date()) {
  if (running) return 0; // publicações podem levar minutos (vídeo); evita rodadas sobrepostas
  running = true;
  try {
    const due = db.prepare(
      "SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at"
    ).all(now.toISOString());
    let processed = 0;
    for (const row of due) {
      // Trava o post; se outro processo já o pegou, pula.
      if (!db.prepare("UPDATE posts SET status = 'publishing' WHERE id = ? AND status = 'scheduled'").run(row.id).changes) continue;
      processed++;
      const post = { id: row.id, caption: row.caption, format: row.format, media: JSON.parse(row.media_urls || '[]') };
      const targets = db.prepare(
        'SELECT p.*, t.external_id AS done FROM post_targets t JOIN profiles p ON p.id = t.profile_id WHERE t.post_id = ?'
      ).all(row.id);

      let ok = 0;
      for (const profile of targets) {
        if (profile.done) { ok++; continue; } // já publicado numa tentativa anterior
        try {
          const { externalId, url } = await integrations.publish(db, profile, post);
          db.prepare('UPDATE post_targets SET external_id = ?, url = ?, error = NULL WHERE post_id = ? AND profile_id = ?')
            .run(externalId, url || null, row.id, profile.id);
          ok++;
        } catch (err) {
          db.prepare('UPDATE post_targets SET error = ? WHERE post_id = ? AND profile_id = ?').run(err.message, row.id, profile.id);
        }
      }
      // Falha se algum perfil não recebeu o post: permite reagendar só os que faltam.
      const status = ok === targets.length ? 'published' : 'failed';
      db.prepare('UPDATE posts SET status = ?, published_at = ? WHERE id = ?')
        .run(status, ok > 0 ? new Date().toISOString() : null, row.id);
    }
    return processed;
  } finally {
    running = false;
  }
}

// Um post preso em "publishing" significa que o servidor caiu no meio; não republicamos
// automaticamente para evitar posts duplicados.
function recoverInterrupted(db) {
  const stuck = db.prepare("SELECT id FROM posts WHERE status = 'publishing'").all();
  for (const { id } of stuck) {
    db.prepare("UPDATE post_targets SET error = 'Publicação interrompida; confira na rede antes de tentar de novo' WHERE post_id = ? AND external_id IS NULL").run(id);
    db.prepare("UPDATE posts SET status = 'failed' WHERE id = ?").run(id);
  }
  return stuck.length;
}

// Sincroniza métricas e comentários dos perfis conectados de verdade.
async function syncLiveProfiles(db, { metrics = true, inbox = true } = {}) {
  const profiles = db.prepare("SELECT * FROM profiles WHERE mode = 'live' AND status = 'active'").all();
  for (const p of profiles) {
    try {
      if (metrics) await integrations.syncMetrics(db, p, 2);
      if (inbox) await integrations.syncInbox(db, p);
    } catch (err) {
      db.prepare('UPDATE profiles SET last_error = ? WHERE id = ?').run(err.message, p.id);
    }
  }
}

function startScheduler(db, intervalMs = 15_000) {
  recoverInterrupted(db);
  const timers = [
    setInterval(() => runDuePosts(db).catch((err) => console.error('[scheduler]', err)), intervalMs),
    setInterval(() => syncLiveProfiles(db, { metrics: false }).catch((err) => console.error('[inbox]', err)), 10 * 60_000),
    setInterval(() => syncLiveProfiles(db, { inbox: false }).catch((err) => console.error('[metrics]', err)), 6 * 3600_000),
  ];
  timers.forEach((t) => t.unref());
  return timers;
}

module.exports = { runDuePosts, recoverInterrupted, syncLiveProfiles, startScheduler };
