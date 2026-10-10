import { useEffect, useState } from 'react';
import { FileText, Pencil, Plus, Trash2, Variable } from 'lucide-react';
import { composerApi, type ComposerCatalog, type ComposerPrompt, type ComposerVariable } from '../composerApi';
import { btn } from './common';
import { KeyboardShortcutsSection } from './KeyboardShortcuts';
import { t } from '../i18n';

/** Settings → Shortcuts: saved #variables and /prompt templates for the composer (see ComposerShortcuts.tsx). */
export function ShortcutsTab() {
  const [cat, setCat] = useState<ComposerCatalog | null>(null);
  const [editVar, setEditVar] = useState<(ComposerVariable & { oldName?: string }) | null>(null);
  const [editPrompt, setEditPrompt] = useState<(ComposerPrompt & { oldName?: string }) | null>(null);
  const [err, setErr] = useState('');
  const load = () => composerApi.refresh().then(setCat).catch(e => setErr(String(e)));
  useEffect(() => { load(); }, []);

  const run = async (f: () => Promise<unknown>, done: () => void) => {
    setErr('');
    try { await f(); done(); load(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="space-y-6">
      <p className="text-xs text-[var(--text-muted)]">
        {t('In the message box, type')} <b>/</b> {t('at the start for commands, skills and saved prompts,')} <b>@</b> {t('to send one message to another agent, and')} <b>#</b> {t('for variables or to pull in an artifact, a library item or a web page. Built-in variables: #date, #time, #now, #weekday, #clipboard, #agent. Prompts can use them as')} {'{{date}}'}{t('; any other')} {'{{blank}}'} {t('is left for you to fill in, and Tab jumps between blanks.')}
      </p>
      {err && <div className="text-xs text-red-400">{err}</div>}

      <section>
        <div className="flex items-center gap-2 mb-2">
          <FileText className="w-4 h-4 text-[var(--accent)]" />
          <h3 className="text-sm font-semibold flex-1">{t('Saved prompts')} <span className="font-normal text-[var(--text-muted)]">{t('· /name')}</span></h3>
          <button className={btn.subtle} onClick={() => setEditPrompt({ name: '', title: '', content: '', description: '' })}><Plus className="w-3.5 h-3.5" />{t('New prompt')}</button>
        </div>
        {editPrompt && (
          <div className="p-3 mb-2 rounded-lg border border-[var(--accent)]/40 bg-[var(--bg-secondary)] space-y-2">
            <div className="flex gap-2">
              <input className={btn.input} style={{ maxWidth: 180 }} placeholder={t('name (e.g. review)')} value={editPrompt.name}
                onChange={e => setEditPrompt({ ...editPrompt, name: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })} />
              <input className={btn.input} placeholder={t('Title (shown in the menu)')} value={editPrompt.title}
                onChange={e => setEditPrompt({ ...editPrompt, title: e.target.value })} />
            </div>
            <textarea className={btn.input} rows={6} placeholder={t('Review {{what}} for bugs and security problems. Today is {{date}}.')}
              value={editPrompt.content} onChange={e => setEditPrompt({ ...editPrompt, content: e.target.value })} />
            <div className="flex justify-end gap-1.5">
              <button className={btn.subtle} onClick={() => setEditPrompt(null)}>{t('Cancel')}</button>
              <button className={btn.primary} disabled={!editPrompt.name || !editPrompt.content.trim()}
                onClick={() => run(() => composerApi.savePrompt(editPrompt), () => setEditPrompt(null))}>{t('Save')}</button>
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          {cat?.prompts.map(p => (
            <div key={p.name} className="group flex items-start gap-2 p-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
              <div className="flex-1 min-w-0">
                <div className="text-sm"><span className="font-mono text-[var(--accent-soft)]">/{p.name}</span> {p.title && <span className="text-[var(--text-secondary)]">· {t(p.title)}</span>}</div>
                <div className="text-[11px] text-[var(--text-muted)] line-clamp-2 whitespace-pre-wrap">{p.content}</div>
              </div>
              <button className={btn.icon} title={t('Edit')} onClick={() => setEditPrompt({ ...p, oldName: p.name })}><Pencil className="w-3.5 h-3.5" /></button>
              <button className={btn.icon} title={t('Delete')} onClick={() => run(() => composerApi.deletePrompt(p.name), () => {})}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          {cat && !cat.prompts.length && !editPrompt && <div className="text-xs text-[var(--text-muted)]">{t('No saved prompts yet.')}</div>}
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2 mb-2">
          <Variable className="w-4 h-4 text-[var(--accent)]" />
          <h3 className="text-sm font-semibold flex-1">{t('Variables')} <span className="font-normal text-[var(--text-muted)]">{t('· #name')}</span></h3>
          <button className={btn.subtle} onClick={() => setEditVar({ name: '', value: '', description: '' })}><Plus className="w-3.5 h-3.5" />{t('New variable')}</button>
        </div>
        {editVar && (
          <div className="p-3 mb-2 rounded-lg border border-[var(--accent)]/40 bg-[var(--bg-secondary)] space-y-2">
            <div className="flex gap-2">
              <input className={btn.input} style={{ maxWidth: 180 }} placeholder={t('name (e.g. signature)')} value={editVar.name}
                onChange={e => setEditVar({ ...editVar, name: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })} />
              <input className={btn.input} placeholder={t('Description (optional)')} value={editVar.description}
                onChange={e => setEditVar({ ...editVar, description: e.target.value })} />
            </div>
            <textarea className={btn.input} rows={3} placeholder={t('The text #name expands to')} value={editVar.value}
              onChange={e => setEditVar({ ...editVar, value: e.target.value })} />
            <div className="flex justify-end gap-1.5">
              <button className={btn.subtle} onClick={() => setEditVar(null)}>{t('Cancel')}</button>
              <button className={btn.primary} disabled={!editVar.name || !editVar.value}
                onClick={() => run(() => composerApi.saveVariable(editVar), () => setEditVar(null))}>{t('Save')}</button>
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          {cat?.variables.map(v => (
            <div key={v.name} className="group flex items-start gap-2 p-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
              <div className="flex-1 min-w-0">
                <div className="text-sm"><span className="font-mono text-[var(--accent-soft)]">#{v.name}</span> {v.description && <span className="text-[var(--text-secondary)]">· {t(v.description)}</span>}</div>
                <div className="text-[11px] text-[var(--text-muted)] line-clamp-2 whitespace-pre-wrap">{v.value}</div>
              </div>
              <button className={btn.icon} title={t('Edit')} onClick={() => setEditVar({ ...v, oldName: v.name })}><Pencil className="w-3.5 h-3.5" /></button>
              <button className={btn.icon} title={t('Delete')} onClick={() => run(() => composerApi.deleteVariable(v.name), () => {})}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          {cat && !cat.variables.length && !editVar && <div className="text-xs text-[var(--text-muted)]">{t('No saved variables yet.')}</div>}
        </div>
      </section>
      <KeyboardShortcutsSection />
    </div>
  );
}
