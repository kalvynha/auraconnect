import { useRef, useState } from 'react';
import { doc, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import { ref as storageRef, uploadBytes } from 'firebase/storage';
import type { DocumentCategory, Patient, PatientDocument } from '@shared/types';
import { useOrgSession } from '../../lib/session';
import { orgCol, type WithId } from '../../lib/firestore';
import { useLiveQuery } from '../../lib/hooks';
import { storage } from '../../lib/firebase';
import { CLINICAL_ROLES, DOCUMENT_CATEGORY_LABELS } from '../../lib/constants';
import { errorMessage, formatInstant } from '../../lib/format';
import { Button, Card, ErrorBanner, Field, Modal, Table } from '../../components/ui';
import { FileViewer } from '../../components/FileViewer';

const MAX_BYTES = 25 * 1024 * 1024;

/** A single safe path segment (no slashes), ≤ 120 chars. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '');
  const out = cleaned.slice(-120);
  return !out || /^\.+$/.test(out) ? 'document' : out;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function DocumentsTab({ patient }: { patient: WithId<Patient> }) {
  const s = useOrgSession();
  const canUpload = CLINICAL_ROLES.includes(s.role);
  const docs = useLiveQuery<PatientDocument>(
    query(orgCol(s.orgId, 'patients', patient.id, 'documents'), orderBy('createdAt', 'desc')),
    [s.orgId, patient.id],
  );
  const [category, setCategory] = useState<DocumentCategory>('other');
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<WithId<PatientDocument> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const isPdf = file.type === 'application/pdf';
        const isImage = file.type.startsWith('image/');
        if (!isPdf && !isImage) throw new Error(`${file.name}: only PDF or image files are allowed.`);
        if (file.size > MAX_BYTES) throw new Error(`${file.name}: file exceeds 25 MB.`);

        const docRef = doc(orgCol(s.orgId, 'patients', patient.id, 'documents'));
        const fileName = safeFileName(file.name);
        const storagePath = `orgs/${s.orgId}/patients/${patient.id}/documents/${docRef.id}/${fileName}`;
        const data = {
          name: (files.length === 1 && name.trim()) || file.name.slice(0, 200),
          category,
          fileName,
          storagePath,
          contentType: file.type,
          size: file.size,
          uploadedBy: s.user.uid,
          createdAt: serverTimestamp(),
        };
        // 1) Create the document record (exact PatientDocument shape), 2) upload the file to the matching path.
        await setDoc(docRef, data);
        await uploadBytes(storageRef(storage, storagePath), file, { contentType: file.type });
      }
      setName('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <>
      {canUpload && (
        <Card title="Upload document">
          <ErrorBanner error={error} />
          <div className="form-grid">
            <Field label="Category">
              <select value={category} onChange={(e) => setCategory(e.target.value as DocumentCategory)}>
                {(Object.keys(DOCUMENT_CATEGORY_LABELS) as DocumentCategory[]).map((c) => (
                  <option key={c} value={c}>{DOCUMENT_CATEGORY_LABELS[c]}</option>
                ))}
              </select>
            </Field>
            <Field label="Display name (optional)" hint="Defaults to the file name.">
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <div
            className="dropzone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void upload(e.dataTransfer.files);
            }}
          >
            <input ref={fileInput} type="file" accept="application/pdf,image/*" multiple hidden onChange={(e) => void upload(e.target.files)} />
            Drop a PDF or image here, or{' '}
            <Button small variant="primary" busy={uploading} onClick={() => fileInput.current?.click()}>Choose file</Button>
            <div className="muted small">PDF or image, up to 25 MB. Uploaded documents cannot be edited or deleted.</div>
          </div>
        </Card>
      )}
      <Card title="Documents">
        <ErrorBanner error={docs.error} />
        <Table
          rows={docs.data}
          rowKey={(d) => d.id}
          onRowClick={setViewing}
          empty={docs.loading ? 'Loading…' : 'No documents.'}
          columns={[
            { header: 'Name', cell: (d) => <strong>{d.name}</strong> },
            { header: 'Category', cell: (d) => DOCUMENT_CATEGORY_LABELS[d.category] ?? d.category },
            { header: 'Type', cell: (d) => <span className="muted small">{d.contentType}</span> },
            { header: 'Size', cell: (d) => formatSize(d.size) },
            { header: 'Uploaded by', cell: (d) => s.memberName(d.uploadedBy) },
            { header: 'Uploaded', cell: (d) => formatInstant(d.createdAt) },
            { header: '', className: 'actions', cell: () => <Button small>View</Button> },
          ]}
        />
      </Card>
      {viewing && (
        <Modal title={viewing.name} onClose={() => setViewing(null)} wide>
          <div className="doc-viewer">
            <FileViewer storagePath={viewing.storagePath} contentType={viewing.contentType} title={viewing.name} />
          </div>
        </Modal>
      )}
    </>
  );
}
