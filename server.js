const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json({ limit: '12mb' })); // handwriting photos as base64 can be a few MB

const db = new Database(path.join(__dirname, 'margin.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    visitor_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage (
    day TEXT PRIMARY KEY,
    count INTEGER NOT NULL
  );
`);

const DAILY_CAP = parseInt(process.env.DAILY_CAP || '200', 10);
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash';

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Returns true if the call is allowed (and records it), false if the daily cap is hit.
function checkAndIncrementUsage() {
  const day = today();
  const row = db.prepare('SELECT count FROM usage WHERE day=?').get(day);
  const count = row ? row.count : 0;
  if (count >= DAILY_CAP) return false;
  if (row) db.prepare('UPDATE usage SET count=? WHERE day=?').run(count + 1, day);
  else db.prepare('INSERT INTO usage (day,count) VALUES (?,1)').run(day);
  return true;
}

// ---- Board persistence (anonymous, per-visitor-id) ----

app.get('/api/board', (req, res) => {
  const vid = req.query.visitor;
  if (!vid) return res.status(400).json({ error: 'missing visitor id' });
  const row = db.prepare('SELECT data FROM boards WHERE visitor_id=?').get(vid);
  if (!row) return res.json(null);
  try {
    res.json(JSON.parse(row.data));
  } catch (e) {
    res.json(null);
  }
});

app.post('/api/board', (req, res) => {
  const { visitor, themes, cross } = req.body || {};
  if (!visitor) return res.status(400).json({ error: 'missing visitor id' });
  const data = JSON.stringify({ themes: themes || [], cross: cross || [] });
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO boards (visitor_id, data, updated_at) VALUES (?,?,?)
     ON CONFLICT(visitor_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
  ).run(visitor, data, now);
  res.json({ ok: true });
});

// ---- AI proxy endpoints (API key never leaves the server) ----

app.post('/api/transcribe', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ ok: false, message: 'Server is missing its Gemini API key.' });
  if (!checkAndIncrementUsage()) {
    return res.status(429).json({ ok: false, message: "Margin's demo has hit its daily AI limit \u2014 try again tomorrow, or fill in the note by hand for now." });
  }
  try {
    const { image, themeList } = req.body || {};
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(image || '');
    if (!match) return res.status(400).json({ ok: false, message: 'That image could not be read.' });
    const [, mediaType, base64] = match;
    const themeListText = Array.isArray(themeList) ? themeList.join('\n') : '';

    const promptText =
      'You read photos of a person\'s handwritten journal page and turn it into a structured Cornell note. ' +
      'Respond ONLY with raw JSON, no preamble, no markdown fences. Shape: ' +
      '{"title":string,"key_question":string,"body":string,"summary":string,"source_guess":string,"theme_id":string}. ' +
      'title is short (3-6 words). key_question is the question this note is really exploring. ' +
      'body is the cleaned-up content in the writer\'s own voice, a few sentences. summary is one line. ' +
      'source_guess is a podcast/book/article name only if the page clearly mentions one, else empty string. ' +
      'theme_id must be the single best-fit id from this list of existing themes (pick even if imperfect):\n' + themeListText +
      '\n\nRead this handwritten page and turn it into a Cornell note as JSON.';

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: promptText },
                { inline_data: { mime_type: mediaType, data: base64 } },
              ],
            },
          ],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      }
    );
    const data = await r.json();
    if (!r.ok) {
      console.error('Gemini error', data);
      return res.status(502).json({ ok: false, message: "Couldn't reach the AI reader \u2014 try again in a moment." });
    }
    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ ok: true, note: parsed });
  } catch (err) {
    console.error('transcribe error', err);
    res.status(500).json({ ok: false, message: "Couldn't read that page \u2014 try again or fill it in by hand." });
  }
});

app.post('/api/thread', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ ok: false, message: 'Server is missing its Gemini API key.' });
  if (!checkAndIncrementUsage()) {
    return res.status(429).json({ ok: false, message: "Margin's demo has hit its daily AI limit \u2014 try again tomorrow." });
  }
  try {
    const { notesText } = req.body || {};
    if (!notesText) return res.status(400).json({ ok: false, message: 'No notes to look through yet.' });

    const promptText =
      "You are a perceptive, warm second brain for someone's personal handwritten journal. Given a set of their own notes, " +
      'notice what they keep circling around \u2014 a tension, a recurring question, a thread connecting things they may not have ' +
      "consciously linked. Write 3-5 short sentences, second person ('you'), like an attentive friend gently pointing something out. " +
      'No headers, no bullet points, no therapy-speak, no corporate summary tone \u2014 just plain warm prose that could sit handwritten in a margin.' +
      '\n\nHere are my notes:\n\n' + notesText;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] }),
      }
    );
    const data = await r.json();
    if (!r.ok) {
      console.error('Gemini error', data);
      return res.status(502).json({ ok: false, message: 'Something went wrong reaching the thread-finder.' });
    }
    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    res.json({ ok: true, text: raw });
  } catch (err) {
    console.error('thread error', err);
    res.status(500).json({ ok: false, message: 'Something went wrong reaching the thread-finder.' });
  }
});

// ---- Static frontend ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Margin server running on port ' + PORT));
