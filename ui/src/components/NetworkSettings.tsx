import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Globe,
  Network,
  RotateCw,
  Server,
  Shield,
  Wifi,
  XCircle,
} from 'lucide-react';
import { api, fmtBytes, type NetworkInfo, type NetworkInterfaceInfo } from '../api';
import { toast } from './toast';
import { btn } from './common';

const H = 'text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2';
const card = 'p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]';

function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
        connected
          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
          : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
      )}
    >
      {connected ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {connected ? 'Connected' : 'Disconnected'}
    </span>
  );
}

function SignalIndicator({ dbm }: { dbm: number }) {
  const bars = dbm >= -55 ? 4 : dbm >= -67 ? 3 : dbm >= -80 ? 2 : 1;
  return (
    <div className="flex items-center gap-1.5" title={`${dbm} dBm`}>
      <div className="flex items-end gap-0.5 h-3">
        {[1, 2, 3, 4].map((bar) => (
          <div
            key={bar}
            className={clsx(
              'w-0.5 rounded-full transition-all',
              bar <= bars ? 'bg-emerald-400' : 'bg-[var(--bg-tertiary)]'
            )}
            style={{ height: `${bar * 25}%` }}
          />
        ))}
      </div>
      <span className="text-[11px] font-mono text-[var(--text-muted)]">{dbm} dBm</span>
    </div>
  );
}

function NetworkRow({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  if (!value || (Array.isArray(value) && value.length === 0)) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs py-1 border-b border-[var(--border-subtle)] last:border-0">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className={clsx('text-right truncate text-[var(--text-primary)]', mono && 'font-mono')}>
        {Array.isArray(value) ? value.join(', ') : value}
      </span>
    </div>
  );
}

