import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowLeft, Download, FileText, Loader2, Plus, Save, Search, Sparkles, Trash2, Upload } from 'lucide-react';
import type { ClaudeSkill, Skill, SkillDetail } from '../types';
import { api, fmtBytes } from '../api';
import { Toggle, btn, relTime } from './common';
import { t } from '../i18n';

const TEMPLATE = `---
name: my-skill
description: What this skill does, and when an agent should use it. Agents match requests against this line.
---

# My skill

## When to use
- …

## Steps
1. …

## Rules
- …
`;

const errText = (e: unknown) => String(e).includes('admin-key-required') ? 'Unlock with the admin key first.' : String(e).replace(/^Error: \d+: /, '');

const sourceLabel = (s: string) => s === 'claude' ? 'from Claude' : s === 'upload' ? 'uploaded' : s.startsWith('agent:') ? `made by ${s.slice(6)}` : '';

export function SkillsPanel({ locked, onChanged }: { locked: boolean; onChanged: () => void }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'edit'; name?: string } | { kind: 'import' }>({ kind: 'list' });
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const load = () => api.skills().then(setSkills).catch(() => {});
  useEffect(() => { load(); }, []);

  const shown = skills.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase()));
  const done = (text: string) => { setMsg(text); load(); onChanged(); };

  if (view.kind === 'edit') return <SkillEditor name={view.name} onBack={() => { setView({ kind: 'list' }); load(); onChanged(); }} />;
  if (view.kind === 'import') return <ClaudeImport locked={locked} onBack={n => { setView({ kind: 'list' }); if (n) done(`Imported ${n} skill${n > 1 ? 's' : ''}.`); }} />;

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-muted)]">
        {t('Skills are playbooks agents load when a request matches them: a')} <code className="font-mono">SKILL.md</code> {t('with instructions, plus optional scripts and reference files. They use the same format as Claude\'s skills. Agents get every enabled skill unless you narrow it in the Agent Lab. Type')} <code className="font-mono">/skill-name</code> {t('at the start of a message to invoke one directly.')}
      </p>
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input className={clsx(btn.input, 'pl-8')} value={q} onChange={e => setQ(e.target.value)} placeholder={t('Filter {length} skills', { length: skills.length })} />
        </div>
        <button className={btn.primary} onClick={() => setView({ kind: 'edit' })}><Plus className="w-3.5 h-3.5" />{t('New skill')}</button>
        <button className={btn.subtle} onClick={() => file.current?.click()}><Upload className="w-3.5 h-3.5" />{t('Upload')}</button>
        <button className={btn.subtle} onClick={() => setView({ kind: 'import' })}><Download className="w-3.5 h-3.5" />{t('Import from Claude')}</button>
        <input ref={file} type="file" accept=".zip,.skill,.md" hidden onChange={async e => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          try { const r = await api.uploadSkill(f); done(`Added ${r.imported.join(', ')}.`); } catch (err) { setMsg(errText(err)); }
        }} />
      </div>
      {msg && <div className="text-[11px] text-[var(--text-muted)]">{msg}</div>}
      <div className="space-y-1.5">
        {shown.map(s => (
          <div key={s.name} className="flex items-start gap-3 p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
            <Sparkles className="w-4 h-4 mt-0.5 text-amber-400 shrink-0" />
            <button className="flex-1 min-w-0 text-left" onClick={() => setView({ kind: 'edit', name: s.name })}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium font-mono">{s.name}</span>
                {sourceLabel(s.source) && <span className="text-[10px] px-1.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-muted)]">{sourceLabel(s.source)}</span>}
                <span className="text-[10px] text-[var(--text-muted)]">{s.words.toLocaleString()} words{s.fileCount > 1 ? t(' · {fileCount} files', { fileCount: s.fileCount }) : ''} · {relTime(s.updatedAt)}</span>
              </div>
              <div className="text-[11px] text-[var(--text-muted)] leading-snug line-clamp-2 mt-0.5">{t(s.description)}</div>
            </button>
            <Toggle on={s.enabled} label={s.name} onChange={async v => { await api.setSkill(s.name, v); load(); onChanged(); }} />
          </div>
        ))}
        {shown.length === 0 && (
          <div className="text-center py-10 text-xs text-[var(--text-muted)]">
            <Sparkles className="w-7 h-7 mx-auto mb-2" />
            {skills.length ? t('No matches.') : t('No skills yet. Write one, upload a .zip, or import the skills you use with Claude.')}
          </div>
        )}
      </div>
    </div>
  );
}

