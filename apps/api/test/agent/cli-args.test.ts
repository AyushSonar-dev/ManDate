import { describe, expect, it } from 'vitest';
import { parseAgentCliArgs } from '../../src/agent/cli-args.js';

describe('parseAgentCliArgs', () => {
  it('parses a mandate id and shopping request', () => {
    expect(
      parseAgentCliArgs([
        '--mandate',
        'mandate-1',
        'buy',
        'wireless',
        'headphones',
      ]),
    ).toEqual({
      mandateId: 'mandate-1',
      prompt: 'buy wireless headphones',
    });
  });

  it('accepts --mandate=<id>', () => {
    expect(
      parseAgentCliArgs(['--mandate=mandate-1', 'buy a book']),
    ).toEqual({
      mandateId: 'mandate-1',
      prompt: 'buy a book',
    });
  });

  it('rejects a missing mandate id or prompt', () => {
    expect(() => parseAgentCliArgs(['buy a book'])).toThrowError(
      /--mandate is required/,
    );
    expect(() => parseAgentCliArgs(['--mandate', 'mandate-1'])).toThrowError(
      /shopping request is required/,
    );
  });

  it('rejects unknown options', () => {
    expect(() =>
      parseAgentCliArgs(['--mandate', 'mandate-1', '--fast', 'buy a book']),
    ).toThrowError(/Unknown option --fast/);
  });
});