function SectionCard({
  title,
  icon,
  count,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className={clsx(H, 'flex items-center gap-1.5 mb-0')}>
          {icon}
          {title}
        </h3>
        {count !== undefined && (
          <span className="text-[11px] font-mono text-[var(--text-muted)]">
            {count} {count === 1 ? 'interface' : 'interfaces'}
          </span>
        )}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

export function NetworkSettings() {
  const [data, setData] = useState<NetworkInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchNetwork = async () => {
    try {
      const info = await api.network();
      setData(info);
      setError('');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchNetwork();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchNetwork, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  if (!data && loading) {
    return <div className="text-xs text-[var(--text-muted)] py-4">Scanning network interfaces…</div>;
  }

  return (
    <div className="space-y-6">
      <PreviewHostRow />
      {/* Top action / summary bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--border-subtle)]">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Network Interfaces</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Real-time status for Wi-Fi, Ethernet, and active VPN tunnels.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-[var(--text-muted)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded bg-[var(--bg-tertiary)] border-[var(--border-subtle)] text-[var(--accent)]"
            />
            Auto-refresh (5s)
          </label>
          <button
            onClick={() => {
              setLoading(true);
              fetchNetwork();
            }}
            disabled={loading}
            className={clsx(btn.subtle, 'text-xs flex items-center gap-1.5')}
          >
            <RotateCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-500/20 bg-red-500/10 text-red-400 text-xs">
          Failed to load network status: {error}
        </div>
      )}

      {/* Gateway & DNS Summary Bar */}
      {data && (data.defaultGateway || data.dns.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className={card}>
            <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] block mb-1">
              Default Gateway
            </span>
            <div className="text-xs font-mono text-[var(--text-primary)]">
              {data.defaultGateway
                ? `${data.defaultGateway.gateway} via ${data.defaultGateway.interface}`
                : 'No default route'}
            </div>
          </div>
          <div className={card}>
            <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] block mb-1">
              DNS Resolvers
            </span>
            <div className="text-xs font-mono text-[var(--text-primary)] truncate" title={data.dns.join(', ')}>
              {data.dns.length > 0 ? data.dns.join(', ') : 'Default system DNS'}
            </div>
          </div>
        </div>
      )}

      {/* 1. Wi-Fi Section */}
      <SectionCard title="Wi-Fi" icon={<Wifi className="w-3.5 h-3.5" />} count={data?.wifi?.length ?? 0}>
        {!data?.wifi?.length ? (
          <div className={clsx(card, 'text-xs text-[var(--text-muted)] italic')}>No wireless interfaces detected.</div>
        ) : (
          data.wifi.map((w: NetworkInterfaceInfo) => (
            <div key={w.interface} className={card}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                    {w.ssid || w.interface}
                  </span>
                  {w.ssid && (
                    <span className="text-[11px] font-mono text-[var(--text-muted)]">({w.interface})</span>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {w.signalDbm !== undefined && <SignalIndicator dbm={w.signalDbm} />}
                  <StatusBadge connected={w.connected} />
                </div>
              </div>
              <div className="pt-1 space-y-0.5">
                <NetworkRow label="IPv4" value={w.ipv4} mono />
                <NetworkRow label="IPv6" value={w.ipv6} mono />
                <NetworkRow label="MAC Address" value={w.mac} mono />
                {w.frequency && <NetworkRow label="Frequency" value={w.frequency} />}
                <NetworkRow
                  label="Traffic"
                  value={
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-flex items-center gap-0.5">
                        <ArrowDown className="w-3 h-3 text-emerald-400" />
                        {fmtBytes(w.rxBytes)}
                      </span>
                      <span className="inline-flex items-center gap-0.5">
                        <ArrowUp className="w-3 h-3 text-sky-400" />
                        {fmtBytes(w.txBytes)}
                      </span>
                    </span>
                  }
                />
              </div>
            </div>
          ))
        )}
      </SectionCard>

      {/* 2. Wired (Ethernet) Section */}
      <SectionCard title="Wired (Ethernet)" icon={<Network className="w-3.5 h-3.5" />} count={data?.wired?.length ?? 0}>
        {!data?.wired?.length ? (
          <div className={clsx(card, 'text-xs text-[var(--text-muted)] italic')}>No wired interfaces detected.</div>
        ) : (
          data.wired.map((eth: NetworkInterfaceInfo) => (
            <div key={eth.interface} className={card}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-mono font-medium text-[var(--text-primary)] truncate">
                    {eth.interface}
                  </span>
                  {eth.speed && (
                    <span className="text-[11px] px-1.5 py-0.2 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                      {eth.speed}
                    </span>
                  )}
                </div>
                <StatusBadge connected={eth.connected} />
              </div>
              <div className="pt-1 space-y-0.5">
                <NetworkRow label="IPv4" value={eth.ipv4} mono />
                <NetworkRow label="IPv6" value={eth.ipv6} mono />
                <NetworkRow label="MAC Address" value={eth.mac} mono />
                {eth.duplex && <NetworkRow label="Duplex" value={eth.duplex} />}
                <NetworkRow
                  label="Traffic"
                  value={
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-flex items-center gap-0.5">
                        <ArrowDown className="w-3 h-3 text-emerald-400" />
                        {fmtBytes(eth.rxBytes)}
                      </span>
                      <span className="inline-flex items-center gap-0.5">
                        <ArrowUp className="w-3 h-3 text-sky-400" />
                        {fmtBytes(eth.txBytes)}
                      </span>
                    </span>
                  }
                />
              </div>
            </div>
          ))
        )}
      </SectionCard>

      {/* 3. VPN & Tunnels Section */}
      <SectionCard title="VPN & Tunnels" icon={<Shield className="w-3.5 h-3.5" />} count={data?.vpn?.length ?? 0}>
        {/* Tailscale info card if active */}
        {data?.tailscale && (
          <div className={clsx(card, 'mb-2')}>
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2">
                <Globe className="w-3.5 h-3.5 text-indigo-400" />
                <span className="text-xs font-medium text-[var(--text-primary)]">Tailscale</span>
                <span className="text-[11px] text-[var(--text-muted)]">v{data.tailscale.version}</span>
              </div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                {data.tailscale.backendState}
              </span>
            </div>
            <div className="pt-1 space-y-0.5">
              <NetworkRow label="MagicDNS" value={data.tailscale.dnsName} mono />
              <NetworkRow label="Tailscale IPs" value={data.tailscale.ips} mono />
              <NetworkRow label="Host Name" value={data.tailscale.hostName} />
            </div>
          </div>
        )}

        {!data?.vpn?.length && !data?.tailscale ? (
          <div className={clsx(card, 'text-xs text-[var(--text-muted)] italic')}>No active VPNs or tunnel interfaces.</div>
        ) : (
          data?.vpn?.map((v: NetworkInterfaceInfo) => (
            <div key={v.interface} className={card}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-mono font-medium text-[var(--text-primary)]">{v.interface}</span>
                  <span className="text-[11px] px-1.5 py-0.2 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                    {v.type}
                  </span>
                </div>
                <StatusBadge connected={v.connected} />
              </div>
              <div className="pt-1 space-y-0.5">
                <NetworkRow label="Virtual IP" value={v.ipv4} mono />
                <NetworkRow label="IPv6" value={v.ipv6} mono />
                <NetworkRow
                  label="Traffic"
                  value={
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-flex items-center gap-0.5">
                        <ArrowDown className="w-3 h-3 text-emerald-400" />
                        {fmtBytes(v.rxBytes)}
                      </span>
                      <span className="inline-flex items-center gap-0.5">
                        <ArrowUp className="w-3 h-3 text-sky-400" />
                        {fmtBytes(v.txBytes)}
                      </span>
                    </span>
                  }
                />
              </div>
            </div>
          ))
        )}
      </SectionCard>
    </div>
  );
}


/** Settings → Network: the domain whose `p-<project>.<domain>` names the hub edge proxies to this machine's Studio
 * previews (server/devserver.py `previewHost`). Saved with a button, not on blur: a wrong value breaks every preview. */
function PreviewHostRow() {
  const [saved, setSaved] = useState('');
  const [value, setValue] = useState('');
  useEffect(() => { api.settings().then(s => { setSaved(s.previewHost ?? ''); setValue(s.previewHost ?? ''); }).catch(() => {}); }, []);
  const clean = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  const valid = clean === '' || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean);
  const save = async () => {
    try {
      const s = await api.saveSettings({ previewHost: clean });
      setSaved(s.previewHost ?? ''); setValue(s.previewHost ?? '');
      toast(clean ? `Studio previews open on p-<project>.${clean}` : 'Studio previews use this machine\'s ports again');
    } catch (e) { toast(String(e instanceof Error ? e.message : e), { kind: 'error' }); }
  };
  return (
    <section className="rounded-xl border border-[var(--border-subtle)] p-4 space-y-2">
      <h2 className="text-sm font-semibold text-[var(--text-primary)]">Studio preview host</h2>
      <p className="text-xs text-[var(--text-muted)] max-w-[65ch]">
        A domain whose <span className="font-mono">p-&lt;project&gt;.&lt;domain&gt;</span> names are proxied to this machine (the hub's edge proxy, behind Cloudflare Access).
        Leave it empty until those names resolve and have certificates: with a wrong value, Studio previews stop opening over the tailnet.
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <input className={clsx(btn.input, 'flex-1 font-mono', !valid && 'border-red-500')} placeholder="shellb.app (empty = this machine's ports 8210–8217)"
          value={value} onChange={e => setValue(e.target.value)} aria-label="Preview host domain" />
        <button className={btn.primary} disabled={!valid || clean === saved} onClick={save}>Save</button>
      </div>
      {saved && <div className="text-[11px] text-[var(--text-muted)]">Current: <span className="font-mono">p-&lt;project&gt;.{saved}</span></div>}
    </section>
  );
}
