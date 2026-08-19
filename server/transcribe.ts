// Audio transcription for Tessa's dictation intake, via Groq's hosted
// Whisper (whisper-large-v3). Groq's free tier covers hours of audio per day
// and needs no card — grab a key at https://console.groq.com/keys and set
// GROQ_API_KEY. Accepts the formats phones actually produce (m4a, mp3, wav,
// ogg/opus voice notes, webm). No-key and API failures throw a plain Error
// with a human-readable message; callers surface it in-chat.

export function transcriptionConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = process.env.TRANSCRIBE_MODEL?.trim() || 'whisper-large-v3';

export async function transcribeAudio(audio: Buffer, filename: string, mimetype: string): Promise<string> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) {
    throw new Error('transcription is not set up — GROQ_API_KEY is missing (free key at console.groq.com/keys)');
  }
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimetype || 'audio/mpeg' }), filename || 'call.m4a');
  form.append('model', MODEL);
  form.append('response_format', 'text');
  form.append('temperature', '0');

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`transcription failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const text = (await res.text()).trim();
  if (!text) throw new Error('transcription came back empty — was the recording silent?');
  return text;
}
