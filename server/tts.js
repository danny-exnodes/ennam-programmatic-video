// Voice-over synthesis. Pluggable: ElevenLabs (multilingual, good Vietnamese)
// or any OpenAI-compatible /audio/speech endpoint. Without a key, the team
// can still upload recorded voice lines on the "Lồng tiếng" tab.
import fs from 'node:fs/promises';

const EL_KEY = process.env.ELEVENLABS_API_KEY;
const OA_KEY = process.env.OPENAI_API_KEY;
const OA_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

export function ttsAvailable() {
  return !!(EL_KEY || OA_KEY);
}

export async function listVoices() {
  if (EL_KEY) {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': EL_KEY } });
    const j = await r.json();
    return (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name }));
  }
  if (OA_KEY) return ['alloy', 'nova', 'shimmer', 'echo', 'onyx', 'fable', 'coral', 'sage'].map((v) => ({ id: v, name: v }));
  return [];
}

export async function synthesize(text, outFile, { voice } = {}) {
  if (EL_KEY) {
    const vid = voice || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': EL_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3 } }),
    });
    if (!r.ok) throw new Error('ElevenLabs: ' + (await r.text()).slice(0, 300));
    await fs.writeFile(outFile, Buffer.from(await r.arrayBuffer()));
    return;
  }
  if (OA_KEY) {
    const r = await fetch(`${OA_BASE}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OA_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts', voice: voice || 'nova', input: text, response_format: 'mp3' }),
    });
    if (!r.ok) throw new Error('TTS: ' + (await r.text()).slice(0, 300));
    await fs.writeFile(outFile, Buffer.from(await r.arrayBuffer()));
    return;
  }
  throw new Error('Chưa cấu hình TTS (ELEVENLABS_API_KEY hoặc OPENAI_API_KEY). Bạn có thể tải file thu âm lên thay thế.');
}
