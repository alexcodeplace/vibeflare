import { describe, expect, it } from 'vitest';
import {
  chooseDefaultModel,
  modelLabelForPicker,
  sortModelsForPicker,
} from '../../src/components/widgets/ModelPicker';
import type { ModelInfo } from '../../src/lib/api';

function model(name: string, task = 'text-generation', paidRequired = false): ModelInfo {
  return { name, task, paid_required: paidRequired };
}

describe('chooseDefaultModel', () => {
  it('prefers the live-proven text model over catalog order', () => {
    const models = [
      model('@cf/aisingapore/gemma-sea-lion-v4-27b-it'),
      model('@cf/meta/llama-3.2-3b-instruct'),
    ];
    expect(chooseDefaultModel(models, 'text-generation')?.name).toBe('@cf/meta/llama-3.2-3b-instruct');
  });

  it('falls back to the first available model when no preferred model exists', () => {
    const models = [model('@cf/example/first'), model('@cf/example/second')];
    expect(chooseDefaultModel(models, 'text-generation')?.name).toBe('@cf/example/first');
  });

  it('keeps free models ahead of paid-required models even when paid models are included', () => {
    const models = [
      model('@cf/deepseek-ai/deepseek-v4-flash-0731', 'text-generation', true),
      model('@cf/example/free'),
    ];
    expect(sortModelsForPicker(models, 'text-generation').map((item) => item.name)).toEqual([
      '@cf/example/free',
      '@cf/deepseek-ai/deepseek-v4-flash-0731',
    ]);
  });

  it('keeps preferred models first while retaining every other free model alphabetically', () => {
    const models = [
      model('@cf/z/example-z'),
      model('@cf/qwen/qwen2.5-coder-32b-instruct'),
      model('@cf/a/example-a'),
      model('@cf/meta/llama-3.2-3b-instruct'),
      model('@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
    ];
    expect(sortModelsForPicker(models, 'text-generation').map((item) => item.name)).toEqual([
      '@cf/meta/llama-3.2-3b-instruct',
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      '@cf/qwen/qwen2.5-coder-32b-instruct',
      '@cf/a/example-a',
      '@cf/z/example-z',
    ]);
  });

  it('marks paid-required models with a dollar emoji in the selector label', () => {
    expect(modelLabelForPicker(model('@cf/deepseek-ai/deepseek-v4-flash-0731', 'text-generation', true)))
      .toBe('💲 @cf/deepseek-ai/deepseek-v4-flash-0731');
    expect(modelLabelForPicker(model('@cf/meta/llama-3.2-3b-instruct')))
      .toBe('@cf/meta/llama-3.2-3b-instruct');
  });

  it('prefers FLUX Schnell for image generation without hiding the rest', () => {
    const models = [
      model('@cf/example/other-image', 'text-to-image'),
      model('@cf/black-forest-labs/flux-1-schnell', 'text-to-image'),
    ];
    expect(chooseDefaultModel(models, 'text-to-image')?.name).toBe('@cf/black-forest-labs/flux-1-schnell');
  });
});