function SkillEditor({ name, onBack }: { name?: string; onBack: () => void }) {
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [content, setContent] = useState(name ? '' : TEMPLATE);
  const [viewing, setViewing] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [folder, setFolder] = useState('');
  const upload = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!name) return;
    api.skill(name).then(s => { setSkill(s); setContent(s.content); }).catch(e => setError(errText(e)));
  }, [name]);

  const dirty = skill ? content !== skill.content : content !== TEMPLATE;
  const save = async () => {
    setSaving(true); setError('');
    try {
      if (name) { await api.saveSkill(name, content); setSkill(await api.skill(name)); }
      else { await api.createSkill(content); onBack(); }
    } catch (e) { setError(errText(e)); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button className={btn.ghost} onClick={onBack}><ArrowLeft className="w-3.5 h-3.5" />{t('Skills')}</button>
        <span className="text-sm font-semibold font-mono">{name ?? t('New skill')}</span>
        <span className="flex-1" />
        {name && (
          <button className={clsx(btn.ghost, 'hover:text-red-400')} onClick={async () => { if (confirm(t('Delete the skill {name}?', { name: name }))) { await api.deleteSkill(name); onBack(); } }}>
            <Trash2 className="w-3.5 h-3.5" />{t('Delete')}
          </button>
        )}
        <button className={btn.primary} disabled={!dirty || saving} onClick={save}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}{name ? t('Save') : t('Create')}
        </button>
      </div>
      {!name && <p className="text-[11px] text-[var(--text-muted)]">The <code className="font-mono">name</code> {t('in the front matter becomes the skill\'s id. Make the description say both what the skill does and when to use it.')}</p>}
      <textarea className={clsx(btn.input, 'font-mono text-xs leading-relaxed min-h-[360px]')} value={content} spellCheck={false}
        onChange={e => setContent(e.target.value)} aria-label="SKILL.md" />
      {error && <div className="text-xs text-red-400 whitespace-pre-wrap">{error}</div>}

      {skill && (
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] flex-1">{t('Bundled files')}</h3>
            <input className={clsx(btn.input, 'w-40 text-xs py-1')} value={folder} onChange={e => setFolder(e.target.value)} placeholder={t('folder (optional)')} />
            <button className={btn.subtle} onClick={() => upload.current?.click()}><Upload className="w-3.5 h-3.5" />{t('Add file')}</button>
            <input ref={upload} type="file" hidden multiple onChange={async e => {
              const fs = Array.from(e.target.files ?? []);
              e.target.value = '';
              try {
                let s = skill;
                for (const f of fs) s = await api.putSkillFile(skill.name, `${folder.replace(/^\/|\/$/g, '')}${folder ? '/' : ''}${f.name}`, f);
                setSkill(s);
              } catch (err) { setError(errText(err)); }
            }} />
          </div>
          <div className="rounded-lg border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
            {skill.files.filter(f => f.path !== 'SKILL.md').map(f => (
              <div key={f.path} className="group flex items-center gap-2 px-2.5 py-1.5 text-xs">
                <FileText className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                <button className="flex-1 text-left font-mono truncate hover:text-[var(--accent)]"
                  onClick={async () => setViewing(viewing?.path === f.path ? null : await api.skillFile(skill.name, f.path))}>{f.path}</button>
                <span className="text-[var(--text-muted)] font-mono">{fmtBytes(f.size)}</span>
                <button className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 opacity-0 group-hover:opacity-100" title={t('Delete file')}
                  onClick={async () => { if (confirm(t('Delete {path}?', { path: f.path }))) setSkill(await api.deleteSkillFile(skill.name, f.path)); }}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {skill.files.length <= 1 && <div className="px-2.5 py-3 text-[11px] text-[var(--text-muted)]">{t('Only SKILL.md. Scripts and references added here are readable by agents, and mounted at /skills/{name}/ in the code sandbox.', { name: skill.name })}</div>}
          </div>
          {viewing && (
            <pre className="mt-2 max-h-80 overflow-auto text-[11px] font-mono p-3 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] whitespace-pre-wrap">{viewing.content}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function ClaudeImport({ locked, onBack }: { locked: boolean; onBack: (imported?: number) => void }) {
  const [list, setList] = useState<ClaudeSkill[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (locked) return;
    api.claudeSkills().then(setList).catch(e => setError(errText(e)));
  }, [locked]);
  const groups = useMemo(() => {
    const m = new Map<string, ClaudeSkill[]>();
    for (const s of list ?? []) {
      if (!`${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase())) continue;
      const g = s.plugin && s.plugin !== s.name ? s.plugin : 'Skills';
      m.set(g, [...(m.get(g) ?? []), s]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [list, q]);
  const toggle = (n: string) => setSel(s => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button className={btn.ghost} onClick={() => onBack()}><ArrowLeft className="w-3.5 h-3.5" />{t('Skills')}</button>
        <span className="text-sm font-semibold">{t('Import skills installed for Claude')}</span>
        <span className="flex-1" />
        <button className={btn.primary} disabled={!sel.size || busy || locked} onClick={async () => {
          setBusy(true);
          try { const r = await api.importClaudeSkills([...sel]); onBack(r.imported.length); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
        }}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}{t('Import')} {sel.size || ''}</button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        {t('These skills come from')} <code className="font-mono">~/.claude</code> {t('on this machine. They were written for Claude and may mention tools Shell:B doesn\'t have; agents are told to use their own equivalents. Importing copies them, and re-importing overwrites the copy.')}
      </p>
      {locked && <div className="text-xs text-amber-400">{t('Unlock with the admin key above to see them.')}</div>}
      {error && <div className="text-xs text-red-400">{error}</div>}
      {list && (
        <>
          <input className={btn.input} value={q} onChange={e => setQ(e.target.value)} placeholder={t('Filter {length} skills', { length: list.length })} />
          {groups.map(([g, items]) => (
            <div key={g}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1.5 mt-2">{g}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {items.map(s => (
                  <label key={s.name} className={clsx('flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition',
                    sel.has(s.name) ? 'border-[var(--accent)]/50 bg-[var(--accent)]/5' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]')}>
                    <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={sel.has(s.name)} onChange={() => toggle(s.name)} />
                    <span className="min-w-0">
                      <span className="block text-xs font-mono font-medium">{s.name}{s.imported && <span className="ml-1.5 font-sans text-[10px] text-emerald-500">imported</span>}</span>
                      <span className="block text-[11px] text-[var(--text-muted)] leading-snug line-clamp-2">{t(s.description)}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
      {!list && !locked && !error && <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" />{t('Looking through ~/.claude…')}</div>}
    </div>
  );
}
