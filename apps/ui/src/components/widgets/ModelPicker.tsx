import { useEffect, useMemo, useRef, useState } from 'react';
import { Select } from '../primitives/Select';
import { Spinner } from '../primitives/Spinner';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { listModels, syncModels, MODELS_CHANGED_EVENT, MODEL_POLICY_STORAGE_KEY, type ModelInfo } from '../../lib/api';

export interface ModelPickerProps {
  onChange?: (modelId: string, task: string) => void;
  task?: string;
  value?: string;
}

const PREFERRED_MODELS: Record<string, readonly string[]> = {
  'text-generation': [
    '@cf/meta/llama-3.2-3b-instruct',
    '@cf/meta/llama-3.1-8b-instruct-fp8',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/openai/gpt-oss-20b',
    '@cf/qwen/qwen2.5-coder-32b-instruct',
  ],
  'text-to-image': [
    '@cf/black-forest-labs/flux-1-schnell',
    '@cf/bytedance/stable-diffusion-xl-lightning',
    '@cf/lykon/dreamshaper-8-lcm',
  ],
};

function preferenceRank(model: ModelInfo, task?: string): number {
  const preferred = PREFERRED_MODELS[task ?? model.task] ?? [];
  const rank = preferred.indexOf(model.name);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

export function modelLabelForPicker(model: ModelInfo): string {
  return `${model.paid_required === true ? '💲 ' : ''}${model.name}${model.paid_required === null ? ' (billing unknown)' : ''}`;
}

export function sortModelsForPicker(models: ModelInfo[], task?: string): ModelInfo[] {
  return [...models].sort((a, b) => {
    const billingRank = (m: ModelInfo) => m.paid_required === true ? 2 : m.paid_required === null ? 1 : 0;
    const paidDelta = billingRank(a) - billingRank(b);
    if (paidDelta !== 0) return paidDelta;
    const rankDelta = preferenceRank(a, task) - preferenceRank(b, task);
    if (rankDelta !== 0) return rankDelta;
    return a.name.localeCompare(b.name);
  });
}

export function chooseDefaultModel(models: ModelInfo[], task?: string): ModelInfo | undefined {
  return sortModelsForPicker(models, task)[0];
}

export function ModelPicker({ onChange, task, value }: ModelPickerProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [internalSelected, setSelected] = useState('');
  const selected = value ?? internalSelected;

  const requestVersion = useRef(0);
  async function loadModels() {
    const version = ++requestVersion.current;
    const next = await listModels();
    if (version !== requestVersion.current) return;
    setModels(next);
    setError(null);
  }

  useEffect(() => {
    setLoading(true);
    loadModels()
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    const update = () => { void loadModels().catch((e: Error) => setError(e.message)); };
    const onStorage = (event: StorageEvent) => { if (event.key === MODEL_POLICY_STORAGE_KEY) update(); };
    window.addEventListener(MODELS_CHANGED_EVENT, update);
    window.addEventListener('storage', onStorage);
    return () => {
      requestVersion.current++;
      window.removeEventListener(MODELS_CHANGED_EVENT, update);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const filtered = useMemo(
    () => sortModelsForPicker(task ? models.filter((model) => model.task === task) : models, task),
    [models, task],
  );

  useEffect(() => {
    if (loading) return;
    const first = chooseDefaultModel(filtered, task);
    if (!first) {
      if (selected) {
        setSelected('');
        onChange?.('', task ?? '');
      }
      return;
    }
    if (selected && filtered.some((model) => model.name === selected)) return;
    setSelected(first.name);
    onChange?.(first.name, first.task);
  }, [task, loading, filtered, selected, onChange]);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      await syncModels();
      await loadModels();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to refresh models');
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) return <div className="flex h-8 items-center"><Spinner size="sm" /></div>;

  function handleSelect(val: string) {
    setSelected(val);
    const model = models.find((candidate) => candidate.name === val);
    onChange?.(val, model?.task ?? '');
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        {error ? (
          <Badge variant="danger">Model catalog error</Badge>
        ) : (
          <Select
            placeholder="Select a Model…"
            options={filtered.map((model) => ({ value: model.name, label: modelLabelForPicker(model) }))}
            value={selected}
            onValueChange={handleSelect}
            className="w-full"
          />
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        loading={refreshing}
        onClick={refresh}
        title="Fetch the latest model catalog from Cloudflare"
      >
        Refresh models
      </Button>
    </div>
  );
}
