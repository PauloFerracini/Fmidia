const { providers } = require('./providers');
const { tx } = require('./db');

// Publica todos os posts agendados cujo horário já passou. Retorna quantos foram processados.
function runDuePosts(db, now = new Date()) {
  const due = db.prepare(
    "SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at"
  ).all(now.toISOString());

  for (const post of due) {
    const targets = db.prepare(
      'SELECT p.* FROM post_targets t JOIN profiles p ON p.id = t.profile_id WHERE t.post_id = ?'
    ).all(post.id);

    tx(db, () => {
      let ok = 0;
      for (const profile of targets) {
        try {
          const { externalId } = providers[profile.network].publish(profile, post);
          db.prepare('UPDATE post_targets SET external_id = ?, error = NULL WHERE post_id = ? AND profile_id = ?')
            .run(externalId, post.id, profile.id);
          ok++;
        } catch (err) {
          db.prepare('UPDATE post_targets SET error = ? WHERE post_id = ? AND profile_id = ?')
            .run(err.message, post.id, profile.id);
        }
      }
      const status = ok > 0 ? 'published' : 'failed';
      db.prepare('UPDATE posts SET status = ?, published_at = ? WHERE id = ?')
        .run(status, ok > 0 ? now.toISOString() : null, post.id);
    });
  }
  return due.length;
}

function startScheduler(db, intervalMs = 15_000) {
  const timer = setInterval(() => {
    try { runDuePosts(db); } catch (err) { console.error('[scheduler]', err); }
  }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { runDuePosts, startScheduler };
