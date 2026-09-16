import { useState } from 'react';
import { githubBootstrapStart } from '../../lib/api';
import { Button } from '../primitives/Button';
import { Icon } from '../primitives/Icon';

export interface GithubWebLoginProps {
  mode: 'register' | 'auth' | 'register-invite';
  flow: 'bootstrap' | 'oauth';
}

export function GithubWebLogin({ mode, flow }: GithubWebLoginProps) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function start() {
    setError('');
    setBusy(true);
    try {
      if (flow === 'bootstrap') {
        const { action, manifest } = await githubBootstrapStart();
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = action;
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'manifest';
        input.value = manifest;
        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
        return;
      }

      const purpose = mode === 'register-invite' ? 'invite' : 'login';
      window.location.assign(`/auth/github/oauth/start?purpose=${purpose}`);
    } catch (e) {
      setError((e as Error).message || 'Failed to start GitHub sign-in.');
      setBusy(false);
    }
  }

  const label = mode === 'register'
    ? 'Set up with GitHub'
    : mode === 'register-invite'
      ? 'Sign up with GitHub'
      : 'Sign in with GitHub';

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      <Button
        variant="outline"
        className="vf-auth-action w-full"
        leftIcon={<Icon name="Github" size="sm" />}
        onClick={start}
        disabled={busy}
      >
        {busy ? 'Opening GitHub…' : label}
      </Button>
    </div>
  );
}
