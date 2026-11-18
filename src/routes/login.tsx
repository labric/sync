import { useState, useEffect, useRef } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from "@tauri-apps/plugin-opener"
import { fetch } from '@tauri-apps/plugin-http';
import { toast } from 'sonner'
import { DeviceInfo } from '@/types'
import { RefreshCw, Stethoscope } from 'lucide-react'
import { Button } from '@/components/ui/button'
import logo from '@/assets/logo.svg'
import { jwtDecode } from 'jwt-decode'
import {
  type CustomJwtPayload,
  getToken,
  setToken,
  getOrganizationId,
  setOrganizationId,
  getTokenRejection,
  clearTokenRejection,
} from '@/lib/store'
import { NetworkDiagnosticSheet } from '@/components/network-diagnostic-sheet'
import { type PairCodeResponse, keepsWatchedFolder, pollPairingBody } from '@/lib/pairing'

export const Route = createFileRoute('/login')({
  component: Login,
})

interface CodeDigitProps {
  char: string;
  isLoading?: boolean;
}

const CodeDigit = ({ char, isLoading }: CodeDigitProps) => (
  <span
    className={`inline-flex w-10 h-11 items-center justify-center border-y border-r first:border-l first:rounded-l-xl last:rounded-r-xl font-mono text-xl ${
      isLoading ? "bg-muted animate-pulse" : ""
    }`}
  >
    {!isLoading && char}
  </span>
);

const CodeDisplay = ({ code, isLoading = false }: { code?: string; isLoading?: boolean }) => {
  const displayCode = code || "000000";
  return (
    <div
      className="inline-flex items-center gap-2 cursor-copy"
      onClick={async () => {
        if (code) {
          try {
            await navigator.clipboard.writeText(code);
            toast.success("Copied to clipboard");
          } catch {
            toast.error("Failed to copy");
          }
        }
      }}
    >
      <span className="inline-flex">
        {displayCode.slice(0, 3).split("").map((char, i) => (
          <CodeDigit key={i} char={char} isLoading={isLoading} />
        ))}
      </span>
      <span className="inline-block px-1 font-mono">—</span>
      <span className="inline-flex">
        {displayCode.slice(3).split("").map((char, i) => (
          <CodeDigit key={i} char={char} isLoading={isLoading} />
        ))}
      </span>
    </div>
  );
};

function tokenOrgId(token: string): string | undefined {
  try {
    return jwtDecode<CustomJwtPayload>(token).org_id;
  } catch {
    return undefined;
  }
}

