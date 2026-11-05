/**
 * OpenAI для Kayospace (решение 0018): генерация картинок («нарисуй …») и распознавание голоса
 * для ИИ в приложении. Включается ключом OPENAI_API_KEY на сервере; без ключа хаб работает как раньше
 * (рисует Claude разметкой SVG, голоса нет). Ключ живёт только на хабе — устройствам он не нужен.
 */

export interface OpenAiConfig {
  apiKey: string;
  /** Для тестов — свой адрес вместо https://api.openai.com. */
  baseUrl?: string;
  imageModel?: string;
  imageQuality?: string;
  transcribeModel?: string;
  /** Модель, которая смотрит на картинки (распознавание рукописного). */
  visionModel?: string;
  fetch?: typeof fetch;
}

export type ImageShape = 'square' | 'landscape' | 'portrait';

const SIZES: Record<ImageShape, string> = {
  square: '1024x1024',
  landscape: '1536x1024',
  portrait: '1024x1536',
};

/** Голос не длиннее — на случай забытой записи. */
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;

export class OpenAiError extends Error {}

/** Настройки из переменных окружения; null — ключа нет, OpenAI выключен. */
export function openAiFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAiConfig | null {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
    imageModel: env.OPENAI_IMAGE_MODEL?.trim() || undefined,
    imageQuality: env.OPENAI_IMAGE_QUALITY?.trim() || undefined,
    transcribeModel: env.OPENAI_TRANSCRIBE_MODEL?.trim() || undefined,
    visionModel: env.OPENAI_VISION_MODEL?.trim() || undefined,
  };
}

export class OpenAi {
  constructor(private readonly cfg: OpenAiConfig) {}

  private url(path: string): string {
    return `${(this.cfg.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '')}${path}`;
  }

  private async post(path: string, body: BodyInit, json: boolean): Promise<unknown> {
    const f = this.cfg.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(this.url(path), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          ...(json ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new OpenAiError(
        `OpenAI не отвечает: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    if (!res.ok) {
      const why = data.error?.message ?? `ответ ${res.status}`;
      if (res.status === 401) throw new OpenAiError('OpenAI не принял ключ (OPENAI_API_KEY).');
      if (res.status === 429 || data.error?.code === 'insufficient_quota')
        throw new OpenAiError(`OpenAI: закончился баланс или лимит — ${why}`);
      if (data.error?.code === 'moderation_blocked' || /safety|moderation/i.test(why))
        throw new OpenAiError('OpenAI отказался рисовать это (правила безопасности).');
      throw new OpenAiError(`OpenAI: ${why}`);
    }
    return data;
  }

  /** Нарисовать картинку по описанию. PNG/JPEG/WebP — как ответит модель. */
  async generateImage(prompt: string, shape: ImageShape = 'square'): Promise<Buffer> {
    const data = (await this.post(
      '/v1/images/generations',
      JSON.stringify({
        model: this.cfg.imageModel ?? 'gpt-image-2',
        prompt,
        size: SIZES[shape],
        quality: this.cfg.imageQuality ?? 'medium',
        n: 1,
      }),
      true,
    )) as { data?: { b64_json?: string }[] };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new OpenAiError('OpenAI не вернул картинку.');
    return Buffer.from(b64, 'base64');
  }

  /** Распознать речь. mime — как записал браузер (audio/webm, audio/mp4…). */
  async transcribe(audio: Buffer, mime: string): Promise<string> {
    const ext = /mp4|m4a|aac/.test(mime)
      ? 'm4a'
      : /mpeg|mp3/.test(mime)
        ? 'mp3'
        : /wav/.test(mime)
          ? 'wav'
          : /ogg/.test(mime)
            ? 'ogg'
            : 'webm';
    const form = new FormData();
    form.append('model', this.cfg.transcribeModel ?? 'gpt-transcribe');
    form.append(
      'file',
      new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' }),
      `voice.${ext}`,
    );
    form.append(
      'prompt',
      'Голосовая просьба к ИИ-помощнику на доске Kayospace: стикеры, фреймы, картинки, схемы.',
    );
    const data = (await this.post('/v1/audio/transcriptions', form, false)) as { text?: string };
    return (data.text ?? '').trim();
  }

  /**
   * Прочитать рукописное на картинках (решение 0018): для каждой — текст как написан
   * (переносы строк сохраняются), пустая строка — если там рисунок без слов.
   */
  async readHandwriting(images: readonly Buffer[]): Promise<string[]> {
    const content: unknown[] = [
      {
        type: 'input_text',
        text:
          `Перед тобой ${images.length} картинок с рукописными фрагментами доски (по порядку, с 1). ` +
          'Для каждой распознай написанное от руки — дословно, на языке оригинала, сохраняя переносы строк. ' +
          'Если на картинке нет слов (рисунок, схема из линий) — верни пустую строку. Ничего не придумывай. ' +
          'Ответь только JSON: {"items":[{"n":1,"text":"..."}]}.',
      },
      ...images.map((b) => ({
        type: 'input_image',
        image_url: `data:image/png;base64,${b.toString('base64')}`,
      })),
    ];
    const data = (await this.post(
      '/v1/responses',
      JSON.stringify({
        model: this.cfg.visionModel ?? 'gpt-6.1-terra',
        input: [{ role: 'user', content }],
        text: { format: { type: 'json_object' } },
      }),
      true,
    )) as {
      output_text?: string;
      output?: { type?: string; content?: { type?: string; text?: string }[] }[];
    };
    const raw =
      data.output_text ??
      data.output?.flatMap((o) => o.content ?? []).find((c) => c.type === 'output_text')?.text ??
      '';
    let items: { n?: number; text?: string }[] = [];
    try {
      items = (JSON.parse(raw) as { items?: typeof items }).items ?? [];
    } catch {
      throw new OpenAiError('OpenAI ответил не JSON при распознавании рукописного.');
    }
    return images.map((_, i) => (items.find((x) => x.n === i + 1)?.text ?? '').trim());
  }
}
