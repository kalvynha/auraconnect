import { useEffect, useState } from 'react';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { storage } from '../lib/firebase';
import { errorMessage } from '../lib/format';
import { Button, ErrorBanner, Loading } from './ui';

/** Inline viewer for a PDF or image in Cloud Storage. */
export function FileViewer({ storagePath, contentType, title }: { storagePath: string; contentType: string; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);
    getDownloadURL(storageRef(storage, storagePath))
      .then((u) => !cancelled && setUrl(u))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [storagePath]);

  if (error) return <ErrorBanner error={`Couldn't load document: ${error}`} />;
  if (!url) return <Loading label="Loading document…" />;
  return (
    <div className="file-viewer">
      <div className="row end">
        <Button small onClick={() => window.open(url, '_blank', 'noopener')}>Open in new tab</Button>
      </div>
      {contentType.startsWith('image/') ? (
        <div className="doc-image">
          <img src={url} alt={title} />
        </div>
      ) : (
        <object data={url} type="application/pdf" className="doc-frame" aria-label={title}>
          <iframe src={url} title={title} className="doc-frame" />
        </object>
      )}
    </div>
  );
}
