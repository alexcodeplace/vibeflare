import { useEffect, useState } from 'react';
import { Card } from '../primitives/Card';
import { Tabs } from '../primitives/Tabs';
import type { TabItem } from '../primitives/Tabs';
import { Button } from '../primitives/Button';
import { Input } from '../primitives/Input';
import { Spinner } from '../primitives/Spinner';
import { Badge } from '../primitives/Badge';
import { Checkbox } from '../primitives/Checkbox';
import { Toast, ToastProvider } from '../primitives/Toast';
import { PasskeyButton } from './PasskeyButton';
import { HydratedIsland } from '../HydratedIsland';
import { InvitesTab } from './InvitesTab';
import {
  me, logout, getSettings, setSetting,
  listCredentials, revokeCredential,
  listPrompts, createPrompt, deletePrompt,
  listModels, syncModels,
  type UserInfo, type Credential, type PromptRecord, type ModelInfo,
} from '../../lib/api';

/**
 * Settings page: Account / Devices / Auth / Cache tabs.
 */
export function parseExcludePaidSetting(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

function SettingsPageInner() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [prompts, setPrompts] = useState<PromptRecord[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [syncingModels, setSyncingModels] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ open: boolean; title: string; variant: 'success' | 'danger' }>({
    open: false, title: '', variant: 'success',
  });
  const [ghAllowed, setGhAllowed] = useState('');
  const [cacheTtl, setCacheTtl] = useState('7');
  const [excludePaid, setExcludePaid] = useState(true);
  const [savingPaidPolicy, setSavingPaidPolicy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [newPromptLabel, setNewPromptLabel] = useState('');
  const [newPromptContent, setNewPromptContent] = useState('');

  useEffect(() => {
    Promise.all([
      me().catch(() => null),
      listCredentials().catch(() => []),
      getSettings().catch((error: Error) => { setSettingsError(error.message); return []; }),
      listPrompts().catch(() => []),
      listModels().catch(() => []),
    ]).then(([u, creds, setts, proms, mods]) => {
      setUser(u);
      setCredentials(creds);
      setPrompts(proms);
      setModels(mods);
      const ttl = setts.find(s => s.key === 'cache.responses.ttl_days')?.value;
      if (ttl) setCacheTtl(ttl);
      setGhAllowed(setts.find(s => s.key === 'github.allowed_logins')?.value ?? '');
      setExcludePaid(parseExcludePaidSetting(setts.find(s => s.key === 'models.exclude_paid')?.value));
    }).finally(() => setLoading(false));
  }, []);

  function showToast(title: string, variant: 'success' | 'danger' = 'success') {
    setToast({ open: true, title, variant });
  }

  async function handleLogout() {
    try {
      await logout();
      window.location.href = '/login';
    } catch {
      showToast('Logout failed', 'danger');
    }
  }

  async function saveGhAllowedLogins() {
    try {
      await setSetting('github.allowed_logins', ghAllowed);
      showToast('GitHub allowed logins saved');
    } catch (e) {
      showToast((e as Error).message, 'danger');
    }
  }

  async function saveCacheTtl() {
    try {
      await setSetting('cache.responses.ttl_days', cacheTtl);
      showToast('Cache TTL saved');
    } catch (e) {
      showToast((e as Error).message, 'danger');
    }
  }

  async function clearCache() {
    try {
      await setSetting('cache.flush', String(Date.now()));
      showToast('Cache cleared');
    } catch (e) {
      showToast((e as Error).message, 'danger');
    }
  }

  async function handleRevokeCredential(id: string) {
    try {
      await revokeCredential(id);
      setCredentials(prev => prev.filter(c => c.id !== id));
      showToast('Device removed');
    } catch (e) {
      showToast((e as Error).message, 'danger');
    }
  }

  async function handleAddPrompt() {
    if (!newPromptLabel.trim() || !newPromptContent.trim()) return;
    try {
      const p = await createPrompt(newPromptLabel.trim(), newPromptContent.trim());
      setPrompts(prev => [...prev, p]);
      setNewPromptLabel('');
      setNewPromptContent('');
      showToast('Prompt created');
    } catch (e) {
      showToast((e as Error).message, 'danger');
    }
  }

  async function handleExcludePaidChange(next: boolean) {
    if (savingPaidPolicy) return;
    const previous = excludePaid;
    setSavingPaidPolicy(true);
    setExcludePaid(next);
    try {
      await setSetting('models.exclude_paid', next ? '1' : '0');
      setModels(await listModels().catch(() => next ? models.filter((m) => m.paid_required !== true) : models));
      showToast(next ? 'Paid models excluded' : 'Paid models included');
    } catch (e) {
      setExcludePaid(previous);
      showToast((e as Error).message, 'danger');
    } finally {
      setSavingPaidPolicy(false);
    }
  }

  async function handleSyncModels() {
    setSyncingModels(true);
    try {
      const r = await syncModels();
      const fresh = await listModels().catch(() => []);
      setModels(fresh);
      showToast(`Synced ${r.synced} models`);
    } catch (e) {
      showToast((e as Error).message, 'danger');
    } finally {
      setSyncingModels(false);
    }
  }

  async function handleDeletePrompt(id: string) {
    try {
      await deletePrompt(id);
      setPrompts(prev => prev.filter(p => p.id !== id));
      showToast('Prompt deleted');
    } catch (e) {
      showToast((e as Error).message, 'danger');
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  const tabItems: TabItem[] = [
    {
      value: 'account',
      label: 'Account',
      content: (
        <Card variant="default" className="p-6 space-y-4 mt-4">
          <div className="space-y-1">
            <p className="text-sm text-[var(--color-muted)]">Email</p>
            <p className="text-sm font-medium text-[var(--color-text)]">{user?.email ?? '—'}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-[var(--color-muted)]">Role</p>
            <Badge variant={user?.role === 'owner' ? 'warn' : 'neutral'}>
              {user?.role === 'owner' ? 'Owner' : 'User'}
            </Badge>
          </div>
          <Button variant="outline" size="sm" onClick={handleLogout}>
            Sign out
          </Button>
        </Card>
      ),
    },
    {
      value: 'devices',
      label: 'Devices',
      content: (
        <div className="space-y-4 mt-4">
          <Card variant="default" className="p-4 space-y-3">
            <p className="text-sm font-medium text-[var(--color-text)]">Passkeys</p>
            {credentials.length === 0 && (
              <p className="text-sm text-[var(--color-muted)]">No passkeys registered.</p>
            )}
            {credentials.map(c => (
              <div key={c.id} className="flex items-center justify-between py-1 border-b border-[var(--color-border)]">
                <div>
                  <p className="text-sm text-[var(--color-text)]">{c.name || 'Unnamed device'}</p>
                  <p className="text-xs text-[var(--color-muted)]">Added {new Date(c.created_at).toLocaleDateString()}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRevokeCredential(c.id)}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </Card>
          <Card variant="outlined" className="p-4 space-y-3">
            <p className="text-sm font-medium text-[var(--color-text)]">Add new device</p>
            <PasskeyButton mode="register" onSuccess={() => showToast('Device registered')} />
          </Card>
        </div>
      ),
    },
    {
      value: 'auth',
      label: 'Auth',
      content: (
        <Card variant="default" className="p-6 space-y-4 mt-4">
          <p className="text-sm font-medium text-[var(--color-text)]">GitHub — Allowed Logins</p>
          <p className="text-xs text-[var(--color-muted)]">
            Comma-separated GitHub usernames permitted to sign in.
            Leave blank to deny all (except first-user owner bootstrap).
          </p>
          <Input
            label="Allowed Logins (comma-separated)"
            id="sett-gh-allowed"
            fullWidth
            value={ghAllowed}
            onChange={e => setGhAllowed(e.target.value)}
            placeholder="alice,bob"
          />
          <Button variant="primary" size="sm" onClick={saveGhAllowedLogins}>
            Save
          </Button>
        </Card>
      ),
    },
    {
      value: 'models',
      label: 'Models',
      content: (
        <div className="space-y-6 mt-4">
          <Card variant="default" className="p-6 space-y-3">
            <Checkbox
              id="models-exclude-paid"
              label="Exclude paid"
              checked={excludePaid}
              disabled={user?.role !== 'owner' || savingPaidPolicy || settingsError !== null}
              onCheckedChange={handleExcludePaidChange}
            />
            <p className="text-xs text-[var(--color-muted)]">
              Hide and block models known to require paid billing. Enabled by default for this workspace; only the owner can change it. Unknown billing is labeled in the picker. This is not a spending cap on your Cloudflare account.
            </p>
            {settingsError && <p role="alert" className="text-xs text-[var(--color-danger)]">Settings could not be loaded. Reload to retry.</p>}
          </Card>

          <Card variant="default" className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-[var(--color-text)]">Workers AI Models</p>
                <p className="text-xs text-[var(--color-muted)] mt-1">{models.length} models available</p>
              </div>
              <Button variant="outline" size="sm" loading={syncingModels} onClick={handleSyncModels}>
                Sync now
              </Button>
            </div>
            {models.length > 0 && (
              <div className="max-h-64 overflow-y-auto space-y-1">
                {models.map(m => (
                  <div key={m.name} className="flex items-center justify-between py-1 border-b border-[var(--color-border)]">
                    <span className="text-xs font-mono text-[var(--color-text)] truncate flex-1 mr-2">{m.paid_required ? '💲 ' : ''}{m.name}</span>
                    <Badge variant="muted" size="sm">{m.task}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      ),
    },
    {
      value: 'cache',
      label: 'Cache',
      content: (
        <div className="space-y-6 mt-4">
          <Card variant="default" className="p-6 space-y-4">
            <p className="text-sm font-medium text-[var(--color-text)]">Response Cache</p>
            <Input
              label="TTL (days)"
              id="cache-ttl"
              type="number"
              value={cacheTtl}
              onChange={e => setCacheTtl(e.target.value)}
            />
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={saveCacheTtl}>
                Save TTL
              </Button>
              <Button variant="outline" size="sm" onClick={clearCache}>
                Clear cache
              </Button>
            </div>
          </Card>

          <Card variant="default" className="p-6 space-y-4">
            <p className="text-sm font-medium text-[var(--color-text)]">Prompt Templates</p>
            {prompts.map(p => (
              <div key={p.id} className="flex items-center justify-between py-1 border-b border-[var(--color-border)]">
                <span className="text-sm text-[var(--color-text)]">{p.label}</span>
                <Button variant="ghost" size="sm" onClick={() => handleDeletePrompt(p.id)}>
                  Delete
                </Button>
              </div>
            ))}
            <Input
              label="Label"
              id="new-prompt-label"
              fullWidth
              value={newPromptLabel}
              onChange={e => setNewPromptLabel(e.target.value)}
              placeholder="My prompt"
            />
            <Input
              label="Content"
              id="new-prompt-content"
              fullWidth
              value={newPromptContent}
              onChange={e => setNewPromptContent(e.target.value)}
              placeholder="You are a helpful assistant..."
            />
            <Button
              variant="primary"
              size="sm"
              disabled={!newPromptLabel.trim() || !newPromptContent.trim()}
              onClick={handleAddPrompt}
            >
              Add prompt
            </Button>
          </Card>
        </div>
      ),
    },
  ];

  if (user?.role === 'owner') {
    tabItems.push({
      value: 'invites',
      label: 'Invites',
      testid: 'settings-invites-tab',
      content: (
        <div className="mt-4">
          <InvitesTab />
        </div>
      ),
    });
  }

  return (
    <ToastProvider>
      <div data-testid="settings-page" className="max-w-2xl">
        <Tabs items={tabItems} />
      </div>

      <Toast
        open={toast.open}
        onOpenChange={o => setToast(t => ({ ...t, open: o }))}
        title={toast.title}
        variant={toast.variant}
      />
    </ToastProvider>
  );
}

export function SettingsPage() {
  return (
    <HydratedIsland>
      <SettingsPageInner />
    </HydratedIsland>
  );
}
