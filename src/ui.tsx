import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpRight, Check, Circle, X } from '@phosphor-icons/react';
import type { Application, Stage, Task } from '../shared/types';
import { STAGE_LABELS } from '../shared/types';
import { safeUrl } from './api';

function parseDisplayDate(value: string, endOfDay = false) {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${endOfDay ? '23:59:59' : '00:00:00'}` : value);
}

export function dateLabel(value: string | null | undefined, withYear = false) {
  if (!value) return 'Not provided';
  const date = parseDisplayDate(value);
  if (!Number.isFinite(date.getTime())) return 'Not provided';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' as const } : {}) });
}

export function relativeDate(value: string | null | undefined) {
  if (!value) return 'No deadline';
  const date = parseDisplayDate(value);
  if (!Number.isFinite(date.getTime())) return 'No deadline';
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const target = new Date(date); target.setHours(0, 0, 0, 0);
  const difference = Math.round((target.getTime() - day.getTime()) / 86400000);
  if (difference === 0) return 'Today';
  if (difference === 1) return 'Tomorrow';
  if (difference < 0) return `${Math.abs(difference)}d overdue`;
  if (difference < 7) return `In ${difference} days`;
  return dateLabel(value);
}

export function isOverdue(task: Task) { return !!task.dueAt && !task.completedAt && parseDisplayDate(task.dueAt, true).getTime() < Date.now(); }

export function StageBadge({ stage }: { stage: Stage }) {
  return <span className={`stage-badge stage-${stage}`}><span className="status-dot" />{STAGE_LABELS[stage]}</span>;
}

export function CompanyMark({ company, small = false }: { company: string; small?: boolean }) {
  const initials = company.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
  return <span className={`company-mark${small ? ' small' : ''}`} aria-hidden="true">{initials || 'A'}</span>;
}

export function Modal({ open, onClose, title, description, children, wide = false }: {
  open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; wide?: boolean;
}) {
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="modal-overlay" />
      <Dialog.Content className={`modal${wide ? ' modal-wide' : ''}`} {...(!description ? { 'aria-describedby': undefined } : {})}>
        <div className="modal-heading"><div><Dialog.Title>{title}</Dialog.Title>{description && <Dialog.Description>{description}</Dialog.Description>}</div>
          <Dialog.Close className="icon-button" aria-label="Close dialog"><X size={20} /></Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function TaskRow({ task, application, onToggle, onOpen, busy }: {
  task: Task; application: Application; onToggle: (task: Task) => void; onOpen?: () => void; busy?: boolean;
}) {
  const link = safeUrl(task.url);
  return <div className={`task-row${task.completedAt ? ' completed' : ''}`}>
    <button className="task-check" onClick={() => onToggle(task)} disabled={busy} aria-label={`${task.completedAt ? 'Reopen' : 'Complete'} ${task.title}`}>
      {task.completedAt ? <Check size={16} weight="bold" /> : <Circle size={21} />}
    </button>
    {onOpen ? <button className="task-copy" onClick={onOpen}><strong>{task.title}</strong><span>{application.company} <span className="middle-dot">·</span> {application.role}</span></button> : <div className="task-copy"><strong>{task.title}</strong></div>}
    <span className={`due-label${isOverdue(task) ? ' overdue' : ''}`}>{task.completedAt ? 'Completed' : relativeDate(task.dueAt)}</span>
    {link && <a className="icon-button" href={link} target="_blank" rel="noreferrer" aria-label={`Open ${task.title}`}><ArrowUpRight size={17} /></a>}
  </div>;
}

export function EmptyState({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{description}</p>{children && <div className="empty-actions">{children}</div>}</div>;
}
