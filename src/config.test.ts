import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;

  const VALID_ENV = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/whatsapp_brain',
    OPENAI_API_KEY: 'sk-test-key',
    WEBHOOK_SECRET: 'webhook-secret-16ch',
    SEARCH_TOKEN: 'search-token-16-ch',
    DATA_DIR: '/tmp/obsidian',
  };

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear all relevant keys before each test
    for (const key of Object.keys(VALID_ENV)) {
      delete process.env[key];
    }
    delete process.env['NODE_ENV'];
    delete process.env['PORT'];
    delete process.env['HOST'];
    delete process.env['INGEST_CONCURRENCY'];
    delete process.env['MATERIALIZER_CRON'];
    delete process.env['TZ'];
    delete process.env['LOG_LEVEL'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('calls process.exit(1) when DATABASE_URL is missing', () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => { throw new Error('process.exit called'); });

    // Set all required env vars except DATABASE_URL
    Object.assign(process.env, {
      OPENAI_API_KEY: VALID_ENV.OPENAI_API_KEY,
      WEBHOOK_SECRET: VALID_ENV.WEBHOOK_SECRET,
      SEARCH_TOKEN: VALID_ENV.SEARCH_TOKEN,
      DATA_DIR: VALID_ENV.DATA_DIR,
    });

    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('returns typed Env object when all required env vars are present', () => {
    Object.assign(process.env, VALID_ENV);

    const result = loadConfig();

    expect(result.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(typeof result.PORT).toBe('number');
    expect(result.PORT).toBe(3000);
  });

  it('calls process.exit(1) when PORT is not a number', () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => { throw new Error('process.exit called'); });

    Object.assign(process.env, VALID_ENV, { PORT: 'not-a-number' });

    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('PORT defaults to 3000 when not provided', () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env['PORT'];

    const result = loadConfig();

    expect(result.PORT).toBe(3000);
  });

  it('NODE_ENV defaults to "development" when not provided', () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env['NODE_ENV'];

    const result = loadConfig();

    expect(result.NODE_ENV).toBe('development');
  });
});
