import { useState } from 'react';
import { Button } from '../primitives/Button';
import { Icon } from '../primitives/Icon';
import { Toast, ToastProvider } from '../primitives/Toast';

export interface PasskeyButtonEndpoints {
  /** Endpoint that returns PublicKeyCredentialCreationOptions or RequestOptions */
  options: string;
  /** HTTP method for the options endpoint (default: 'GET') */
  optionsMethod?: 'GET' | 'POST';
  /** POST — verifies the credential response */
  verify: string;
}

const DEFAULT_REGISTER_ENDPOINTS: PasskeyButtonEndpoints = {
  options: '/admin/credentials/register/options',
  optionsMethod: 'POST',
  verify: '/admin/credentials/register/verify',
};

const DEFAULT_AUTH_ENDPOINTS: PasskeyButtonEndpoints = {
  options: '/auth/passkey/start',
  optionsMethod: 'POST',
  verify: '/auth/passkey/finish',
};

const DEFAULT_REGISTER_INVITE_ENDPOINTS: PasskeyButtonEndpoints = {
  options: '/auth/invite/redeem/passkey/start',
  optionsMethod: 'POST',
  verify: '/auth/invite/redeem/passkey/finish',
};

export interface PasskeyButtonProps {
  mode: 'register' | 'auth' | 'register-invite';
  /**
   * Override the default endpoints.
   * register default: POST /admin/credentials/register/options + POST /admin/credentials/register/verify
   * auth default:     POST /auth/passkey/start                + POST /auth/passkey/finish
   * register-invite default: POST /auth/invite/redeem/passkey/start + POST /auth/invite/redeem/passkey/finish
   *
   * First-run setup should pass:
   *   { options: '/auth/setup/start', optionsMethod: 'POST', verify: '/auth/setup/finish' }
   */
  endpoints?: PasskeyButtonEndpoints;
  /**
   * Optional transform for the verify body.
   * Receives the credential response and the raw options data from the options endpoint.
   * Defaults to posting the credential response directly.
   *
   * First-run setup: (cred, opts) => ({ userId: opts.userId, response: cred })
   * register-invite default: (cred, opts) => ({ userId: opts.userId, response: cred })
   */
  buildVerifyBody?: (credential: unknown, optionsData: Record<string, unknown>) => unknown;
  /** Called with the credential response on success */
  onSuccess?: (response: unknown) => void;
  onError?: (err: Error) => void;
}

/**
 * WebAuthn register/authenticate button.
 * register mode: calls options endpoint → startRegistration → POST verify endpoint.
 * auth mode: calls options endpoint → startAuthentication → POST verify endpoint.
 */
export function PasskeyButton({ mode, endpoints, buildVerifyBody, onSuccess, onError }: PasskeyButtonProps) {
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ open: boolean; title: string; variant: 'success' | 'danger' }>({
    open: false,
    title: '',
    variant: 'success',
  });

  function showToast(title: string, variant: 'success' | 'danger') {
    setToast({ open: true, title, variant });
  }

  async function handleClick() {
    setLoading(true);
    try {
      if (mode === 'register' || mode === 'register-invite') {
        const ep = endpoints ?? (mode === 'register-invite' ? DEFAULT_REGISTER_INVITE_ENDPOINTS : DEFAULT_REGISTER_ENDPOINTS);
        const optionsMethod = ep.optionsMethod ?? 'GET';
        const optRes = await fetch(ep.options, { method: optionsMethod, credentials: 'same-origin' });
        if (!optRes.ok) throw new Error(`Failed to get registration options (${optRes.status})`);
        const options = await optRes.json();
        const { startRegistration } = await import('@simplewebauthn/browser');
        const regResponse = await startRegistration({ optionsJSON: options });
        const defaultBuildVerifyBody = mode === 'register-invite'
          ? (cred: unknown, opts: Record<string, unknown>) => ({ userId: opts.userId, response: cred })
          : undefined;
        const verifyBody = buildVerifyBody
          ? buildVerifyBody(regResponse, options as Record<string, unknown>)
          : defaultBuildVerifyBody
            ? defaultBuildVerifyBody(regResponse, options as Record<string, unknown>)
            : regResponse;
        const verRes = await fetch(ep.verify, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(verifyBody),
        });
        if (!verRes.ok) throw new Error('Registration verification failed');
        showToast('Passkey registered', 'success');
        onSuccess?.(regResponse);
      } else {
        const ep = endpoints ?? DEFAULT_AUTH_ENDPOINTS;
        const optionsMethod = ep.optionsMethod ?? 'GET';
        const optRes = await fetch(ep.options, { method: optionsMethod, credentials: 'same-origin' });
        if (!optRes.ok) throw new Error(`Failed to get auth options (${optRes.status})`);
        const options = await optRes.json();
        const { startAuthentication } = await import('@simplewebauthn/browser');
        const authResponse = await startAuthentication({ optionsJSON: options });
        const verifyBody = buildVerifyBody
          ? buildVerifyBody(authResponse, options as Record<string, unknown>)
          : { challengeId: (options as Record<string, unknown>).challengeId, response: authResponse };
        const verRes = await fetch(ep.verify, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(verifyBody),
        });
        if (!verRes.ok) throw new Error('Authentication failed');
        showToast('Authenticated', 'success');
        onSuccess?.(authResponse);
      }
    } catch (e) {
      const err = e as Error;
      showToast(err.message, 'danger');
      onError?.(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <ToastProvider>
      <Button
        variant="secondary"
        className="vf-auth-action"
        size="md"
        loading={loading}
        leftIcon={<Icon name="KeyRound" size="sm" />}
        onClick={handleClick}
      >
        {mode === 'register' ? 'Register passkey' : mode === 'register-invite' ? 'Sign up with passkey' : 'Sign in with passkey'}
      </Button>
      <Toast
        open={toast.open}
        onOpenChange={o => setToast(t => ({ ...t, open: o }))}
        title={toast.title}
        variant={toast.variant}
      />
    </ToastProvider>
  );
}
