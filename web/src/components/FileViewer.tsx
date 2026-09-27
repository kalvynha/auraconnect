import { useEffect, useState } from 'react';
import { getBlob, ref as storageRef } from 'firebase/storage';
import { storage } from '../lib/firebase';
import { errorMessage } from '../lib/format';
import { Button, ErrorBanner, Loading } from './ui';

/** Largest file fetched into the browser (Storage rules cap uploads at 25 MB). */
export const MAX_VIEW_BYTES = 26 * 1024 * 1024;

/**
 * M2: fetches a Storage object with the caller's auth (`getBlob`) and returns a
 * local `blob:` URL. Unlike `getDownloadURL`, no long-lived bearer URL (which
 * anyone could open without signing in) is ever created for PHI. The object URL
 * is revoked when the component unmounts or the path changes.
 */
export function useStorageObjectUrl(storagePath: string | null): { url: string | null; blob: Blob | null; error: string | null } {
  const [state, setState] = useState<{ url: string | null; blob: Blob | null; error: string | null }>({ url: null, blob: null, error: null });
  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    setState({ url: null, blob: null, error: null });
    if (!storagePath) return;
    getBlob(storageRef(storage, storagePath), MAX_VIEW_BYTES)
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setState({ url: created, blob, error: null });
      })
      .catch((err) => !cancelled && setState({ url: null, blob: null, error: errorMessage(err) }));
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [storagePath]);
  return state;
}

/** Saves a blob under `fileName` without leaving the page. */
export function saveBlobUrl(url: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Inline viewer for a PDF or image in Cloud Storage (fetched with auth, shown via an object URL). */
export function FileViewer({ storagePath, contentType, title }: { storagePath: string; contentType: string; title: string }) {
  const { url, error } = useStorageObjectUrl(storagePath);
  const viewable = contentType.startsWith('image/') || contentType === 'application/pdf';

  if (error) return <ErrorBanner error={`Couldn't load document: ${error}`} />;
  if (!url) return <Loading label="Loading document…" />;
  return (
    <div className="file-viewer">
      <div className="row end gap-sm">
        {viewable && <Button small onClick={() => window.open(url, '_blank', 'noopener')}>Open in new tab</Button>}
        <Button small onClick={() => saveBlobUrl(url, title)}>Download</Button>
      </div>
      {contentType.startsWith('image/') ? (
        <div className="doc-image">
          <img src={url} alt={title} />
        </div>
      ) : contentType === 'application/pdf' ? (
        <object data={url} type="application/pdf" className="doc-frame" aria-label={title}>
          <iframe src={url} title={title} className="doc-frame" />
        </object>
      ) : (
        <p className="muted">This file type can't be previewed. Use Download to open it.</p>
      )}
    </div>
  );
}
