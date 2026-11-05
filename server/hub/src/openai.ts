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
  /** Дневные потолки (решение 0019): сколько картинок, записей голоса и групп рукописного в сутки. */
  limits?: Partial<Record<UsageKind, number>>;
  /** Фоновое распознавание рукописного (по умолчанию включено). */
  handwriting?: boolean;
  /** Куда записывать расход за день (переживает перезапуск); без — только в памяти. */
  usageFile?: string;
  /** Настройки из приложения (лимиты, рукописное) — поверх переменных окружения. */
  settingsFile?: string;
  fetch?: typeof fetch;
}

export type UsageKind = 'images' | 'voice' | 'handwriting';

/** Самые большие потолки, какие можно выставить из приложения. */
export const MAX_LIMITS: Record<UsageKind, number> = {
  images: 1000,
  voice: 2000,
  handwriting: 20000,
};

export interface OpenAiSettings {
  limits: Record<UsageKind, number>;
  handwriting: boolean;
}

/** Потолки по умолчанию: с запасом для одного человека и без риска сжечь баланс. */
export const DEFAULT_LIMITS: Record<UsageKind, number> = {
  images: 30,
  voice: 100,
  handwriting: 500,
};

const USAGE_NAMES: Record<UsageKind, string> = {
  images: 'картинок',
  voice: 'голосовых запросов',
  handwriting: 'фрагментов рукописного',
};
/** Начальные лимиты можно задать и в окружении; из приложения — поверх. */
const LIMIT_ENV: Record<UsageKind, string> = {
  images: 'OPENAI_LIMIT_IMAGES',
  voice: 'OPENAI_LIMIT_VOICE',
  handwriting: 'OPENAI_LIMIT_HANDWRITING',
};

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
    handwriting: !/^(0|off|false|no|нет)$/i.test(env.OPENAI_HANDWRITING?.trim() ?? ''),
    limits: Object.fromEntries(
      (Object.keys(LIMIT_ENV) as UsageKind[])
        .map((k) => [k, Number(env[LIMIT_ENV[k]])] as const)
        .filter(([, v]) => Number.isFinite(v) && v >= 0),
    ),
  };
}

export class OpenAi {
  private usage: { day: string; used: Record<UsageKind, number> } = {
    day: '',
    used: { images: 0, voice: 0, handwriting: 0 },
  };
  private loaded: Promise<void> | null = null;

  constructor(
    private readonly cfg: OpenAiConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** Что выставили в приложении (переживает перезапуск); null — как в окружении. */
  private saved: Partial<OpenAiSettings> = {};
  private savedLoaded: Promise<void> | null = null;

  /** Прочитать настройки из приложения (при запуске хаба). */
  async init(): Promise<void> {
    this.savedLoaded ??= (async () => {
      if (!this.cfg.settingsFile) return;
      try {
        const { readFile } = await import('node:fs/promises');
        this.saved = JSON.parse(
          await readFile(this.cfg.settingsFile, 'utf8'),
        ) as Partial<OpenAiSettings>;
      } catch {
        /* из приложения ещё не меняли */
      }
    })();
    await this.savedLoaded;
  }

  get handwritingEnabled(): boolean {
    return this.saved.handwriting ?? this.cfg.handwriting !== false;
  }

  limit(kind: UsageKind): number {
    return this.saved.limits?.[kind] ?? this.cfg.limits?.[kind] ?? DEFAULT_LIMITS[kind];
  }

  settings(): OpenAiSettings {
    return {
      limits: {
        images: this.limit('images'),
        voice: this.limit('voice'),
        handwriting: this.limit('handwriting'),
      },
      handwriting: this.handwritingEnabled,
    };
  }

  /** Поменять лимиты и рукописное из приложения. Неверное значение — ошибка с объяснением. */
  async update(patch: {
    limits?: Partial<Record<UsageKind, unknown>>;
    handwriting?: unknown;
  }): Promise<OpenAiSettings> {
    await this.init();
    const limits = { ...this.saved.limits } as Record<UsageKind, number>;
    for (const [k, v] of Object.entries(patch.limits ?? {})) {
      if (!(k in DEFAULT_LIMITS)) throw new OpenAiError(`Неизвестный лимит: ${k}`);
      const n = Number(v);
      const kind = k as UsageKind;
      if (!Number.isInteger(n) || n < 0 || n > MAX_LIMITS[kind])
        throw new OpenAiError(
          `Лимит ${USAGE_NAMES[kind]} — целое число от 0 до ${MAX_LIMITS[kind]}`,
        );
      limits[kind] = n;
    }
    const next: Partial<OpenAiSettings> = { ...this.saved, limits };
    if (patch.handwriting !== undefined) next.handwriting = patch.handwriting === true;
    this.saved = next;
    if (this.cfg.settingsFile) {
      const { writeFile, rename } = await import('node:fs/promises');
      await writeFile(`${this.cfg.settingsFile}.tmp`, JSON.stringify(next));
      await rename(`${this.cfg.settingsFile}.tmp`, this.cfg.settingsFile);
    }
    return this.settings();
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private async load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.cfg.usageFile) return;
      try {
        const { readFile } = await import('node:fs/promises');
        const u = JSON.parse(await readFile(this.cfg.usageFile, 'utf8')) as typeof this.usage;
        if (u?.day && u.used) this.usage = { day: u.day, used: { ...this.usage.used, ...u.used } };
      } catch {
        /* расхода ещё нет */
      }
    })();
    await this.loaded;
    if (this.usage.day !== this.today())
      this.usage = { day: this.today(), used: { images: 0, voice: 0, handwriting: 0 } };
  }

  /** Расход за сегодня и потолки — для приложения. */
  async usageToday(): Promise<Record<UsageKind, { used: number; limit: number }>> {
    await this.load();
    const out = {} as Record<UsageKind, { used: number; limit: number }>;
    for (const k of Object.keys(DEFAULT_LIMITS) as UsageKind[])
      out[k] = { used: this.usage.used[k], limit: this.limit(k) };
    return out;
  }

  /** Сколько ещё можно сегодня. */
  async left(kind: UsageKind): Promise<number> {
    await this.load();
    return Math.max(0, this.limit(kind) - this.usage.used[kind]);
  }

  /** Взять n из дневного потолка; не хватает — понятная ошибка, запрос в OpenAI не уходит. */
  private async take(kind: UsageKind, n = 1): Promise<void> {
    await this.load();
    if (this.usage.used[kind] + n > this.limit(kind)) {
      throw new OpenAiError(
        `Дневной лимит ${USAGE_NAMES[kind]} OpenAI исчерпан (${this.limit(kind)} в сутки) — ` +
          'завтра снова. Поднять лимит — в приложении: Настройки → OpenAI.',
      );
    }
    this.usage.used[kind] += n;
    if (this.cfg.usageFile) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(this.cfg.usageFile, JSON.stringify(this.usage)).catch(() => {});
    }
  }

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
    await this.take('images');
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
    await this.take('voice');
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
    await this.take('handwriting', images.length);
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
