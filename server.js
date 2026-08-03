const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '12mb' })); // handwriting photos as base64 can be a few MB

// ---- Plain JSON-file storage (no native modules, no build step, works anywhere) ----
const DB_PATH = path.join(__dirname, 'data.json');
let store = { boards: {}, usage: {} };
try {
  if (fs.existsSync(DB_PATH)) {
    store = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!store.boards) store.boards = {};
    if (!store.usage) store.usage = {};
  }
} catch (e) {
  console.error('Could not read data.json, starting fresh', e);
}
let writeTimer = null;
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    fs.writeFile(DB_PATH, JSON.stringify(store), (err) => {
      if (err) console.error('Could not write data.json', err);
    });
  }, 200);
}

const DAILY_CAP = parseInt(process.env.DAILY_CAP || '200', 10);
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash';

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Returns true if the call is allowed (and records it), false if the daily cap is hit.
function checkAndIncrementUsage() {
  const day = today();
  const count = store.usage[day] || 0;
  if (count >= DAILY_CAP) return false;
  store.usage[day] = count + 1;
  persist();
  return true;
}

// ---- Board persistence (anonymous, per-visitor-id) ----

app.get('/api/board', (req, res) => {
  const vid = req.query.visitor;
  if (!vid) return res.status(400).json({ error: 'missing visitor id' });
  const entry = store.boards[vid];
  if (!entry) return res.json(null);
  res.json({ themes: entry.themes || [], cross: entry.cross || [] });
});

app.post('/api/board', (req, res) => {
  const { visitor, themes, cross } = req.body || {};
  if (!visitor) return res.status(400).json({ error: 'missing visitor id' });
  store.boards[visitor] = { themes: themes || [], cross: cross || [], updatedAt: new Date().toISOString() };
  persist();
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
    const themeListText = Array.isArray(themeList) && themeList.length ? themeList.join('\n') : '(none yet \u2014 this will be the first theme)';

    const promptText =
      'You read photos of a person\'s handwritten journal page and turn it into a structured note, and you also decide which ' +
      'branch/theme of their journal it belongs to. Respond ONLY with raw JSON, no preamble, no markdown fences. Shape: ' +
      '{"title":string,"key_question":string,"body":string,"summary":string,"source_guess":string,"theme_name":string,"theme_question":string,"analysis":string}. ' +
      'title is short (3-6 words). key_question is the question this note is really exploring. ' +
      'body is the cleaned-up content in the writer\'s own voice, a few sentences. summary is one line. ' +
      'source_guess is a podcast/book/article name only if the page clearly mentions one, else empty string. ' +
      'theme_name is a short 2-4 word Title Case label for the branch this note belongs under (e.g. "Career Plans", "Inner Reflection"). ' +
      'Here are the person\'s existing theme names \u2014 if this note clearly fits one, reuse that EXACT name (same spelling/casing); ' +
      'only invent a new theme_name if none of these genuinely fit:\n' + themeListText + '\n' +
      'theme_question is a short guiding question for that whole theme (only meaningfully used if this is a new theme), e.g. "what am I building?". ' +
      'analysis is 2-3 warm, perceptive sentences, second person ("you"), noticing why this note might matter or what it connects to in the person\'s life ' +
      '\u2014 like an attentive friend pointing something out, not a corporate summary.' +
      '\n\nRead this handwritten page and turn it into a structured note as JSON.';

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

// Return JSON (not Express's default HTML error page) for things like oversized uploads,
// so the frontend's fetch().json() never chokes trying to parse an HTML error page.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, message: 'That photo is too large \u2014 try a smaller photo, or crop it a bit.' });
  }
  console.error('Unhandled error', err);
  res.status(500).json({ ok: false, message: 'Something went wrong on the server \u2014 try again.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Margin server running on port ' + PORT));
