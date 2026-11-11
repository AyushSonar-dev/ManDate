import { describe, expect, it } from 'vitest';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, jsonSchema, stepCountIs, tool } from 'ai';

const THOUGHT_SIGNATURE = 'SIGNATURE-FROM-TURN-1';

interface GeminiRequest {
  contents?: Array<{
    role?: string;
    parts?: Array<Record<string, unknown>>;
  }>;
}

function geminiResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Gemini thought signatures', () => {
  it('replays the signature from the first tool-call response on the second request', async () => {
    const requests: GeminiRequest[] = [];
    let callCount = 0;

    const fetch = async (
      _input: unknown,
      init?: { body?: string },
    ): Promise<Response> => {
      requests.push(JSON.parse(String(init?.body ?? '{}')) as GeminiRequest);
      callCount += 1;

      if (callCount === 1) {
        return geminiResponse({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'search_catalog',
                      args: { query: 'headphones' },
                    },
                    thoughtSignature: THOUGHT_SIGNATURE,
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            totalTokenCount: 2,
          },
        });
      }

      return geminiResponse({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'done' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      });
    };

    const google = createGoogleGenerativeAI({
      apiKey: 'test-key',
      fetch: fetch as never,
    });
    const result = await generateText({
      model: google('gemini-2.5-flash'),
      stopWhen: stepCountIs(2),
      tools: {
        search_catalog: tool({
          description: 'Search the catalog',
          inputSchema: jsonSchema<{ query: string }>({
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          }),
          execute: async ({ query }) => ({ results: [query] }),
        }),
      },
      prompt: 'find headphones',
    });

    expect(result.text).toBe('done');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0])).not.toContain(THOUGHT_SIGNATURE);

    const modelParts =
      requests[1]?.contents?.find((content) => content.role === 'model')
        ?.parts ?? [];
    const toolCallPart = modelParts.find((part) => 'functionCall' in part);

    expect(toolCallPart).toMatchObject({
      functionCall: { name: 'search_catalog' },
      thoughtSignature: THOUGHT_SIGNATURE,
    });
  });
});
