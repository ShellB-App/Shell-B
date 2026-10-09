import clsx from 'clsx';
import { FilePen, FilePlus, FileX } from 'lucide-react';
import type { ToolDisplay } from '../../types';
import { AudioCard } from '../AudioCard';
import { BoardCard } from '../Research';
import { PlanCard } from '../MegaPlans';
import { ArtifactCard, DownloadChip } from './ArtifactCard';
import { CircleDraftCard } from '../CircleCards';

export function Outputs({
  outputs,
  activeArtifact,
  onOpenArtifact,
  onOpenFile,
}: {
  outputs: ToolDisplay[];
  activeArtifact?: string;
  onOpenArtifact: (id: string, version?: number) => void;
  onOpenFile?: (path: string) => void;
}) {
  const images = outputs.flatMap(o => o.images ?? []);
  const files = [...new Map(outputs.filter(o => o.file).map(o => [o.file!.path, o.file!])).values()];
  const audio = outputs.flatMap(o => (o.audio ?? []).map(src => ({ src, info: o.audioInfo ?? { prompt: o.prompt } })));
  const downloads = [...new Map(outputs.flatMap(o => o.downloads ?? []).map(d => [d.path, d])).values()];
  const arts = outputs.map(o => o.artifact).filter(Boolean) as NonNullable<ToolDisplay['artifact']>[];
  // several board calls in one stretch → one card, showing the latest counts
  // one card per plan, showing its latest state in this reply
  const plans = [
    ...new Map(
      outputs
        .filter(o => o.plan)
        .map(o => [
          o.plan!.id,
          { ...o.plan!, finished: outputs.some(x => x.plan?.id === o.plan!.id && x.plan.finished) },
        ])
    ).values(),
  ];
  const boards = [
    ...new Map(
      outputs
        .filter(o => o.board)
        .map(o => [
          o.board!.id,
          { ...o.board!, synthesized: outputs.some(x => x.board?.id === o.board!.id && x.board.synthesized) },
        ])
    ).values(),
  ];

  const circleNotes = [...new Map(outputs.filter(o => o.circleNote).map(o => [o.circleNote!.id, o.circleNote!])).values()];

  return (
    <>
      {circleNotes.map(n => <CircleDraftCard key={n.id} note={n} />)}
      {images.length > 0 && (
        <div className={clsx('my-2 grid gap-2', images.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
          {images.map(src => (
            <a
              key={src}
              href={src}
              target="_blank"
              rel="noreferrer"
              className="block rounded-xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-secondary)] max-w-lg"
            >
              <img src={src} alt="" loading="lazy" className="w-full h-auto block" />
            </a>
          ))}
        </div>
      )}
      {audio.map(({ src, info }) => (
        <AudioCard key={src} src={src} info={info} />
      ))}
      {files.length > 0 && (
        <div className="my-1.5 flex flex-wrap gap-1.5">
          {files.map(f => {
            const Icon = f.action === 'created' ? FilePlus : f.action === 'deleted' ? FileX : FilePen;
            return (
              <button
                key={f.path}
                disabled={f.action === 'deleted' || !onOpenFile}
                onClick={() => onOpenFile?.(f.path)}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-mono bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] disabled:opacity-60 disabled:cursor-default"
              >
                <Icon
                  className={clsx(
                    'w-3 h-3',
                    f.action === 'created'
                      ? 'text-emerald-400'
                      : f.action === 'deleted'
                      ? 'text-red-400'
                      : 'text-sky-400'
                  )}
                />
                {f.path}
              </button>
            );
          })}
        </div>
      )}
      {downloads.length > 0 && (
        <div className="my-1.5 flex flex-wrap gap-1.5">
          {downloads.map(d => (
            <DownloadChip key={d.path} file={d} />
          ))}
        </div>
      )}
      {boards.map(b => (
        <BoardCard key={b.id} board={b} />
      ))}
      {plans.map(p => (
        <PlanCard key={p.id} plan={p} />
      ))}
      {arts.map(a => (
        <ArtifactCard
          key={`${a.id}-${a.version}`}
          art={a}
          active={activeArtifact === a.id}
          onOpen={() => onOpenArtifact(a.id, a.version)}
        />
      ))}
    </>
  );
}