function Login() {
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const [tokenRejected, setTokenRejected] = useState(false);
  const isSigningInRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deviceInfoRef = useRef<DeviceInfo | null>(null);
  const pairingSecretRef = useRef<string | null>(null);

  const navigate = useNavigate();

  // Check if already signed in and redirect
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const token = await getToken();
        if (token && token.exp && token.exp > Date.now() / 1000) {
          navigate({ to: '/dashboard' });
          return;
        }
      } catch (error) {
        console.error('Error checking auth:', error);
      }
      
      setTokenRejected((await getTokenRejection()) !== null);
      // If not signed in, start pairing process
      await initializePairing();
    };
    checkAuth();
  }, [navigate]);

  // Global hotkey to open the network diagnostic: Cmd+Shift+D on macOS, Ctrl+Shift+D on Windows/Linux.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        setDiagnosticOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Cleanup intervals on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, []);

  const apiCall = async (endpoint: string, body: any, token?: string) => {
    return fetch(`${import.meta.env.VITE_SERVER_URL}/api/sync/${endpoint}`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` })
      },
      body: JSON.stringify(body)
    });
  };

  const initializePairing = async () => {
    setIsLoading(true);
    try {
      // Get device info
      const info = (await invoke("get_device_info")) as DeviceInfo;
      deviceInfoRef.current = info;

      // Get pair code
      await fetchPairCode(info);

      // Start polling for pairing
      startPolling(info);

      // Auto-refresh code every 14 minutes (codes expire after 15)
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
      refreshIntervalRef.current = setInterval(() => {
        if (deviceInfoRef.current) {
          fetchPairCode(deviceInfoRef.current, true);
        }
      }, 14 * 60 * 1000);

    } catch (error) {
      console.error('Failed to initialize pairing:', error);
      toast.error('Failed to initialize pairing');
      setIsLoading(false);
    }
  };

  const fetchPairCode = async (deviceInfo: DeviceInfo, isAutoRefresh = false) => {
    try {
      const requestBody: any = {
        hostname: deviceInfo.hostname,
        platform: deviceInfo.platform,
        release: deviceInfo.release,
        arch: deviceInfo.arch,
        cpus: deviceInfo.cpus,
        total_memory: deviceInfo.total_memory,
        os_type: deviceInfo.os_type,
        device_id: deviceInfo.device_id,
        device_fingerprint: deviceInfo.device_fingerprint
      };

      // Include org ID if available
      try {
        const organizationId = await getOrganizationId();
        if (organizationId) {
          requestBody.org_id = organizationId;
        }
      } catch (error) {
        // Ignore error, org ID is optional
      }

      const response = await apiCall('get-code', requestBody);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: PairCodeResponse = await response.json();

      if (data.success && data.otp_code) {
        pairingSecretRef.current = data.pairing_secret ?? null;
        setPairCode(data.otp_code);
        setFetchFailed(false);
        if (isAutoRefresh) toast.info("Pair code refreshed");
      } else {
        throw new Error('Invalid response format');
      }
    } catch (error) {
      console.error('Failed to fetch pair code:', error);
      toast.error('Failed to fetch pair code', {
        action: {
          label: 'Run diagnostic',
          onClick: () => setDiagnosticOpen(true),
        },
      });
      setFetchFailed(true);
    } finally {
      if (!isAutoRefresh) setIsLoading(false);
    }
  };

  const startPolling = (deviceInfo: DeviceInfo) => {
    // Clear any existing interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    pollIntervalRef.current = setInterval(async () => {
      try {
        const response = await apiCall(
          'poll-pairing',
          pollPairingBody(deviceInfo.device_fingerprint, pairingSecretRef.current)
        );

        if (!response.ok) return;

        const data = await response.json();
        
        if (data.success && data.paired && data.signin_token && !isSigningInRef.current) {
          // Immediately set the flag to prevent duplicate calls
          isSigningInRef.current = true;
          
          // Clear the interval
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          
          // Sign in with promise toast
          const signInPromise = signIn(data.signin_token, data.organization_id);
          toast.promise(signInPromise, {
            loading: 'Pairing to your organization...',
            success: 'Successfully paired device',
            error: 'Failed to pair device'
          });
        }
      } catch (error) {
        console.error('Error polling pairing:', error);
      }
    }, 1000);
  };

  const signIn = async (token: string, organizationId?: string) => {
    const rejection = await getTokenRejection();
    if (rejection && !keepsWatchedFolder(rejection.org_id, tokenOrgId(token))) {
      // Stopped before the new token is stored, so no queued file uploads into the new organization
      await invoke('stop_watching');
      await invoke('clear_upload_queue');
      toast.info('Paired to a different organization. Choose the folder to sync again.');
    }
    await setToken(token);
    await clearTokenRejection();
    
    if (organizationId) {
      await setOrganizationId(organizationId);
    }
    
    navigate({ to: '/dashboard' });
  };

  const handleOpenPairPage = async () => {
    try {
      await openUrl("https://platform.labric.co/pair");
    } catch (error) {
      console.error('Failed to open pairing page:', error);
      toast.error('Failed to open pairing page');
    }
  };

  return (
    <div className="flex flex-col items-center h-svh p-6 pb-3">
      <div className="flex-1 flex flex-col items-center justify-center gap-6">
        <div className="flex items-center justify-center gap-2">
          <img src={logo} alt="Labric Sync" className="w-12 h-12" />
          <h1 className="text-3xl font-semibold">Labric Sync</h1>
        </div>

        <div className="w-full max-w-sm flex flex-col items-center justify-center gap-4 mb-8">
          {tokenRejected && (
            <p className="text-sm font-medium text-center">
              This device is no longer paired. Pair it again to keep syncing.
            </p>
          )}
          <CodeDisplay code={pairCode || undefined} isLoading={isLoading} />
          <p className="text-md font-light text-muted-foreground">
            Enter this code at{" "}
            <button
              onClick={handleOpenPairPage}
              className="text-accent-foreground hover:underline cursor-pointer bg-transparent border-none p-0"
            >
              labric.co/pair
            </button>
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => initializePairing()}
          disabled={isLoading}
        >
          <RefreshCw />
          Refresh pair code
        </Button>
        {fetchFailed && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setDiagnosticOpen(true)}
          >
            <Stethoscope />
            Run network diagnostic
          </Button>
        )}
      </div>
      <NetworkDiagnosticSheet
        open={diagnosticOpen}
        onOpenChange={setDiagnosticOpen}
      />
    </div>
  );
}
