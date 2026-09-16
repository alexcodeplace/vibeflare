import { useState, useEffect, useRef } from 'react';
import { Card } from '../primitives/Card';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { Icon } from '../primitives/Icon';
import { githubDeviceStart, githubDevicePoll, githubSetupPoll, inviteRedeemGithubStart, inviteRedeemGithubPoll } from '../../lib/api';

export interface GithubDeviceLoginProps {
  /** register = first-run owner setup; auth = returning user sign-in; register-invite = redeem invite via GitHub Device Flow */
  mode: 'register' | 'auth' | 'register-invite';
  onSuccess?: () => void;
}

type Phase = 'idle' | 'waiting' | 'error';

/**
 * GitHub Device Flow login widget.
 * Starts device auth, shows user_code, polls until confirmed or failed.
 * Works for both first-run owner registration and returning user login.
 */
export function GithubDeviceLogin({ mode, onSuccess }: GithubDeviceLoginProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [userCode, setUserCode] = useState('');
  const [verificationUri, setVerificationUri] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deviceIdRef = useRef<string>('');
  const inFlightRef = useRef<boolean>(false);
  const pollIntervalRef = useRef<number>(5000);
  const lastPollTsRef = useRef<number>(0);

  function stopPolling() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  async function pollOnce() {
    if (inFlightRef.current) return;
    if (!deviceIdRef.current) return;
    inFlightRef.current = true;
    lastPollTsRef.current = Date.now();
    try {
      const pollFn = mode === 'register-invite'
        ? inviteRedeemGithubPoll
        : mode === 'register'
          ? githubSetupPoll
          : githubDevicePoll;
      const poll = await pollFn(deviceIdRef.current);
      if (poll.status === 'ok') {
        stopPolling();
        if (onSuccess) {
          onSuccess();
        } else {
          window.location.href = '/';
        }
      } else if (poll.status === 'slow_down') {
        pollIntervalRef.current = Math.round(pollIntervalRef.current * 1.5);
        startPolling(pollIntervalRef.current);
      } else if (poll.status === 'invite_required') {
        stopPolling();
        setPhase('error');
        setErrorMsg('Your GitHub account needs an invite to access this app.');
      } else if (poll.status === 'denied' || poll.status === 'expired') {
        stopPolling();
        setPhase('error');
        setErrorMsg(poll.status === 'denied' ? 'Access denied by GitHub.' : 'Code expired. Please try again.');
      } else if (poll.status === 'already_exists') {
        stopPolling();
        setPhase('error');
        setErrorMsg('This GitHub account is already registered. Sign in instead.');
      } else if (poll.status === 'invite_consumed') {
        stopPolling();
        setPhase('error');
        setErrorMsg('This invite has already been used.');
      } else if (poll.status === 'error') {
        stopPolling();
        setPhase('error');
        setErrorMsg('Something went wrong. Please try again.');
      }
    } catch {
      stopPolling();
      setPhase('error');
      setErrorMsg('Network error while polling. Please try again.');
    } finally {
      inFlightRef.current = false;
    }
  }

  function startPolling(ms: number) {
    stopPolling();
    intervalRef.current = setInterval(pollOnce, ms);
  }

  useEffect(() => {
    // When the tab regains focus (e.g. user returns from the GitHub authorize
    // page in another tab), poll immediately instead of waiting up to a full
    // interval. GitHub's `slow_down` protection requires we still honor the
    // server-provided interval between polls, so we only fire if enough time
    // has elapsed since the last poll.
    function onFocus() {
      if (phase !== 'waiting') return;
      const sinceLast = Date.now() - lastPollTsRef.current;
      if (sinceLast >= pollIntervalRef.current - 500) {
        pollOnce();
      }
    }
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      stopPolling();
    };
  }, [phase]);

  async function handleStart() {
    setPhase('waiting');
    setErrorMsg('');
    try {
      const startFn = mode === 'register-invite' ? inviteRedeemGithubStart : githubDeviceStart;
      const data = await startFn();
      deviceIdRef.current = data.device_id;
      setUserCode(data.user_code);
      setVerificationUri(data.verification_uri);

      pollIntervalRef.current = (data.interval ?? 5) * 1000;
      startPolling(pollIntervalRef.current);
    } catch (e) {
      setPhase('error');
      setErrorMsg((e as Error).message ?? 'Failed to start GitHub login.');
    }
  }

  if (phase === 'idle' || phase === 'error') {
    return (
      <div className="space-y-3">
        {errorMsg && (
          <p className="text-sm text-[var(--color-danger)]">{errorMsg}</p>
        )}
        <Button
          variant="outline"
          className="vf-auth-action w-full"
          leftIcon={<Icon name="Github" size="sm" />}
          onClick={handleStart}
        >
          {mode === 'register' ? 'Set up with GitHub' : mode === 'register-invite' ? 'Sign up with GitHub' : 'Sign in with GitHub'}
        </Button>
      </div>
    );
  }

  // phase === 'waiting'
  return (
    <Card className="space-y-4 p-4">
      <p className="text-sm text-[var(--color-muted)]">
        Enter this code at GitHub to authorize:
      </p>
      <p className="text-2xl tracking-widest font-mono font-bold text-[var(--color-text)] text-center select-all py-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        {userCode}
      </p>
      <Button
        variant="outline"
        className="vf-auth-action w-full"
        leftIcon={<Icon name="ExternalLink" size="sm" />}
        onClick={() => window.open(verificationUri, '_blank', 'noopener')}
      >
        Open github.com/login/device
      </Button>
      <div className="flex items-center gap-2 justify-center text-sm text-[var(--color-muted)]">
        <Spinner size="sm" />
        <span>Waiting for confirmation…</span>
      </div>
    </Card>
  );
}
