import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowClockwise, ArrowUpRight, Check, DownloadSimple, Eye, FileText, MagnifyingGlass, PencilSimple, WarningCircle, X } from '@phosphor-icons/react';
import type { LibraryDocument } from '../shared/library';
import type { Workspace } from '../shared/types';
import { api, apiBlob } from './api';
import { EmptyState } from './ui';
import './documents.css';

const typeLabel = (kind: LibraryDocument['kind']) => kind === 'resume' ? 'Résumé' : 'Cover letter';
const displayName = (document: LibraryDocument) => document.label || document.name;
const detectedTime = (value: string, withYear = false) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(withYear ? { year: 'numeric' as const } : {}) }) : 'Not provided'; };
const fileSize = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
const filePath = (document: LibraryDocument) => {
  const source = document.usages.find(usage => usage.stored);
  return source ? `/applications/${encodeURIComponent(source.applicationId)}/documents/${encodeURIComponent(source.documentId)}/file` : null;
};
const previewKind = (document: LibraryDocument) => {
  const name = document.usages.find(usage => usage.stored)?.name || document.name;
  return /\.pdf$/i.test(name) ? 'pdf' : /\.txt$/i.test(name) ? 'text' : null;
};

function DocumentDetails({ document, workspace, onUpdate, onOpenApplication }: {
  document: LibraryDocument; workspace: Workspace; onUpdate: (value: LibraryDocument) => void; onOpenApplication: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(document.label);
  const [busy, setBusy] = useState<'label' | 'preview' | 'download' | ''>('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ kind: 'pdf'; url: string } | { kind: 'text'; text: string; truncated: boolean } | null>(null);
  const lifecycle = useRef<AbortController | null>(null);
  const previewUrl = useRef<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    return () => { controller.abort(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = null; };
  }, []);
  useEffect(() => { if (!editing) setLabel(document.label); }, [document.label, editing]);
  const format = previewKind(document);
  const path = filePath(document);
  async function saveLabel(event: FormEvent) {
    event.preventDefault(); setBusy('label'); setError('');
    const signal = lifecycle.current?.signal;
    try {
      const result = await api<LibraryDocument>(`/documents/${encodeURIComponent(document.id)}?workspace=${workspace}`, { method: 'PATCH', body: JSON.stringify({ label: label.trim() }), signal });
      if (signal?.aborted) return;
      onUpdate(result); setEditing(false);
    } catch (error) { if (!signal?.aborted) setError(error instanceof Error ? error.message : 'Could not save the document label.'); }
    finally { if (!signal?.aborted) setBusy(''); }
  }
  async function openFile(action: 'preview' | 'download') {
    if (!path) return;
    const signal = lifecycle.current?.signal;
    setBusy(action); setError('');
    try {
      const blob = await apiBlob(path, { signal });
      if (signal?.aborted) return;
      if (action === 'download') {
        const source = document.usages.find(usage => usage.stored)!;
        const url = URL.createObjectURL(blob);
        const link = window.document.createElement('a'); link.href = url; link.download = source.name;
        window.document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else if (format === 'pdf') {
        if (!(await blob.slice(0, 5).text()).startsWith('%PDF-')) throw new Error('This file cannot be previewed as a PDF. You can still download the original.');
        if (signal?.aborted) return;
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' })); previewUrl.current = url;
        setPreview({ kind: 'pdf', url });
      } else if (format === 'text') {
        const text = await blob.slice(0, 250000).text();
        if (signal?.aborted) return;
        setPreview({ kind: 'text', text: text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''), truncated: blob.size > 250000 });
      }
    } catch (error) { if (!signal?.aborted) setError(error instanceof Error ? error.message : 'Could not load the saved copy.'); }
    finally { if (!signal?.aborted) setBusy(''); }
  }
  function closePreview() { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = null; setPreview(null); }

  return <section className="document-detail" aria-labelledby="document-detail-heading">
    <div className="document-detail-header"><span className="document-type-icon" aria-hidden="true"><FileText size={27} weight="light" /></span><div><p className="document-kind">{typeLabel(document.kind)}</p><h2 id="document-detail-heading" tabIndex={-1}>{displayName(document)}</h2></div></div>
    {editing ? <form className="document-label-form" onSubmit={saveLabel}><label className="field"><span>Version label</span><input autoFocus value={label} onChange={event => setLabel(event.target.value)} maxLength={120} placeholder="For example, Product design" disabled={busy === 'label'} /></label><p className="field-help">This label helps you identify the version. Original filenames stay unchanged.</p><div className="document-label-actions"><button className="button secondary small" type="button" onClick={() => { setEditing(false); setLabel(document.label); setError(''); }} disabled={busy === 'label'}>Cancel</button><button className="button primary small" disabled={busy === 'label'}>{busy === 'label' ? 'Saving…' : 'Save label'}</button></div></form> : <button className="text-button document-label-button" onClick={() => { setLabel(document.label); setEditing(true); setError(''); }} disabled={!!busy}><PencilSimple size={15} />{document.label ? 'Edit label' : 'Add a version label'}</button>}
    <dl className="document-facts"><div><dt>Original filename{document.names.length > 1 ? 's' : ''}</dt><dd>{document.names.map(name => <span key={name}>{name}</span>)}</dd></div><div><dt>File size</dt><dd>{fileSize(document.size)}</dd></div><div><dt>First detected</dt><dd>{detectedTime(document.firstDetectedAt, true)}</dd></div><div><dt>Saved copy</dt><dd className={document.stored ? 'document-saved' : 'document-missing'}>{document.stored ? <><Check size={14} />Available</> : 'Not available'}</dd></div></dl>
    {document.stored ? <><div className="document-file-actions">{format && <button className="button primary small" onClick={() => void openFile('preview')} disabled={!!busy || !!preview}><Eye size={16} />{busy === 'preview' ? 'Loading…' : 'Preview'}</button>}<button className={`button ${format ? 'secondary' : 'primary'} small`} onClick={() => void openFile('download')} disabled={!!busy}><DownloadSimple size={16} />{busy === 'download' ? 'Downloading…' : 'Download original'}</button></div>{!format && <p className="document-preview-note">Download this Word document to open it in your preferred app.</p>}</> : <p className="document-preview-note">The filename was detected, but no copy was saved. Select the file again while browser tracking is active to save a copy.</p>}
    {error && <p className="document-action-error" role="alert"><WarningCircle size={17} />{error}</p>}
    {preview && <section className="document-preview" aria-label="Document preview"><div className="document-preview-heading"><strong>Preview</strong><button className="icon-button" onClick={closePreview} aria-label="Close document preview"><X size={17} /></button></div>{preview.kind === 'pdf' ? <iframe src={`${preview.url}#view=FitH&navpanes=0`} title={`PDF preview of ${document.name}`} referrerPolicy="no-referrer" /> : <><pre tabIndex={0}>{preview.text || 'This text file is empty.'}</pre>{preview.truncated && <p className="document-preview-note">Showing the first 250 KB. Download the original to read the complete file.</p>}</>}</section>}
    <section className="document-usage" aria-label="Applications using this version"><div className="document-usage-heading"><h3>Applications</h3><span className="count-pill">{document.usages.length}</span></div><p className="document-usage-note">Where this version was detected.</p><div className="document-usage-list">{document.usages.map(usage => <button key={usage.applicationId} className="document-usage-row" onClick={() => onOpenApplication(usage.applicationId)}><span><strong>{usage.company}</strong><span>{usage.role}</span><span className="document-usage-state">{usage.submittedAt ? 'Detected at submission' : usage.current ? 'Selected' : usage.status === 'removed' ? 'Removed from form' : 'Previous selection'}</span></span><ArrowUpRight size={17} /></button>)}</div></section>
  </section>;
}

export default function Documents({ workspace, onOpenApplication, refreshKey }: { workspace: Workspace; onOpenApplication: (id: string) => void; refreshKey?: string }) {
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [loadedWorkspace, setLoadedWorkspace] = useState<Workspace | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<'all' | LibraryDocument['kind']>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const requestId = useRef(0);
  const detailContainer = useRef<HTMLDivElement>(null);
  const scope = useRef(workspace);
  scope.current = workspace;
  useEffect(() => { setDocuments([]); setSelectedId(null); setSearch(''); setKind('all'); setError(''); setLoading(true); }, [workspace]);
  useEffect(() => {
    const controller = new AbortController(); const id = ++requestId.current;
    void api<{ documents: LibraryDocument[] }>(`/documents?workspace=${workspace}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || requestId.current !== id) return;
      setDocuments(result.documents); setLoadedWorkspace(workspace); setSelectedId(current => result.documents.some(document => document.id === current) ? current : result.documents[0]?.id ?? null); setError('');
    }).catch(error => { if (!controller.signal.aborted && requestId.current === id) setError(error instanceof Error ? error.message : 'Could not load your documents.'); }).finally(() => { if (!controller.signal.aborted && requestId.current === id) setLoading(false); });
    return () => controller.abort();
  }, [workspace, refreshKey, retry]);
  const scopedDocuments = loadedWorkspace === workspace ? documents : [];
  const filtered = useMemo(() => scopedDocuments.filter(document => (kind === 'all' || document.kind === kind) && [document.label, ...document.names, ...document.usages.flatMap(usage => [usage.company, usage.role])].join(' ').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [scopedDocuments, search, kind]);
  const selected = filtered.find(document => document.id === selectedId);
  function choose(id: string) {
    setSelectedId(id);
    if (window.matchMedia('(max-width: 900px)').matches) requestAnimationFrame(() => {
      detailContainer.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
      detailContainer.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    });
  }
  return <div className="documents-page">
    {error && <div className="error-banner" role="alert"><WarningCircle size={21} /><div><strong>Could not load your documents</strong><p>{error}</p></div><button className="button secondary small" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
    {loading || (loadedWorkspace !== workspace && !error) ? <div className="documents-loading" role="status" aria-label="Loading documents"><span className="sr-only">Loading documents</span>{Array.from({ length: 4 }, (_, index) => <div className="skeleton skeleton-row" key={index} />)}</div> : !scopedDocuments.length ? !error && <EmptyState icon={<FileText size={34} weight="light" />} title="Your documents will appear here" description="Résumés and cover letters are added when you select them on a supported application page with tracking on." /> : <>
      <div className="documents-toolbar"><div className="search-field"><MagnifyingGlass size={18} /><input aria-label="Search documents" placeholder="Search files, labels or companies" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="Clear document search" onClick={() => setSearch('')}><X size={15} /></button>}</div><div className="documents-filter"><label className="sr-only" htmlFor="document-kind">Document type</label><select id="document-kind" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="all">All documents</option><option value="resume">Résumés</option><option value="cover_letter">Cover letters</option></select><button className="icon-button" aria-label="Refresh documents" onClick={() => setRetry(value => value + 1)}><ArrowClockwise size={18} /></button></div></div>
      {filtered.length ? <div className="documents-layout"><section className="document-index" aria-label="Document versions"><div className="document-index-heading"><h2>Versions</h2><span>{filtered.length}</span></div>{filtered.map(document => <button key={document.id} className={`document-index-row${selectedId === document.id ? ' selected' : ''}`} onClick={() => choose(document.id)} aria-pressed={selectedId === document.id}><span className="document-row-icon" aria-hidden="true"><FileText size={22} /></span><span className="document-row-copy"><strong>{displayName(document)}</strong><span>{typeLabel(document.kind)} <span aria-hidden="true">·</span> {fileSize(document.size)}</span><span>{document.usages.length} {document.usages.length === 1 ? 'application' : 'applications'} <span aria-hidden="true">·</span> {detectedTime(document.lastDetectedAt)}</span></span><span className={`document-copy-state${document.stored ? '' : ' unavailable'}`}>{document.stored ? <><Check size={13} />Saved</> : 'No copy'}</span></button>)}</section><div ref={detailContainer} className="document-detail-container">{selected ? <DocumentDetails key={`${workspace}:${selected.id}`} document={selected} workspace={workspace} onUpdate={document => { if (scope.current === workspace) { requestId.current++; setDocuments(values => values.map(value => value.id === document.id ? document : value)); } }} onOpenApplication={onOpenApplication} /> : <div className="document-selection-empty"><FileText size={31} weight="light" /><p>Select a version to see its details.</p></div>}</div></div> : <EmptyState icon={<MagnifyingGlass size={30} />} title="No matching documents" description="Try another filename, label or company."><button className="button secondary" onClick={() => { setSearch(''); setKind('all'); }}>Clear filters</button></EmptyState>}
    </>}
  </div>;
}
